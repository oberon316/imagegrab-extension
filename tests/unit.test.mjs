/**
 * tests/unit.test.mjs —— 纯逻辑单元测试。
 *
 *   node --test tests/
 *
 * 这些用例不需要浏览器，因此可以在本机与 CI 上无条件执行。
 * 重点覆盖两类容易出错的地方：
 *   1. URL / srcset 解析的边界情况（解析错了，后面全都错）；
 *   2. 内容脚本与扩展页面两份"因为 MV3 限制而必须重复"的实现是否行为一致。
 *
 * 浏览器里的真实行为（注入浮层、转换 PNG、chrome.downloads）无法在这里验证，
 * 必须按 tests/README.md 的用例人工执行并记录到 TESTING.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toAbsoluteUrl as libToAbsoluteUrl,
  normalizeUrl as libNormalizeUrl,
  parseSrcset as libParseSrcset,
  buildPngFilename,
  guessExtension,
  formatBytes,
} from '../extension/lib/url-utils.js';
import { MSG as LIB_MSG } from '../extension/lib/messaging.js';
import { PALETTE as LIB_PALETTE } from '../extension/lib/theme.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../extension/lib/settings.js';

/**
 * vm 里创建的对象/数组属于另一个 realm，原型与本测试文件不同，
 * 直接 deepStrictEqual 会因为原型不一致而失败。统一转成本 realm 的普通值再比较。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'extension', 'content');

/** 在隔离的 vm 里加载内容脚本，模拟内容脚本的隔离世界。 */
function createContentContext() {
  const windowObject = {};
  windowObject.self = windowObject;
  windowObject.top = windowObject;
  windowObject.setInterval = () => 0;
  windowObject.clearInterval = () => {};
  windowObject.setTimeout = () => 0;
  windowObject.clearTimeout = () => {};

  const documentStub = {
    baseURI: 'https://shop.example.com/detail/item.htm?id=1',
    title: '测试详情页',
    readyState: 'complete',
    images: [],
    documentElement: { appendChild() {} },
    getElementById: () => null,
    querySelectorAll: () => [],
  };

  const context = {
    window: windowObject,
    document: documentStub,
    location: { href: 'https://example.invalid/not-a-detail-page' },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: (_message, callback) => callback && callback({ ok: true }),
        onMessage: { addListener() {} },
      },
      storage: { local: { get: async () => ({}) } },
    },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ backgroundImage: 'none' }),
  };

  vm.createContext(context);
  return context;
}

function runContentFile(context, fileName) {
  const source = readFileSync(join(CONTENT_DIR, fileName), 'utf8');
  new vm.Script(source, { filename: fileName }).runInContext(context);
}

const contentContext = createContentContext();
for (const file of ['url-tools.js', 'collector.js', 'ui.js', 'content.js']) {
  runContentFile(contentContext, file);
}
const tools = contentContext.window.__ImageGrab.tools;

// ---------------------------------------------------------------- URL 补全

test('toAbsoluteUrl 能补全相对、协议相对与带引号的地址', () => {
  const base = 'https://shop.example.com/detail/item.htm?id=1';
  const cases = [
    ['//img.alicdn.com/a.jpg', 'https://img.alicdn.com/a.jpg'],
    ['/assets/b.png', 'https://shop.example.com/assets/b.png'],
    ['assets/c.png', 'https://shop.example.com/detail/assets/c.png'],
    ['../up.png', 'https://shop.example.com/up.png'],
    ['https://other.example.com/d.png', 'https://other.example.com/d.png'],
    ['http://other.example.com/e.png', 'http://other.example.com/e.png'],
    ['url("https://other.example.com/f.png")', 'https://other.example.com/f.png'],
    ["url('https://other.example.com/g.png')", 'https://other.example.com/g.png'],
    ['  https://other.example.com/h.png  ', 'https://other.example.com/h.png'],
    ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(libToAbsoluteUrl(input, base), expected, `lib: ${input}`);
    assert.equal(tools.toAbsoluteUrl(input, base), expected, `content: ${input}`);
  }
});

