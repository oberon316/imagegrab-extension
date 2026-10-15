/**
 * content/collector.js —— 图片采集内核。
 *
 * 在页面上下文中遍历 DOM 与计算样式，产出纯数据的图片列表。
 * 设计约束：
 *  - 只返回字符串与数值，绝不返回 DOM 节点引用，否则页面无法被回收；
 *  - 长任务分片让出主线程，避免大页面卡死；
 *  - 单个图片地址异常不影响其它条目。
 */
(function () {
  'use strict';

  const NS = (window.__ImageGrab = window.__ImageGrab || {});
  if (NS.collector) return;
  const tools = NS.tools;

  /** 常见的懒加载属性，覆盖主流框架与各大电商的命名习惯。 */
  const LAZY_ATTRS = [
    'data-src',
    'data-original',
    'data-original-src',
    'data-lazy-src',
    'data-lazy',
    'data-lazyload',
    'data-lazy-img',
    'data-ks-lazyload',
    'data-echo',
    'data-image',
    'data-img',
    'data-url',
  ];

  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE']);

  const DEFAULT_MAX_ELEMENTS = 15000;
  const DEFAULT_MAX_ITEMS = 3000;
  const MAX_INLINE_LENGTH = 100000; // 超过约 100KB 的 data: 内联图默认不纳入
  const YIELD_EVERY = 400;

  const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

  function renderedSize(el) {
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width) || 0,
      height: Math.round(rect.height) || 0,
    };
  }

  /** 从懒加载属性里取第一个看起来像图片地址的值。 */
  function firstLazyUrl(el, base) {
    for (const attr of LAZY_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const url = tools.toAbsoluteUrl(value, base);
      if (url && tools.IMAGE_URL_RE.test(url)) return url;
    }
    for (const attr of LAZY_SRCSET_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const candidate of tools.parseSrcset(value)) {
        const url = tools.toAbsoluteUrl(candidate.url, base);
        if (url && tools.IMAGE_URL_RE.test(url)) return url;
      }
    }
    return '';
  }

  function candidatesFromSrcset(el, attr, base) {
    const value = el.getAttribute(attr);
    if (!value) return [];
    const out = [];
    for (const candidate of tools.parseSrcset(value)) {
      const url = tools.toAbsoluteUrl(candidate.url, base);
      if (url && tools.IMAGE_URL_RE.test(url)) out.push({ url, descriptor: candidate.descriptor || '' });
    }
    return out;
  }

  /**
   * 采集当前页面的图片。
   *
   * @param {object} [options]
   * @param {boolean} [options.includeInlineData] 是否纳入 data: 内联图（默认否，页面占位图太多）
   * @param {number}  [options.maxElements] 扫描背景图时最多遍历的元素数量
   * @param {number}  [options.maxItems] 结果条数上限
   * @param {(progress: {phase: string, scanned: number, total: number, found: number}) => void} [onProgress]
   */
  async function scan(options = {}, onProgress) {
    const startedAt = Date.now();
    const base = document.baseURI;
    const includeInlineData = options.includeInlineData === true;
    const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : DEFAULT_MAX_ELEMENTS;
    const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : DEFAULT_MAX_ITEMS;

    const map = new Map();
    const warnings = [];
    const stats = {
      img: 0,
      picture: 0,
      background: 0,
      poster: 0,
      meta: 0,
      inlineData: 0,
      merged: 0,
      skippedInline: 0,
      skippedScheme: 0,
      scannedElements: 0,
      truncated: false,
      elapsedMs: 0,
    };

    function report(phase, scanned, total) {
      if (typeof onProgress === 'function') {
        onProgress({ phase, scanned, total, found: map.size });
      }
    }

    function record(rawUrl, meta) {
      if (map.size >= maxItems) {
        stats.truncated = true;
        return;
      }
      const url = tools.toAbsoluteUrl(rawUrl, base);
      if (!url) return;
      if (!tools.IMAGE_URL_RE.test(url)) {
        stats.skippedScheme += 1;
        return;
      }
      if (url.startsWith('data:')) {
        if (!includeInlineData || url.length > MAX_INLINE_LENGTH) {
          stats.skippedInline += 1;
          return;
        }
        stats.inlineData += 1;
      }

      const key = tools.normalizeUrl(url);
      const prev = map.get(key);
      if (prev) {
        if (!prev.sources.includes(meta.kind)) prev.sources.push(meta.kind);
        // 真实像素尺寸优先于渲染尺寸
        if (meta.sizeSource === 'natural' && prev.sizeSource !== 'natural') {
          prev.width = meta.width || prev.width;
          prev.height = meta.height || prev.height;
          prev.sizeSource = 'natural';
        } else if (!prev.width && meta.width) {
          prev.width = meta.width;
          prev.height = meta.height;
          prev.sizeSource = meta.sizeSource || prev.sizeSource;
        }
        if (meta.loaded) prev.loaded = true;
        if (prev.loaded) prev.pending = false;
        if (!prev.alt && meta.alt) prev.alt = meta.alt;
        if (meta.candidates) {
          for (const c of meta.candidates) {
            if (!prev.candidates.some((x) => x.url === c.url)) prev.candidates.push(c);
          }
        }
        stats.merged += 1;
        return;
      }

      map.set(key, {
        id: key,
        url,
        normalizedUrl: key,
        kind: meta.kind,
        sources: [meta.kind],
        width: meta.width || 0,
        height: meta.height || 0,
        sizeSource: meta.sizeSource || 'unknown',
        alt: meta.alt || '',
        loaded: !!meta.loaded,
        pending: !!meta.pending,
        candidates: meta.candidates ? meta.candidates.slice() : [],
      });
    }

    // ---------- 1. <img> ----------
    const images = Array.from(document.images);
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const natural = { width: img.naturalWidth, height: img.naturalHeight };
      const loaded = natural.width > 0 && natural.height > 0;
      const rendered = loaded ? natural : renderedSize(img);
      const displayed = img.currentSrc || img.src || '';
      const lazy = firstLazyUrl(img, base);

      const candidates = candidatesFromSrcset(img, 'srcset', base);
      for (const attr of LAZY_SRCSET_ATTRS) {
        candidates.push(...candidatesFromSrcset(img, attr, base));
      }
      const picture = img.closest('picture');
      if (picture) {
        for (const source of picture.querySelectorAll('source[srcset]')) {
          candidates.push(...candidatesFromSrcset(source, 'srcset', base));
          stats.picture += 1;
        }
      }
      if (loaded && lazy && tools.normalizeUrl(lazy) !== tools.normalizeUrl(displayed)) {
        candidates.push({ url: lazy, descriptor: 'data-src' });
      }

      const primary = loaded ? displayed : lazy || displayed;
      const pending = !loaded && !!lazy;

      if (primary) {
        record(primary, {
          kind: 'img',
          width: rendered.width,
          height: rendered.height,
          sizeSource: loaded ? 'natural' : rendered.width ? 'rendered' : 'unknown',
          alt: img.alt || img.getAttribute('title') || '',
          loaded,
          pending,
          candidates: candidates.filter((c) => tools.normalizeUrl(c.url) !== tools.normalizeUrl(primary)),
        });
        stats.img += 1;
      }

      if (i % YIELD_EVERY === 0) {
        report('img', i, images.length);
        await yieldToMain();
      }
    }

    // ---------- 2. <video poster> ----------
    for (const video of document.querySelectorAll('video[poster]')) {
      const poster = tools.toAbsoluteUrl(video.getAttribute('poster'), base);
      if (!poster || !tools.IMAGE_URL_RE.test(poster)) continue;
      const size = renderedSize(video);
      record(poster, {
        kind: 'video-poster',
        width: size.width,
        height: size.height,
        sizeSource: 'rendered',
        loaded: true,
      });
      stats.poster += 1;
    }

    // ---------- 3. og:image 与站点图标 ----------
    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[itemprop="image"]',
      'meta[property="twitter:image"]',
    ];
    for (const el of document.querySelectorAll(metaSelectors.join(','))) {
      const content = el.getAttribute('content');
      if (!content) continue;
      record(content, { kind: 'meta-og', width: 0, height: 0, sizeSource: 'unknown', loaded: true });
      stats.meta += 1;
    }
    for (const el of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')) {
      const href = el.getAttribute('href');
      if (!href) continue;
      record(href, { kind: 'link-icon', width: 0, height: 0, sizeSource: 'unknown', loaded: true });
      stats.meta += 1;
    }

    // ---------- 4. CSS 背景图 ----------
    if (options.scanBackgrounds !== false) {
      const all = document.querySelectorAll('*');
      const total = Math.min(all.length, maxElements);
      if (all.length > total) {
        warnings.push({
          code: 'element-limit',
          message: `页面共有 ${all.length} 个元素，为控制耗时只扫描了前 ${total} 个的背景图。`,
        });
      }
      for (let i = 0; i < total; i += 1) {
        const el = all[i];
        if (SKIP_TAGS.has(el.tagName)) continue;
        stats.scannedElements += 1;
        const bg = window.getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none' || !bg.includes('url(')) continue;
        const size = renderedSize(el);
        if (size.width < 1 || size.height < 1) continue; // 没有渲染尺寸的背景图没有下载价值
        for (const match of bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
          record(match[2], {
            kind: 'background',
            width: size.width,
            height: size.height,
            sizeSource: 'rendered',
            loaded: true,
          });
          stats.background += 1;
        }
        if (i % YIELD_EVERY === 0) {
          report('background', i, total);
          await yieldToMain();
        }
      }
    }

    if (stats.truncated) {
      warnings.push({
        code: 'item-limit',
        message: `图片数量超过上限 ${maxItems} 条，已截断。建议先缩小筛选范围再采集。`,
      });
    }
    if (stats.skippedInline > 0) {
      warnings.push({
        code: 'inline-data-skipped',
        message: `跳过了 ${stats.skippedInline} 个内联占位图（data: 协议）。需要时可在图库中勾选"包含内联小图"后重新采集。`,
      });
    }

    stats.elapsedMs = Date.now() - startedAt;
    const items = Array.from(map.values());
    const pendingCount = items.filter((item) => item.pending).length;
    const site = tools.matchSite(location.href);

    return {
      items,
      stats,
      warnings,
      pendingCount,
      pageUrl: location.href,
      pageTitle: document.title || '',
      site: site.site,
      collectedAt: Date.now(),
    };
  }

  NS.collector = { scan, LAZY_ATTRS };
})();
