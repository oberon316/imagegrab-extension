/**
 * tests/collector.test.mjs —— 采集内核的逻辑测试（DOM 桩，非浏览器验证）。
 *
 *   node --test tests/
 *
 * 这里用一个最小 DOM 桩把 content/collector.js 跑起来，验证"记什么、漏什么、怎么合并"。
 * 它能挡住逻辑性错误（比如懒加载属性没读到、去重把不同尺寸合并了），
 * 但它**不是**浏览器验证：真实页面的 CSS 计算值、懒加载时序、iframe 行为
 * 都必须按 tests/README.md 的用例人工执行并记录到 TESTING.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'extension', 'content');

const PAGE_URL = 'https://item.taobao.com/item.htm?id=123456';
const BASE_URL = PAGE_URL;

/** 造一个足够用的元素桩。 */
function element(tagName, options = {}) {
  const attrs = options.attrs || {};
  const rect = options.rect || { width: 0, height: 0 };
  return {
    tagName,
    alt: options.alt || '',
    naturalWidth: options.natural ? options.natural[0] : 0,
    naturalHeight: options.natural ? options.natural[1] : 0,
    currentSrc: options.currentSrc || '',
    src: options.src || '',
    backgroundImage: options.backgroundImage || 'none',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return { width: rect.width, height: rect.height, top: 0, left: 0, right: rect.width, bottom: rect.height };
    },
    closest() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

/** 按采集内核实际使用的选择器分派。 */
function createDocument(page) {
  const images = page.images || [];
  const others = page.others || [];
  return {
    baseURI: BASE_URL,
    title: page.title || '测试商品',
    images,
    querySelectorAll(selector) {
      if (selector === '*') return images.concat(others);
      if (selector === 'video[poster]') return page.videos || [];
      if (selector.startsWith('link[rel')) return page.links || [];
      if (selector.includes('og:image') || selector.includes('itemprop="image"')) return page.metas || [];
      return [];
    },
  };
}

async function scanWith(page, options = {}) {
  // 浏览器里 getComputedStyle 挂在 window 上，采集内核按 window.getComputedStyle 调用，
  // 因此桩也必须把它放在 window 上，而不是放在全局上下文里。
  const windowObject = {
    self: {},
    top: {},
    getComputedStyle: (el) => ({ backgroundImage: el.backgroundImage || 'none' }),
  };
  const context = {
    window: windowObject,
    document: createDocument(page),
    location: { href: PAGE_URL },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
  };
  vm.createContext(context);

  for (const file of ['url-tools.js', 'collector.js']) {
    const source = readFileSync(join(CONTENT_DIR, file), 'utf8');
    new vm.Script(source, { filename: file }).runInContext(context);
  }

  const collector = context.window.__ImageGrab.collector;
  // vm 里的对象属于另一个 realm，原型与宿主不同，assert.deepEqual（严格模式）会因
  // 原型不一致而失败。用 structuredClone 把结果搬回宿主 realm，顺便保证它确实是可结构化
  // 克隆的纯数据（带函数或 DOM 节点的结果会在这里直接抛错）。
  return structuredClone(await collector.scan(options));
}

function find(items, url) {
  return items.find((item) => item.url === url);
}

test('采集 img：优先 currentSrc，记录真实像素尺寸与 alt', async () => {
  const result = await scanWith({
    images: [
      element('IMG', {
        currentSrc: 'https://img.alicdn.com/imgextra/i1/main.jpg',
        src: 'https://img.alicdn.com/imgextra/i1/main.jpg',
        natural: [800, 800],
        rect: { width: 400, height: 400 },
        alt: '主图',
      }),
    ],
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.url, 'https://img.alicdn.com/imgextra/i1/main.jpg');
  assert.equal(item.kind, 'img');
  assert.equal(item.width, 800);
  assert.equal(item.height, 800);
  assert.equal(item.sizeSource, 'natural');
  assert.equal(item.alt, '主图');
  assert.equal(item.loaded, true);
  assert.equal(item.pending, false);
});

test('同一地址被引用两次只保留一条，并合并来源', async () => {
  const url = 'https://img.alicdn.com/imgextra/i2/same.jpg';
  const background = element('DIV', { backgroundImage: `url("${url}")`, rect: { width: 300, height: 200 } });
  const result = await scanWith({
    images: [
      element('IMG', { currentSrc: url, src: url, natural: [300, 200] }),
      element('IMG', { currentSrc: url, src: url, natural: [300, 200] }),
    ],
    others: [background],
  });

  assert.equal(result.items.length, 1, '同一地址只应有 1 条');
  const item = result.items[0];
  assert.deepEqual(item.sources.slice().sort(), ['background', 'img']);
  assert.equal(result.stats.merged, 2);
});

test('同一地址但查询串不同视为两张图（CDN 用参数区分尺寸）', async () => {
  const result = await scanWith({
    images: [
      element('IMG', { currentSrc: 'https://img.alicdn.com/x.jpg?width=800', natural: [800, 800] }),
      element('IMG', { currentSrc: 'https://img.alicdn.com/x.jpg?width=1200', natural: [1200, 1200] }),
    ],
  });
  assert.equal(result.items.length, 2);
});

test('未加载的 data-src 会被采集，并标记为 pending', async () => {
  const result = await scanWith({
    images: [
      element('IMG', { attrs: { 'data-src': '//img.alicdn.com/imgextra/lazy.jpg' }, rect: { width: 200, height: 200 } }),
      element('IMG', { attrs: { 'data-original': '/imgextra/original.jpg' }, rect: { width: 200, height: 200 } }),
      element('IMG', { attrs: { 'data-ks-lazyload': 'https://img.alicdn.com/ks.jpg' }, rect: { width: 200, height: 200 } }),
    ],
  });

  assert.equal(result.items.length, 3);
  for (const item of result.items) {
    assert.equal(item.pending, true, `${item.url} 应标记为未加载`);
    assert.equal(item.loaded, false);
  }
  assert.equal(result.pendingCount, 3);
  // 协议相对地址要补全为 https
  assert.ok(find(result.items, 'https://img.alicdn.com/imgextra/lazy.jpg'));
  // 相对路径要基于 baseURI 补全
  assert.ok(find(result.items, 'https://item.taobao.com/imgextra/original.jpg'));
});

test('已加载的 img 上仍保留 data-src 作为候选', async () => {
  const result = await scanWith({
    images: [
      element('IMG', {
        currentSrc: 'https://img.alicdn.com/small.jpg',
        natural: [100, 100],
        attrs: { 'data-src': 'https://img.alicdn.com/large.jpg' },
      }),
    ],
  });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.url, 'https://img.alicdn.com/small.jpg');
  assert.equal(item.pending, false);
  assert.deepEqual(
    item.candidates.map((candidate) => candidate.url),
    ['https://img.alicdn.com/large.jpg'],
  );
});

test('srcset 候选被完整记录，且不会与主地址重复', async () => {
  const result = await scanWith({
    images: [
      element('IMG', {
        currentSrc: 'https://img.alicdn.com/mid.jpg',
        natural: [600, 600],
        attrs: { srcset: 'https://img.alicdn.com/small.jpg 400w, https://img.alicdn.com/mid.jpg 600w, https://img.alicdn.com/large.jpg 1200w' },
      }),
    ],
  });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.deepEqual(item.candidates.map((candidate) => `${candidate.url} ${candidate.descriptor}`).sort(), [
    'https://img.alicdn.com/large.jpg 1200w',
    'https://img.alicdn.com/small.jpg 400w',
  ]);
  assert.equal(item.candidates.some((candidate) => candidate.url === item.url), false);
});

test('CSS 背景图按渲染尺寸记录，多重背景逐张记录', async () => {
  const result = await scanWith({
    others: [
      element('DIV', {
        backgroundImage: 'url("https://img.alicdn.com/bg1.jpg"), url("https://img.alicdn.com/bg2.jpg")',
        rect: { width: 750, height: 420 },
      }),
      element('DIV', {
        backgroundImage: 'linear-gradient(135deg, rgba(0,0,0,.2), rgba(0,0,0,0)), url("https://img.alicdn.com/bg3.jpg")',
        rect: { width: 300, height: 300 },
      }),
      element('DIV', { backgroundImage: 'none', rect: { width: 300, height: 300 } }),
      element('SCRIPT', { backgroundImage: 'url("https://img.alicdn.com/should-be-skipped.jpg")', rect: { width: 10, height: 10 } }),
      element('DIV', { backgroundImage: 'url("https://img.alicdn.com/not-rendered.jpg")', rect: { width: 0, height: 0 } }),
    ],
  });

  const urls = result.items.map((item) => item.url).sort();
  assert.deepEqual(urls, [
    'https://img.alicdn.com/bg1.jpg',
    'https://img.alicdn.com/bg2.jpg',
    'https://img.alicdn.com/bg3.jpg',
  ]);
  const bg1 = find(result.items, 'https://img.alicdn.com/bg1.jpg');
  assert.equal(bg1.kind, 'background');
  assert.equal(bg1.sizeSource, 'rendered');
  assert.equal(bg1.width, 750);
  assert.equal(bg1.height, 420);
});

test('内联 data 图默认跳过并计入统计，开启后纳入', async () => {
  const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const page = { images: [element('IMG', { currentSrc: placeholder, src: placeholder, natural: [1, 1] })] };

  const off = await scanWith(page, { includeInlineData: false });
  assert.equal(off.items.length, 0);
  assert.equal(off.stats.skippedInline, 1);

  const on = await scanWith(page, { includeInlineData: true });
  assert.equal(on.items.length, 1);
  assert.equal(on.items[0].url, placeholder);
  assert.equal(on.stats.inlineData, 1);
});

test('非图片协议被拒绝，不会进入结果', async () => {
  const result = await scanWith({
    images: [
      element('IMG', { currentSrc: 'javascript:void(0)', src: 'javascript:void(0)' }),
      element('IMG', { currentSrc: 'file:///C:/secret.png', src: 'file:///C:/secret.png' }),
      element('IMG', { currentSrc: 'blob:https://item.taobao.com/abc', src: 'blob:https://item.taobao.com/abc' }),
      element('IMG', { currentSrc: 'https://img.alicdn.com/ok.jpg', natural: [10, 10] }),
    ],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://img.alicdn.com/ok.jpg');
  assert.equal(result.stats.skippedScheme, 3);
});

test('og:image、favicon、video poster 都被采集', async () => {
  const result = await scanWith({
    images: [],
    videos: [element('VIDEO', { attrs: { poster: 'https://img.alicdn.com/poster.jpg' }, rect: { width: 320, height: 180 } })],
    metas: [element('META', { attrs: { content: 'https://img.alicdn.com/og.jpg' } })],
    links: [element('LINK', { attrs: { href: '/favicon.ico' } })],
  });

  const kinds = new Map(result.items.map((item) => [item.url, item.kind]));
  assert.equal(kinds.get('https://img.alicdn.com/poster.jpg'), 'video-poster');
  assert.equal(kinds.get('https://img.alicdn.com/og.jpg'), 'meta-og');
  assert.equal(kinds.get('https://item.taobao.com/favicon.ico'), 'link-icon');
});

test('扫描结果不携带任何 DOM 引用，且带上页面信息', async () => {
  const result = await scanWith({
    images: [element('IMG', { currentSrc: 'https://img.alicdn.com/a.jpg', natural: [10, 10] })],
  });

  assert.equal(result.pageUrl, PAGE_URL);
  assert.equal(result.pageTitle, '测试商品');
  assert.equal(result.site, '淘宝');
  assert.equal(typeof result.collectedAt, 'number');
  assert.ok(result.stats.elapsedMs >= 0);

  for (const item of result.items) {
    for (const [key, value] of Object.entries(item)) {
      const type = typeof value;
      assert.ok(
        value === null || type === 'string' || type === 'number' || type === 'boolean' || Array.isArray(value),
        `字段 ${key} 的类型是 ${type}，可能是 DOM 引用`,
      );
    }
  }
});