test('toAbsoluteUrl 对空值与非法值返回空字符串', () => {
  for (const input of ['', '   ', 'none', null, undefined, 'url()', 'javascript:void(0)']) {
    const result = libToAbsoluteUrl(input, 'https://a.example.com/');
    assert.equal(typeof result, 'string', `${input} 应返回字符串`);
    if (input === 'javascript:void(0)') {
      // 能被 URL 解析出来，但调用方会用协议白名单再挡一层
      assert.equal(result, 'javascript:void(0)');
    } else {
      assert.equal(result, '', `${input} 应为空`);
    }
  }
});

// ---------------------------------------------------------------- 去重规范

test('normalizeUrl 去掉 hash、保留查询串', () => {
  const cases = [
    ['https://img.alicdn.com/a.jpg#x', 'https://img.alicdn.com/a.jpg'],
    ['https://img.alicdn.com/a.jpg?width=800', 'https://img.alicdn.com/a.jpg?width=800'],
    ['https://img.alicdn.com/a.jpg?width=800#y', 'https://img.alicdn.com/a.jpg?width=800'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(libNormalizeUrl(input), expected);
    assert.equal(tools.normalizeUrl(input), expected);
  }
  // 不同尺寸参数不能被合并
  assert.notEqual(libNormalizeUrl('https://a.example.com/x.jpg?w=800'), libNormalizeUrl('https://a.example.com/x.jpg?w=1200'));
});

// ---------------------------------------------------------------- srcset

test('parseSrcset 解析 1x/2x 与 w 描述符', () => {
  const cases = [
    ['a.png 1x, b.png 2x', [{ url: 'a.png', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }]],
    ['a.png 480w, b.png 800w', [{ url: 'a.png', descriptor: '480w' }, { url: 'b.png', descriptor: '800w' }]],
    ['a.png, b.png', [{ url: 'a.png', descriptor: '' }, { url: 'b.png', descriptor: '' }]],
    ['a.png', [{ url: 'a.png', descriptor: '' }]],
    ['a.png 1x,b.png 2x', [{ url: 'a.png', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }]],
    ['', []],
    [null, []],
    [
      'data:image/gif;base64,R0lGOD 1x, b.png 2x',
      [{ url: 'data:image/gif;base64,R0lGOD', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }],
    ],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(plain(libParseSrcset(input)), expected, `lib: ${input}`);
    assert.deepEqual(plain(tools.parseSrcset(input)), expected, `content: ${input}`);
  }
});

test('两份 srcset 实现在同一批输入上结果完全一致', () => {
  const samples = [
    'a.png 1x, b.png 2x',
    'a.png 480w,b.png 800w',
    '//cdn.example.com/1.jpg 1x , //cdn.example.com/2.jpg 2x',
    'a.png',
    'a.png, b.png, c.png',
  ];
  for (const sample of samples) {
    assert.deepEqual(plain(tools.parseSrcset(sample)), plain(libParseSrcset(sample)), sample);
  }
});

// ---------------------------------------------------------------- 文件名

test('下载文件名固定为 商品图_001.png 形式', () => {
  assert.equal(buildPngFilename(1, { total: 1 }), '商品图_001.png');
  assert.equal(buildPngFilename(1, { total: 12 }), '商品图_001.png');
  assert.equal(buildPngFilename(7, { total: 12 }), '商品图_007.png');
  assert.equal(buildPngFilename(12, { total: 12 }), '商品图_012.png');
  // 超过 999 张时自动加宽位数，保证按名称排序仍然正确
  assert.equal(buildPngFilename(5, { total: 1000 }), '商品图_0005.png');
  assert.equal(buildPngFilename(1000, { total: 1200 }), '商品图_1000.png');
  // 扩展名必须是 .png
  assert.match(buildPngFilename(3, { total: 3 }), /\.png$/);
});

test('guessExtension 只从路径里取扩展名', () => {
  assert.equal(guessExtension('https://a.example.com/x/y.webp?w=1'), 'webp');
  assert.equal(guessExtension('https://a.example.com/x/y'), '');
  assert.equal(guessExtension('data:image/gif;base64,AAA'), '');
});

test('formatBytes 输出人类可读单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatBytes(null), '—');
});

