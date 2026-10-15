/**
 * content/url-tools.js —— 内容脚本侧的纯净工具集（经典脚本，不能用 import）。
 *
 * 挂载到内容脚本所在隔离世界的 window.__ImageGrab.tools 上，供
 * collector.js / ui.js / content.js 共用。
 *
 * 注意：这里的 MSG 与 PALETTE 在扩展页面侧各有一份对应实现
 * （lib/messaging.js、lib/theme.js）。内容脚本无法静态 import ES 模块，
 * 这是 Manifest V3 的硬约束。两份定义的一致性由 tests/unit.test.mjs 强制校验。
 */
(function () {
  'use strict';

  const NS = (window.__ImageGrab = window.__ImageGrab || {});
  if (NS.tools) return;

  /** 面板与后台之间的消息类型。必须与 extension/lib/messaging.js 完全一致。 */
  const MSG = Object.freeze({
    PING: 'ig:ping',
    SCAN_REQUEST: 'ig:scan-request',
    SCAN_RESULT: 'ig:scan-result',
    SCAN_ERROR: 'ig:scan-error',
    RESCAN_REQUEST: 'ig:rescan-request',
    OPEN_GALLERY: 'ig:open-gallery',
  });

  /** 品牌配色。必须与 scripts/lib/palette.mjs、extension/lib/theme.js 一致。 */
  const PALETTE = Object.freeze({
    cream: '#F7F3E9',
    teal: '#0E5C55',
    tealDeep: '#0A4640',
    caramel: '#A9682F',
    gold: '#C9A96A',
    ink: '#2B2A27',
  });

  const IMAGE_URL_RE = /^https?:|^data:image\//i;

  /**
   * 把可能是相对路径、协议相对路径的地址补全为绝对地址。
   * @param {string} raw
   * @param {string} [base]
   * @returns {string} 无法解析时返回空字符串
   */
  function toAbsoluteUrl(raw, base) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // CSS 里常见 url("...") / url('...')，调用方可能原样传进来
    s = s.replace(/^url\((.*)\)$/i, '$1').trim();
    s = s.replace(/^['"]|['"]$/g, '').trim();
    if (!s || s === 'none') return '';
    if (s.startsWith('//')) s = 'https:' + s;
    try {
      return new URL(s, base || document.baseURI).href;
    } catch {
      return '';
    }
  }

  /**
   * 去重用的规范形式：去掉 hash，保留查询串。
   *
   * 保留查询串是刻意的：淘宝/京东的 CDN 大量使用 ?width=800 这类参数来选择实际尺寸，
   * 如果一并删掉，800 和 1200 两个不同文件会被误判成同一张。
   * @param {string} url
   * @returns {string}
   */
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch {
      return url;
    }
  }

  /**
   * 解析 srcset / image-set 的候选列表。
   *
   * 采用按空白切词的写法：图片地址内部不会出现空白，因此 while 分词比正则拆分更可靠，
   * 也不会被 data: URL 里的逗号打断（逗号在词内部，只有充当分隔符时才会落在词尾）。
   * @param {string} text
   * @returns {Array<{url: string, descriptor: string}>}
   */
  function parseSrcset(text) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    let current = null;
    for (const rawToken of text.split(/\s+/)) {
      let token = rawToken.trim();
      if (!token) continue;

      // 'a.png 1x,b.png 2x' 这种逗号后没有空格的写法也是合法的，先把它拆开
      const merged = /^(\d+(?:\.\d+)?[wx]),(.+)$/i.exec(token);
      if (merged) {
        if (current) {
          current.descriptor = merged[1];
          out.push(current);
          current = null;
        }
        token = merged[2];
      } else if (/^\d+(\.\d+)?[wx],?$/i.test(token)) {
        // 描述符后面直接跟分隔逗号（"a.png 1x, b.png 2x" 分词后是 "1x,"）
        if (current) {
          current.descriptor = token.replace(/,$/, '');
          out.push(current);
          current = null;
        }
        continue;
      }

      let url = token;
      let trailingComma = false;
      if (url.endsWith(',')) {
        url = url.slice(0, -1);
        trailingComma = true;
      }
      if (current) {
        out.push(current);
        current = null;
      }
      if (url) current = { url, descriptor: '' };
      if (trailingComma && current) {
        out.push(current);
        current = null;
      }
    }
    if (current) out.push(current);
    return out;
  }

  /**
   * 商品详情页识别规则。
   * 未命中时仍然可以通过工具栏图标手动采集，按钮只是默认不显示。
   */
  const DETAIL_RULES = [
    { site: '淘宝', re: /^https?:\/\/item\.taobao\.com\/item\.htm/i },
    { site: '淘宝', re: /^https?:\/\/[^/]*\.taobao\.com\/item\/\d+/i },
    { site: '天猫', re: /^https?:\/\/detail\.tmall\.com\/item\.htm/i },
    { site: '天猫', re: /^https?:\/\/[^/]*\.tmall\.com\/item\.htm/i },
    { site: '天猫', re: /^https?:\/\/[^/]*\.tmall\.com\/detail\//i },
    { site: '京东', re: /^https?:\/\/item(\.m)?\.jd\.com\/(product\/)?\d+\.html/i },
    { site: '京东', re: /^https?:\/\/[^/]*\.jd\.com\/product\/\d+/i },
    { site: '拼多多', re: /^https?:\/\/mobile\.yangkeduo\.com\/(goods|goods2)\.html/i },
    { site: '拼多多', re: /^https?:\/\/[^/]*\.(yangkeduo|pinduoduo)\.com\/.*(goods|detail)/i },
    // 本地素材页，便于离线验证整个流程
    { site: '本地素材页', re: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^?#]*fixture[^?#]*/i },
  ];

  /**
   * @param {string} url
   * @returns {{isDetail: boolean, site: string}}
   */
  function matchSite(url) {
    const href = url || '';
    for (const rule of DETAIL_RULES) {
      if (rule.re.test(href)) return { isDetail: true, site: rule.site };
    }
    return { isDetail: false, site: '' };
  }

  NS.tools = {
    MSG,
    PALETTE,
    IMAGE_URL_RE,
    toAbsoluteUrl,
    normalizeUrl,
    parseSrcset,
    matchSite,
    DETAIL_RULES,
  };
})();