// ---------------------------------------------------------------- 一致性

test('内容脚本与扩展页面的消息常量完全一致', () => {
  const contentMsg = tools.MSG;
  assert.deepEqual(Object.keys(contentMsg).sort(), Object.keys(LIB_MSG).sort());
  for (const [key, value] of Object.entries(LIB_MSG)) {
    assert.equal(contentMsg[key], value, `MSG.${key} 不一致`);
  }
});

test('内容脚本与扩展页面的品牌配色完全一致', () => {
  assert.deepEqual(plain(tools.PALETTE), plain(LIB_PALETTE));
});

test('设置键与默认值自洽', () => {
  assert.equal(SETTINGS_KEY, 'ig:settings');
  assert.equal(typeof DEFAULT_SETTINGS.concurrency, 'number');
  assert.ok(DEFAULT_SETTINGS.concurrency >= 1);
  assert.ok(DEFAULT_SETTINGS.timeoutMs >= 1000);
});

// ---------------------------------------------------------------- 详情页识别

test('详情页识别规则覆盖四大平台，且不误判普通页面', () => {
  const positives = [
    ['https://item.taobao.com/item.htm?id=123456', '淘宝'],
    ['https://detail.tmall.com/item.htm?id=123456', '天猫'],
    ['https://item.jd.com/100012043978.html', '京东'],
    ['https://item.m.jd.com/product/100012043978.html', '京东'],
    ['https://mobile.yangkeduo.com/goods.html?goods_id=123', '拼多多'],
    ['https://mobile.yangkeduo.com/goods2.html?goods_id=123', '拼多多'],
    ['http://localhost:8787/fixture-merchant-detail.html', '本地素材页'],
  ];
  for (const [url, site] of positives) {
    const result = tools.matchSite(url);
    assert.equal(result.isDetail, true, `${url} 应识别为详情页`);
    assert.equal(result.site, site, `${url} 的站点标签`);
  }

  const negatives = [
    'https://www.taobao.com/',
    'https://s.taobao.com/search?q=背包',
    'https://search.jd.com/Search?keyword=背包',
    'https://www.pinduoduo.com/',
    'https://example.com/item.htm?id=1',
  ];
  for (const url of negatives) {
    assert.equal(tools.matchSite(url).isDetail, false, `${url} 不应识别为详情页`);
  }
});

// ---------------------------------------------------------------- 内容脚本装配

test('四个内容脚本按 manifest 顺序加载后注册了预期的命名空间', () => {
  const ns = contentContext.window.__ImageGrab;
  assert.ok(ns, '缺少 window.__ImageGrab');
  assert.equal(typeof ns.tools.toAbsoluteUrl, 'function');
  assert.equal(typeof ns.collector.scan, 'function');
  assert.equal(typeof ns.ui.sync, 'function');
  assert.equal(typeof ns.ui.setStatus, 'function');
  assert.equal(typeof ns.controller.requestScan, 'function');
});

test('内容脚本重复注入时不会重复注册（幂等）', () => {
  const before = contentContext.window.__ImageGrab;
  for (const file of ['url-tools.js', 'collector.js', 'ui.js', 'content.js']) {
    runContentFile(contentContext, file);
  }
  assert.equal(contentContext.window.__ImageGrab, before, '重复注入不应替换命名空间对象');
  assert.equal(contentContext.window.__ImageGrab.collector.scan, before.collector.scan);
});
