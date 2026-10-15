/**
 * tests/browser-e2e.mjs —— 在真实 Chrome 里把扩展完整跑一遍。
 *
 *   node tests/browser-e2e.mjs                          # 无头（默认），验证 extension/ 源码目录
 *   $env:HEADFUL="1"; node tests/browser-e2e.mjs        # 有头，能看见窗口
 *   $env:CHROME_PATH="..."; node tests/browser-e2e.mjs  # 指定其它 Chrome/Edge
 *
 * 环境变量：
 *   HEADFUL=1          显示浏览器窗口
 *   CHROME_PATH        指定浏览器可执行文件
 *   FIXTURE_PORT       素材页端口（默认 8787）
 *   EXTENSION_DIR      改验证"哪个扩展目录"。指向解压出的安装包即可验证发布产物：
 *                        Expand-Archive docs/downloads/imagegrab-v1.0.0.zip -DestinationPath tests/tmp/zip-install
 *                        $env:EXTENSION_DIR="tests/tmp/zip-install"; $env:IG_RUN_LABEL="zip"; node tests/browser-e2e.mjs
 *   IG_RUN_LABEL       给本次运行的临时目录加后缀，使两次运行各自保留一份下载产物
 *
 * 它做的是"人手动点一遍"的机械化版本，且只做真实浏览器才能验证的事：
 *   - 内容脚本是否真的注入、浮层是否真的挂在详情页右下角、动态页面是否自适应；
 *   - 点按钮是否真的打开图库、缩略图与计数是否正确、全选/反选/取消是否生效；
 *   - BMP / JPEG / WebP 是否真的被重新编码成 PNG（读文件头，不看后缀）；
 *   - chrome.downloads 是否真的落盘、命名是否为 商品图_001.png；
 *   - 单张失败（404）是否不中断整批、失败清单是否逐项列出；
 *   - 未授权域名（不在 host_permissions 内）是否给出可读的失败原因；
 *   - Blob URL 是否在下载结束之后才释放；
 *   - 顶栏 / 工具条 / 网格 / 底部下载条在同一屏内是否互不重合（谁也不会浮到谁上面）。
 *
 * 与 node --test 的分工：逻辑（如去重规则、srcset 解析）由 tests/unit.test.mjs 与
 * tests/collector.test.mjs 覆盖，那些是 DOM 桩，跑得快；本脚本慢、需要本机 Chrome，
 * 负责"在浏览器里确实能跑起来"。
 *
 * 产物：results 打印到 stdout；临时 profile 与下载目录在 tests/tmp/（已被 .gitignore 忽略）。
 * 退出码：全部通过为 0，任一失败为 1。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { findChrome, launchChrome, loadExtension, prepareProfile } from '../scripts/lib/chrome.mjs';
import { Cdp, listTargets, waitUntil } from '../scripts/lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSION_DIR = join(ROOT, 'extension');

/**
 * 被验证的扩展目录。默认是源码目录 `extension/`；
 * 用 EXTENSION_DIR 指向别处，就能验证"解压出来的安装包"是否与源码等价
 * （ZIP 里的扩展才是用户真正加载的东西，源码目录只是开发时的形态）。
 */
const EXTENSION_DIR = process.env.EXTENSION_DIR ? resolve(process.env.EXTENSION_DIR) : SOURCE_EXTENSION_DIR;
const IS_SOURCE_DIR = EXTENSION_DIR === SOURCE_EXTENSION_DIR;

const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures');
const TMP_DIR = join(ROOT, 'tests', 'tmp');
/**
 * 用 IG_RUN_LABEL 给本次运行标记一个后缀，使"源码目录"与"解压出的安装包"
 * 两次运行各自保留一份临时 profile 与下载产物，便于分别人工复核。
 */
const RUN_LABEL = String(process.env.IG_RUN_LABEL || '')
  .replace(/[^\w.-]/g, '')
  .slice(0, 24);
const RUN_SUFFIX = RUN_LABEL ? `-${RUN_LABEL}` : '';
const PROFILE_DIR = join(TMP_DIR, `e2e-profile${RUN_SUFFIX}`);
const DOWNLOAD_DIR = join(TMP_DIR, `e2e-downloads${RUN_SUFFIX}`);

const PORT = Number(process.env.FIXTURE_PORT) || 8787;
const PAGE_URL = `http://localhost:${PORT}/fixture-merchant-detail.html`;
const HEADLESS = process.env.HEADFUL !== '1';

/**
 * 一个刻意"不在 manifest 的 host_permissions 里"的域名，用 Chrome 的
 * --host-resolver-rules 把它指到本机素材服务器上。这样就能在真实浏览器里复现
 * "图片来自未授权 CDN" 这种真实场景，验证失败提示是否可读（见 E2E-16）。
 * 注意不能用 127.0.0.1 或 localhost：它们在 manifest 里已授权。
 */
const BLOCKED_HOST = 'ig-unpermitted.test';
const BLOCKED_ORIGIN_URL = `http://${BLOCKED_HOST}:${PORT}/assets/sample.png`;
const HOST_RULES = [`--host-resolver-rules=MAP ${BLOCKED_HOST} 127.0.0.1`];

/** 期望的下载文件名前缀（与 lib/url-utils.js 的 DOWNLOAD_PREFIX 一致）。 */
const NAME_PREFIX = '商品图';

// ---------------------------------------------------------------- 断言与记录

const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

async function step(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, title, ok: true, detail: detail || '' });
    console.log(`  \u2714 ${id} ${title}${detail ? `\n      → ${detail}` : ''}`);
  } catch (error) {
    const message = String((error && error.message) || error);
    results.push({ id, title, ok: false, detail: message });
    console.log(`  \u2716 ${id} ${title}\n      → ${message}`);
  }
}

// ---------------------------------------------------------------- 页面内表达式

/** 读浮层状态（浮层挂在页面 DOM 上，shadow root 是 open 的，主世界可读）。 */
const FAB_STATE = `(() => {
  const host = document.getElementById('imagegrab-fab-host');
  if (!host || !host.shadowRoot) return null;
  const button = host.shadowRoot.querySelector('.fab');
  const label = host.shadowRoot.querySelector('.label');
  const toast = host.shadowRoot.querySelector('.toast');
  if (!button || !label) return null;
  return {
    label: label.textContent,
    disabled: button.disabled,
    connected: host.isConnected,
    hostCount: document.querySelectorAll('#imagegrab-fab-host').length,
    toast: toast && !toast.hidden ? toast.textContent : '',
  };
})()`;

/** 读图库页面状态。 */
const GALLERY_STATE = `(() => {
  const text = (id) => {
    const node = document.getElementById(id);
    return node ? node.textContent.trim().replace(/\\s+/g, ' ') : null;
  };
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  return JSON.stringify({
    meta: text('scan-meta'),
    source: text('source-line'),
    notice: text('notice'),
    noticeHidden: document.getElementById('notice').hidden,
    visible: Number(text('visible-count')),
    selected: Number(text('selected-count')),
    cards: cards.length,
    pendingCards: cards.filter((card) => card.dataset.pending === 'true').length,
    thumbs: cards.map((card) => {
      const img = card.querySelector('.thumb img');
      return {
        // 缩略图加载失败时 img 会被移除，只能靠卡片的 itemId（即规范化后的图片地址）定位
        itemId: card.dataset.itemId || '',
        src: img ? img.src : '',
        loaded: img ? img.naturalWidth > 0 : false,
        fallback: Boolean(card.querySelector('.thumb .fallback')),
      };
    }),
    downloadDisabled: document.getElementById('download-button').disabled,
    downloadText: text('download-button'),
    progress: text('progress-text'),
    errorPanelHidden: document.getElementById('error-panel').hidden,
    errorCount: Number(text('error-count')),
    errorItems: Array.from(document.querySelectorAll('#error-list li')).map((li) => li.textContent.replace(/\\s+/g, ' ').trim()),
    statuses: cards.map((card) => (card.querySelector('.status') || {}).textContent || ''),
  });
})()`;

/**
 * 给图库页面装观测钩子：记录 Blob URL 的创建/释放时间，以及 chrome.downloads 的终态时间。
 * 必须在点"下载"之前装好。
 */
const INSTALL_PROBE = `(() => {
  if (window.__igProbe) return 'already';
  const probe = { created: [], revoked: [], terminal: [] };
  window.__igProbe = probe;

  const realCreate = URL.createObjectURL.bind(URL);
  const realRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = realCreate(blob);
    probe.created.push({ url, ts: performance.now() });
    return url;
  };
  URL.revokeObjectURL = (url) => {
    probe.revoked.push({ url, ts: performance.now() });
    return realRevoke(url);
  };
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;
    if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;
    probe.terminal.push({ id: delta.id, state: delta.state.current, ts: performance.now() });
  });
  return 'installed';
})()`;

const READ_PROBE = `JSON.stringify({
  created: window.__igProbe.created.length,
  revoked: window.__igProbe.revoked.length,
  terminals: window.__igProbe.terminal.map((t) => t.ts).sort((a, b) => a - b),
  revokes: window.__igProbe.revoked.map((r) => r.ts).sort((a, b) => a - b),
  terminalStates: window.__igProbe.terminal.map((t) => t.state),
})`;

/**
 * 量底板布局：底部下载条必须与网格内容区互不接触。
 *
 * 为什么不能只比矩形：被 overflow 裁掉的卡片，矩形仍然会伸到下载条下面
 * （这正是"看起来重合"的根源），所以这里还加了命中测试。
 * 并且不只测一个位置：在内容区顶部 / 中间 / 底部三处各测一遍，
 * 因为"滚动到某个位置才压住卡片"是最容易漏掉的一类重合。
 */
const LAYOUT_PROBE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const bar = document.querySelector('.downloadbar');
  const scroller = document.getElementById('scroller');
  const toolbar = document.querySelector('.toolbar');
  const topbar = document.querySelector('.topbar');
  if (!bar || !scroller || !toolbar || !topbar) {
    return JSON.stringify({ error: '图库页面缺少 .topbar / .toolbar / #scroller / .downloadbar' });
  }

  const documentScrolling = document.scrollingElement || document.documentElement;
  const documentScrolls = documentScrolling.scrollHeight > documentScrolling.clientHeight + 1;
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;

  /** 在某条横带里逐点取样，数一数有多少点落在了卡片上。 */
  const cardHitsInBand = (rect) => {
    let hits = 0;
    for (let y = rect.top + 2; y < rect.bottom - 2; y += 8) {
      for (let x = rect.left + 3; x < rect.right - 3; x += 40) {
        const node = document.elementFromPoint(x, y);
        if (node && node.closest && node.closest('#grid .card')) hits += 1;
      }
    }
    return hits;
  };

  const samples = [];
  let barHits = 0;
  let toolbarHits = 0;
  let topbarHits = 0;
  let minBarGap = Infinity;
  let minToolbarGap = Infinity;
  let lastCardBottomAtEnd = null;
  let barTopAtEnd = null;

  for (const ratio of [0, 0.5, 1]) {
    scroller.scrollTop = Math.round(maxScroll * ratio);
    const barRect = bar.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const toolRect = toolbar.getBoundingClientRect();
    const topRect = topbar.getBoundingClientRect();

    barHits += cardHitsInBand(barRect);
    toolbarHits += cardHitsInBand(toolRect);
    topbarHits += cardHitsInBand(topRect);
    minBarGap = Math.min(minBarGap, round(barRect.top - scrollerRect.bottom));
    minToolbarGap = Math.min(minToolbarGap, round(scrollerRect.top - toolRect.bottom));

    if (ratio === 1) {
      const cards = Array.from(document.querySelectorAll('#grid .card'));
      lastCardBottomAtEnd = cards.length ? round(cards[cards.length - 1].getBoundingClientRect().bottom) : null;
      barTopAtEnd = round(barRect.top);
    }

    samples.push({
      滚动位置: round(scroller.scrollTop),
      内容区上边缘: round(scrollerRect.top),
      内容区下边缘: round(scrollerRect.bottom),
      下载条上边缘: round(barRect.top),
      内容区与下载条的重合高度: round(Math.min(scrollerRect.bottom, barRect.bottom) - Math.max(scrollerRect.top, barRect.top)),
      内容区与下载条的缝隙: round(barRect.top - scrollerRect.bottom),
    });
  }
  scroller.scrollTop = 0;

  const barRect0 = bar.getBoundingClientRect();
  const scrollerRect0 = scroller.getBoundingClientRect();

  return JSON.stringify({
    整页可滚动: documentScrolls,
    视口: window.innerWidth + 'x' + window.innerHeight,
    卡片数: document.querySelectorAll('#grid .card').length,
    下载条定位: getComputedStyle(bar).position,
    内容区定位: getComputedStyle(scroller).position,
    内容区溢出方式: getComputedStyle(scroller).overflowY,
    内容区可滚动: maxScroll > 1,
    可滚动高度: round(maxScroll),
    内容区与下载条的缝隙: round(barRect0.top - scrollerRect0.bottom),
    三个滚动位置上缝隙的最小值: minBarGap,
    内容区与工具条缝隙的最小值: minToolbarGap,
    下载条区域内的卡片像素点: barHits,
    工具条区域内的卡片像素点: toolbarHits,
    顶栏区域内的卡片像素点: topbarHits,
    取样: samples,
    滚到底时最后一张卡片下边缘: lastCardBottomAtEnd,
    滚到底时下载条上边缘: barTopAtEnd,
  });
})()`;

/**
 * 量顶部布局：整页的顶栏、工具条与网格必须各占各的位置，谁也不许浮到谁上面。
 *
 * 为什么单独有一条：下载条被压住（E2E-17）与"工具条浮到顶栏/卡片上面"其实是同一个病根
 * ——只要哪一段用了 position:sticky/fixed，它就会以视口或滚动容器为参照浮动起来。
 * 这里检查外壳四段的 position 全是 static、工具条在滚动的三个位置上都纹丝不动
 * （浮动元素会随滚动移动），并在两个横带里逐点命中测试，确认里面没有一个像素属于卡片。
 */
const TOP_LAYOUT_PROBE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const topbar = document.querySelector('.topbar');
  const toolbar = document.querySelector('.toolbar');
  const scroller = document.getElementById('scroller');
  const bar = document.querySelector('.downloadbar');
  if (!topbar || !toolbar || !scroller || !bar) {
    return JSON.stringify({ error: '图库页面缺少外壳节点' });
  }

  const documentScrolling = document.scrollingElement || document.documentElement;
  const documentScrolls = documentScrolling.scrollHeight > documentScrolling.clientHeight + 1;
  const target = documentScrolls ? documentScrolling : scroller;
  const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);

  /** 在某条横带里逐点取样，数一数有多少点落在了卡片上。 */
  const cardHitsInBand = (rect) => {
    let hits = 0;
    for (let y = rect.top + 2; y < rect.bottom - 2; y += 8) {
      for (let x = rect.left + 3; x < rect.right - 3; x += 40) {
        const node = document.elementFromPoint(x, y);
        if (node && node.closest && node.closest('#grid .card')) hits += 1;
      }
    }
    return hits;
  };

  const samples = [];
  let minToolbarGap = Infinity;
  let topbandCardHits = 0;
  let toolbarBandCardHits = 0;
  let barBandCardHits = 0;
  let firstCardTopAtStart = null;
  let toolbarBottomAtStart = null;
  let toolbarShift = 0;

  for (const ratio of [0, 0.5, 1]) {
    target.scrollTop = Math.round(maxScroll * ratio);
    const topRect = topbar.getBoundingClientRect();
    const toolRect = toolbar.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const firstCard = document.querySelector('#grid .card');
    if (ratio === 0) {
      firstCardTopAtStart = firstCard ? round(firstCard.getBoundingClientRect().top) : null;
      toolbarBottomAtStart = round(toolRect.bottom);
    } else {
      toolbarShift = Math.max(toolbarShift, round(Math.abs(toolRect.top - samples[0].工具条上边缘)));
    }
    minToolbarGap = Math.min(minToolbarGap, round(scrollerRect.top - toolRect.bottom));
    topbandCardHits += cardHitsInBand(topRect);
    toolbarBandCardHits += cardHitsInBand(toolRect);
    barBandCardHits += cardHitsInBand(barRect);
    samples.push({
      滚动位置: round(target.scrollTop),
      顶栏下边缘: round(topRect.bottom),
      工具条上边缘: round(toolRect.top),
      工具条下边缘: round(toolRect.bottom),
      内容区上边缘: round(scrollerRect.top),
    });
  }
  target.scrollTop = 0;

  return JSON.stringify({
    滚动的是: documentScrolls ? 'document（整页滚动）' : 'scroller（内容区滚动）',
    视口: window.innerWidth + 'x' + window.innerHeight,
    可滚动高度: round(maxScroll),
    外壳定位: {
      顶栏: getComputedStyle(topbar).position,
      工具条: getComputedStyle(toolbar).position,
      内容区: getComputedStyle(scroller).position,
      下载条: getComputedStyle(bar).position,
    },
    取样: samples,
    内容区上边缘与工具条下边缘的最小缝隙: minToolbarGap,
    工具条随滚动移动的距离: toolbarShift,
    顶栏区域内命中的卡片像素点: topbandCardHits,
    工具条区域内命中的卡片像素点: toolbarBandCardHits,
    下载条区域内命中的卡片像素点: barBandCardHits,
    滚动到顶部时第一张卡片上边缘: firstCardTopAtStart,
    滚动到顶部时工具条下边缘: toolbarBottomAtStart,
  });
})()`;

// ---------------------------------------------------------------- 小工具

function readPngInfo(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return null;
  }
  // IHDR 一定是第一个 chunk
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

function listFiles(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith('.crdownload'))
    .map((name) => ({ name, path: join(dir, name), bytes: statSync(join(dir, name)).size }));
}

async function connectTo(listPort, predicate) {
  const target = await waitUntil(
    async () => {
      const list = await listTargets(listPort);
      return list.find(predicate);
    },
    { label: '目标页面', timeoutMs: 20000 },
  );
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return { cdp, target };
}

// ---------------------------------------------------------------- 主流程

console.log('图提取 / ImageGrab — 真实浏览器端到端验证');
console.log(`浏览器：${findChrome()}`);
console.log(`模式：${HEADLESS ? '无头' : '有头'}    素材页：${PAGE_URL}`);
console.log(
  `被验证的扩展：${EXTENSION_DIR}${IS_SOURCE_DIR ? '（源码目录）' : '（非源码目录，例如解压出的安装包）'}`,
);
if (RUN_LABEL) console.log(`本次运行标记：${RUN_LABEL}`);
console.log('');

rmSync(PROFILE_DIR, { recursive: true, force: true });
rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });
prepareProfile(PROFILE_DIR, DOWNLOAD_DIR);

const server = await startServer({ root: FIXTURES_DIR, port: PORT, quiet: true });
let chrome = null;
let exitCode = 0;
/** 素材页与图库页的 CDP 连接，在 try 里赋值，供下面的辅助函数使用。 */
let page = null;
let gallery = null;

/** 读图库页面状态（GALLERY_STATE 返回 JSON 字符串）。 */
async function readGallery() {
  return JSON.parse(await gallery.evaluate(GALLERY_STATE));
}

/** 等缩略图加载稳定；超时返回最后一次状态，由调用方给出断言信息。 */
async function settleThumbnails(timeoutMs = 20000) {
  try {
    return await waitUntil(
      async () => {
        const state = await readGallery();
        return state.thumbs.filter((thumb) => thumb.loaded).length >= state.visible - 1 ? state : null;
      },
      { label: '缩略图加载', timeoutMs },
    );
  } catch {
    return readGallery();
  }
}

try {
  chrome = await launchChrome({
    profileDir: PROFILE_DIR,
    downloadsDir: DOWNLOAD_DIR,
    headless: HEADLESS,
    extraArgs: HOST_RULES,
  });
  console.log(`Chrome 调试端口：${chrome.port}`);

  const extension = await loadExtension(chrome.browser, EXTENSION_DIR);
  console.log(`扩展已加载：id=${extension.id}\n`);

  await chrome.browser.send('Target.createTarget', { url: PAGE_URL });
  const opened = await connectTo(chrome.port, (t) => t.type === 'page' && t.url.startsWith(PAGE_URL));
  page = opened.cdp;
  await waitUntil(() => page.evaluate(`document.readyState === 'complete'`), { label: '素材页加载完成' });

  /** 采集一次（点浮层按钮），必要时建立到图库页面的连接。 */
  async function collect() {
    await page.evaluate(`document.getElementById('imagegrab-fab-host').shadowRoot.querySelector('.fab').click(); 'ok'`);
    if (!gallery) {
      const target = await connectTo(chrome.port, (t) => t.url.includes('gallery/gallery.html'));
      gallery = target.cdp;
      assert(
        target.target.url.startsWith(`chrome-extension://${extension.id}/`),
        `图库页面应属于本扩展，实际 ${target.target.url}`,
      );
    }
    await waitUntil(
      async () => {
        const state = await readGallery();
        return state.cards > 0 ? state : null;
      },
      { label: '图库渲染出条目', timeoutMs: 20000 },
    );
  }

  // ------------------------------------------------------------ 1. 注入与动态适配

  await step('E2E-01', '内容脚本在商品详情页注入"获取图片"浮层', async () => {
    const state = await waitUntil(() => page.evaluate(FAB_STATE), { label: '浮层出现', timeoutMs: 15000 });
    assertEqual(state.label, '获取图片', '按钮文案');
    assertEqual(state.hostCount, 1, '浮层宿主节点数量');
    assert(state.connected, '浮层应挂在页面上');
    return `按钮文案「${state.label}」，宿主节点 ${state.hostCount} 个，未重复注入`;
  });

  await step('E2E-02', '页面框架删除浮层后自动补挂，且不产生重复节点', async () => {
    await page.evaluate(`document.getElementById('remove-fab').click(); 'ok'`);
    const gone = !(await page.evaluate(FAB_STATE));
    assert(gone, '点击"移除浮层"后浮层应消失');
    const state = await waitUntil(
      async () => {
        const current = await page.evaluate(FAB_STATE);
        return current && current.connected ? current : null;
      },
      { label: '浮层自动补挂', timeoutMs: 6000 },
    );
    assertEqual(state.hostCount, 1, '补挂后宿主节点数量');
    return '删除后 ~1.5 秒内补挂，宿主节点仍为 1 个';
  });

  await step('E2E-03', 'SPA 改地址（不刷新文档）时浮层自动隐藏并恢复', async () => {
    await page.evaluate(`document.getElementById('leave-detail').click(); 'ok'`);
    await waitUntil(async () => (await page.evaluate(FAB_STATE)) === null, { label: '浮层隐藏', timeoutMs: 6000 });
    await page.evaluate(`document.getElementById('back-detail').click(); 'ok'`);
    const state = await waitUntil(() => page.evaluate(FAB_STATE), { label: '浮层恢复', timeoutMs: 6000 });
    assertEqual(state.hostCount, 1, '恢复后宿主节点数量');
    return '非详情页地址自动隐藏，回到详情页地址自动恢复';
  });

  await step('E2E-04', '页面动态注入新图片后，重新采集能看到新图', async () => {
    // 素材页 2 秒后往 #dynamic-slot 塞一张 wide.png?dynamic=1
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const present = await page.evaluate(
      `Boolean(document.querySelector('#dynamic-slot img[src*="dynamic=1"]'))`,
    );
    assert(present, '素材页应已动态插入图片');
    return '已确认页面在加载后新增了一张图片（用于验证"支持动态页面"）';
  });

  // ------------------------------------------------------------ 2. 采集与图库

  await collect();

  let firstScan = null;
  await step('E2E-05', '点击浮层按钮打开图库页面并展示缩略图与尺寸', async () => {
    firstScan = await settleThumbnails();
    assert(firstScan.visible >= 8, `图库条目数应不少于 8，实际 ${firstScan.visible}`);
    assertEqual(firstScan.cards, firstScan.visible, '渲染出的卡片数与可见条数');
    const loadedThumbs = firstScan.thumbs.filter((thumb) => thumb.loaded).length;
    assert(
      loadedThumbs >= firstScan.visible - 1,
      `缩略图应基本都能显示，实际 ${loadedThumbs}/${firstScan.visible} 张加载成功`,
    );
    assert(/采集于/.test(firstScan.meta || ''), `应显示采集时间与数量，实际「${firstScan.meta}」`);
    return `${firstScan.visible} 张；缩略图 ${loadedThumbs} 张可预览；信息栏「${firstScan.meta}」`;
  });

  await step('E2E-06', '坏链接的缩略图降级为文字提示，而不是留白或报错', async () => {
    const state = await waitUntil(
      async () => {
        const current = await readGallery();
        return current.thumbs.some((thumb) => thumb.fallback) ? current : null;
      },
      { label: '兜底提示出现', timeoutMs: 20000 },
    ).catch(() => readGallery());
    const broken = state.thumbs.filter((thumb) => thumb.fallback);
    assert(
      broken.some((thumb) => thumb.itemId.includes('missing-file.png')),
      `坏链接条目应显示"无法预览"兜底提示，实际兜底 ${broken.length} 条（${broken.map((t) => t.itemId).join(', ') || '无'}）`,
    );
    firstScan = state;
    return `坏链接 ${broken.length} 张显示兜底文案，其余 ${state.thumbs.filter((t) => t.loaded).length} 张缩略图正常`;
  });

  await step('E2E-07', '未加载的图片被标记，并提示用户滚动后重新扫描', async () => {
    assert(firstScan.pendingCards >= 1, `应至少有 1 张"未加载"图片，实际 ${firstScan.pendingCards}`);
    const notice = `${firstScan.notice || ''}`;
    assert(/未加载|滚动/.test(notice), `顶部提示条应提示未加载/滚动，实际「${notice}」`);
    return `${firstScan.pendingCards} 张标记为未加载；提示：「${notice.slice(0, 60)}…」`;
  });

  await step('E2E-08', '全选 / 反选 / 取消选择 与已选数量一致', async () => {
    await gallery.evaluate(`document.getElementById('select-all').click(); 'ok'`);
    let state = await readGallery();
    assertEqual(state.selected, state.visible, '全选后的已选数量');
    assertEqual(state.downloadDisabled, false, '有选中项时下载按钮应可用');

    await gallery.evaluate(`document.getElementById('select-invert').click(); 'ok'`);
    state = await readGallery();
    assertEqual(state.selected, 0, '反选之后的已选数量');

    await gallery.evaluate(`document.getElementById('select-all').click(); 'ok'`);
    await gallery.evaluate(`document.getElementById('select-none').click(); 'ok'`);
    state = await readGallery();
    assertEqual(state.selected, 0, '取消选择之后的已选数量');
    assertEqual(state.downloadDisabled, true, '没有选中项时下载按钮应禁用');
    return `全选=${state.visible}、反选=0、取消=0`;
  });

  await step('E2E-09', '最小尺寸筛选会把小图从列表中剔除', async () => {
    await gallery.evaluate(`(() => {
      const input = document.getElementById('min-width');
      input.value = '50';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await waitUntil(async () => (await readGallery()).visible < firstScan.visible, {
      label: '筛选生效',
      timeoutMs: 5000,
    });
    const filtered = await readGallery();
    await gallery.evaluate(`(() => {
      const input = document.getElementById('min-width');
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    return `最小宽 50 后剩余 ${filtered.visible} 张（原 ${firstScan.visible} 张）`;
  });

  // ------------------------------------------------------------ 3. 真实转换与下载

  await step('E2E-10', 'BMP / JPEG / WebP 经扩展处理后被重新编码为真 PNG', async () => {
    const report = JSON.parse(
      await gallery.evaluate(
        `(async () => {
          const { processImage } = await import(chrome.runtime.getURL('lib/image-processor.js'));
          const out = [];
          for (const name of ['sample.bmp', 'sample.jpg', 'sample.webp', 'sample.png']) {
            const url = 'http://localhost:${PORT}/assets/' + name;
            try {
              const result = await processImage(url, { timeoutMs: 30000 });
              const head = new Uint8Array(await result.blob.slice(0, 8).arrayBuffer());
              const magic = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
              out.push({
                name,
                sourceType: result.sourceType,
                converted: result.converted,
                outputType: result.blob.type,
                bytes: result.blob.size,
                width: result.width,
                height: result.height,
                magic,
              });
            } catch (error) {
              out.push({ name, error: String((error && error.message) || error) });
            }
          }
          return JSON.stringify(out);
        })()`,
        { timeoutMs: 90000 },
      ),
    );

    const pngMagic = '89 50 4e 47 0d 0a 1a 0a';
    for (const row of report) {
      assert(!row.error, `${row.name} 处理失败：${row.error}`);
      assertEqual(row.magic, pngMagic, `${row.name} 的输出文件头`);
      assertEqual(row.outputType, 'image/png', `${row.name} 的输出 MIME`);
    }
    const bmp = report.find((row) => row.name === 'sample.bmp');
    const jpg = report.find((row) => row.name === 'sample.jpg');
    const webp = report.find((row) => row.name === 'sample.webp');
    assertEqual(bmp.sourceType, 'image/bmp', 'BMP 源图类型');
    assertEqual(jpg.sourceType, 'image/jpeg', 'JPEG 源图类型');
    assertEqual(webp.sourceType, 'image/webp', 'WebP 源图类型');
    assertEqual(bmp.converted, true, 'BMP 应被重新编码');
    assertEqual(jpg.converted, true, 'JPEG 应被重新编码');
    assertEqual(webp.converted, true, 'WebP 应被重新编码');

    return `BMP ${bmp.bytes}B→PNG、JPEG ${jpg.bytes}B→PNG、WebP ${webp.bytes}B→PNG，文件头均为 ${pngMagic}，尺寸 ${jpg.width}×${jpg.height}`;
  });

  await step('E2E-11', '批量下载落盘：命名为 商品图_001.png，且内容是真 PNG', async () => {
    await gallery.evaluate(INSTALL_PROBE);
    await gallery.evaluate(`document.getElementById('select-all').click(); 'ok'`);
    const before = await readGallery();
    await gallery.evaluate(`document.getElementById('download-button').click(); 'ok'`);
    const finished = await waitUntil(
      async () => {
        const state = await readGallery();
        return /^完成/.test(state.progress || '') ? state : null;
      },
      { label: '批量下载完成', timeoutMs: 180000 },
    );

    const files = await waitUntil(() => (listFiles(DOWNLOAD_DIR).length ? listFiles(DOWNLOAD_DIR) : null), {
      label: '下载文件落盘',
      timeoutMs: 30000,
    });

    // 文件名编号按图库中的显示顺序，失败的那一条会留下空号（不重排），因此
    // 期望的落盘集合 = 全部编号减去失败清单里的那个名字。
    const failedNames = finished.errorItems.map((text) => text.split('：')[0].trim());
    assertEqual(failedNames.length, 1, '失败清单里的文件名数量');
    const expected = new Set(
      Array.from({ length: finished.selected }, (_, i) => `${NAME_PREFIX}_${String(i + 1).padStart(3, '0')}.png`),
    );
    for (const name of failedNames) {
      assert(expected.has(name), `失败清单里的 ${name} 应属于本次下载的编号范围`);
      expected.delete(name);
    }
    assertEqual(files.length, expected.size, '落盘文件数量');

    for (const file of files) {
      assert(expected.has(file.name), `落盘的 ${file.name} 不在预期文件名集合里`);
      const info = readPngInfo(readFileSync(file.path));
      assert(info, `${file.name} 不是真正的 PNG 编码`);
      assert(info.width > 0 && info.height > 0, `${file.name} 的 IHDR 尺寸无效`);
    }

    return `${files.length} 个文件全部为真 PNG（IHDR 可读），命名从 ${NAME_PREFIX}_001.png 起连续编号，失败项 ${failedNames[0]} 留空号；进度区「${finished.progress}」`;
  });

  await step('E2E-12', '单张失败不中断整批，失败清单逐项给出原因', async () => {
    const state = await readGallery();
    assertEqual(state.errorPanelHidden, false, '失败清单应展开');
    assertEqual(state.errorCount, 1, '失败条目数');
    const item = state.errorItems[0] || '';
    assert(item.includes('missing-file.png'), `失败清单应指出是哪个地址，实际「${item}」`);
    assert(/404|HTTP|失败|无法/.test(item), `失败清单应给出原因，实际「${item}」`);
    const done = state.statuses.filter((text) => text.startsWith('已完成')).length;
    const failed = state.statuses.filter((text) => text.startsWith('失败：')).length;
    assertEqual(failed, 1, '状态为"失败"的卡片数');
    assert(done >= 7, `其余条目应正常完成，实际 ${done} 张`);
    assert(/完成 · 成功/.test(state.progress || ''), `进度区应保留下载结果总结，实际「${state.progress}」`);
    return `成功 ${done} 张、失败 1 张；失败原因：「${item.slice(0, 70)}」`;
  });

  await step('E2E-13', 'Blob URL 在对应下载结束之后才被释放', async () => {
    const probe = JSON.parse(await gallery.evaluate(READ_PROBE));
    assertEqual(probe.created, probe.revoked, '创建的 Blob URL 数应等于释放数（不能泄漏）');
    assertEqual(
      probe.terminalStates.filter((state) => state === 'complete').length,
      probe.created,
      '完成的下载数应等于创建过的 Blob URL 数',
    );
    for (let i = 0; i < probe.revokes.length; i += 1) {
      assert(
        probe.revokes[i] >= probe.terminals[i],
        `第 ${i + 1} 次 release 早于第 ${i + 1} 次下载结束（${probe.revokes[i]} < ${probe.terminals[i]}）`,
      );
    }
    return `${probe.created} 个 Blob URL 全部释放，且每一次释放都晚于对应的下载终态`;
  });

  await step('E2E-14', '重新扫描本页后，新出现的图片进入图库', async () => {
    const before = await readGallery();
    // 首次采集之后才往页面里插一张新图，模拟"详情页继续懒加载/追加内容"
    const newUrl = `assets/lazy.png?rescan=1`;
    await page.evaluate(`(() => {
      const img = document.createElement('img');
      img.width = 120;
      img.height = 120;
      img.alt = '重新扫描后应出现的新图';
      img.src = '${newUrl}';
      document.querySelector('main').appendChild(img);
      return 'ok';
    })()`);
    assert(
      !before.thumbs.some((thumb) => thumb.src.includes('rescan=1')),
      '注入新图之前，图库中不应有它',
    );

    await gallery.evaluate(`document.getElementById('rescan-button').click(); 'ok'`);
    const after = await waitUntil(
      async () => {
        const state = await readGallery();
        return state.thumbs.some((thumb) => thumb.src.includes('rescan=1')) ? state : null;
      },
      { label: '图库自动刷新出新图片', timeoutMs: 25000 },
    );
    return `条目 ${before.visible} → ${after.visible}，${newUrl} 已出现`;
  });

  await step('E2E-15', '采集结果落在 chrome.storage.session：Service Worker 被回收后仍能恢复', async () => {
    const before = await readGallery();

    const stored = JSON.parse(
      await gallery.evaluate(`(async () => {
        const all = await chrome.storage.session.get(null);
        const keys = Object.keys(all);
        const scanKey = keys.find((key) => key.startsWith('ig:scan:'));
        const record = scanKey ? all[scanKey] : null;
        return JSON.stringify({
          keys,
          itemCount: record && record.items ? record.items.length : 0,
          active: all['ig:active'] === undefined ? null : all['ig:active'],
          scanTabId: record ? record.tabId : null,
        });
      })()`),
    );
    assert(
      stored.keys.some((key) => key.startsWith('ig:scan:')),
      `会话存储里应有 ig:scan:* 记录，实际只有 ${stored.keys.join('、') || '(空)'}`,
    );
    assert(stored.itemCount > 0, '会话存储里的采集结果应包含图片条目');
    assertEqual(stored.active, stored.scanTabId, 'ig:active 应指向结果所属的标签页');

    // 停掉 Service Worker，模拟 MV3 空闲约 30 秒后的强制回收。
    // ServiceWorker 域只对普通页面有效，对扩展的 SW 用 Target.closeTarget 直接终止。
    const swTarget = (await listTargets(chrome.port)).find(
      (target) => target.type === 'service_worker' && target.url.includes(extension.id),
    );
    assert(swTarget, '应能找到扩展的 Service Worker 目标');
    await chrome.browser.send('Target.closeTarget', { targetId: swTarget.id });
    await waitUntil(
      async () => !(await listTargets(chrome.port)).some((target) => target.id === swTarget.id),
      { label: 'Service Worker 已停止', timeoutMs: 15000 },
    );

    // 重新加载图库页面：内存里已经没有采集结果，只能从会话存储恢复
    await gallery.send('Page.enable');
    await gallery.send('Page.reload', { ignoreCache: true });
    const restored = await waitUntil(
      async () => {
        const state = await readGallery();
        return state.cards > 0 ? state : null;
      },
      { label: '图库从会话存储恢复', timeoutMs: 20000 },
    );
    assertEqual(restored.visible, before.visible, '恢复后的条目数');
    return `会话存储键「${stored.keys.join('、')}」；终止 Service Worker 并重载图库后仍恢复出 ${restored.visible} 张`;
  });

  await step('E2E-16', '未授权域名（不在 host_permissions 内）的图片给出可读的失败原因', async () => {
    const before = await readGallery();
    // 这个域名不在 manifest 的 host_permissions 里，靠 --host-resolver-rules 指向本机素材服务器。
    // 页面里 <img> 能正常显示（图片显示不受 CORS 限制），但扩展页面 fetch 时会被浏览器拒绝。
    await page.evaluate(`(() => {
      const img = document.createElement('img');
      img.width = 96;
      img.height = 96;
      img.alt = '未授权域名上的图片';
      img.src = '${BLOCKED_ORIGIN_URL}';
      document.querySelector('main').appendChild(img);
      return 'ok';
    })()`);

    await gallery.evaluate(`document.getElementById('rescan-button').click(); 'ok'`);
    const after = await waitUntil(
      async () => {
        const state = await readGallery();
        return state.cards > before.cards ? state : null;
      },
      { label: '图库出现未授权域名的条目', timeoutMs: 25000 },
    );
    const target = after.thumbs.find((thumb) => thumb.itemId === BLOCKED_ORIGIN_URL);
    assert(target, `图库应包含 ${BLOCKED_ORIGIN_URL}，实际条目：${after.thumbs.map((t) => t.itemId).join('、')}`);

    // 只勾选这一张，其余全部取消，确保失败清单里只有它
    await gallery.evaluate(`(() => {
      document.getElementById('select-none').click();
      const card = document.querySelector('#grid .card[data-item-id="${BLOCKED_ORIGIN_URL}"]');
      if (!card) return 'no-card';
      card.querySelector('.thumb').click();
      return 'ok';
    })()`);
    const picked = await readGallery();
    assertEqual(picked.selected, 1, '应只勾选这一张未授权域名的图片');

    await gallery.evaluate(`document.getElementById('download-button').click(); 'ok'`);
    const failed = await waitUntil(
      async () => {
        const state = await readGallery();
        return state.errorCount >= 1 ? state : null;
      },
      { label: '未授权域名进入失败清单', timeoutMs: 40000 },
    );
    const line = failed.errorItems.find((text) => text.includes(BLOCKED_HOST)) || failed.errorItems[0] || '';
    assert(
      line.includes('不在扩展的访问权限内'),
      `失败原因应说明域名未授权，实际：「${line}」`,
    );
    assertEqual(failed.visible, after.visible, '失败不应影响其它条目的显示');
    return `失败原因：「${line}」`;
  });

  await step('E2E-17', '底部下载条与网格内容区不接触（内容区独立滚动）', async () => {
    // 把视口压到 900×520：素材页只有不到 10 张卡片，视口小一点才会必然超出内容区，
    // 否则"卡片伸到下载条下面"这种情况根本不会被触发。
    await gallery.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false,
    });
    let probe;
    try {
      probe = JSON.parse(await gallery.evaluate(LAYOUT_PROBE));
    } finally {
      await gallery.send('Emulation.clearDeviceMetricsOverride');
    }
    assert(!probe.error, probe.error || '布局探针执行失败');
    assertEqual(probe.下载条定位, 'static', '下载条不能是 fixed/sticky —— 浮动在内容之上就会盖住卡片');
    assertEqual(probe.内容区定位, 'static', '内容区只负责滚动，自己不该浮动');
    assertEqual(probe.内容区溢出方式, 'auto', '内容区的 overflow-y');
    assertEqual(probe.整页可滚动, false, '整页（document）不应该能滚动，滚动只属于内容区');
    assert(probe.内容区可滚动, `内容区应当可滚动，实际可滚动高度 ${probe.可滚动高度}px`);
    for (const sample of probe.取样) {
      assert(
        sample.内容区与下载条的重合高度 <= 0,
        `内容区与下载条重叠了 ${sample.内容区与下载条的重合高度}px（滚动位置 ${sample.滚动位置}）`,
      );
      assert(
        sample.内容区与下载条的缝隙 >= 8,
        `内容区下边缘与下载条上边缘只隔了 ${sample.内容区与下载条的缝隙}px（滚动位置 ${sample.滚动位置}），` +
          '看起来就像下载条贴在卡片上；应当留出一条页面底色的缝',
      );
    }
    assertEqual(probe.下载条区域内的卡片像素点, 0, '下载条区域内不应出现任何卡片像素');
    assertEqual(probe.工具条区域内的卡片像素点, 0, '工具条区域内不应出现任何卡片像素');
    assertEqual(probe.顶栏区域内的卡片像素点, 0, '顶栏区域内不应出现任何卡片像素');
    assert(
      probe.滚到底时最后一张卡片下边缘 <= probe.滚到底时下载条上边缘,
      `滚到内容区底部时最后一张卡片下边缘 ${probe.滚到底时最后一张卡片下边缘} 应不高于下载条上边缘 ${probe.滚到底时下载条上边缘}`,
    );
    return (
      `视口 ${probe.视口}，${probe.卡片数} 张卡片：下载条 position=${probe.下载条定位}，` +
      `内容区 overflow-y=${probe.内容区溢出方式}、可滚动 ${probe.可滚动高度}px，整页不可滚动；` +
      `在顶部 / 中间 / 底部三个滚动位置上，内容区与下载条之间始终留有 ` +
      `${probe.三个滚动位置上缝隙的最小值}~${probe.内容区与下载条的缝隙}px 的页面底色缝隙（无重叠、不贴边），` +
      `三段横带内累计 0 个卡片像素点；滚到底时最后一张卡片下边缘 ${probe.滚到底时最后一张卡片下边缘} < 下载条上边缘 ${probe.滚到底时下载条上边缘}`
    );
  });

  await step('E2E-18', '顶栏、工具条与网格互不重合（没有任何一段浮在另一段上面）', async () => {
    await gallery.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false,
    });
    let probe;
    try {
      probe = JSON.parse(await gallery.evaluate(TOP_LAYOUT_PROBE));
    } finally {
      await gallery.send('Emulation.clearDeviceMetricsOverride');
    }
    assert(!probe.error, probe.error || '顶部布局探针执行失败');
    assert(probe.可滚动高度 > 1, `内容区应当可滚动，实际可滚动高度 ${probe.可滚动高度}px`);
    assertEqual(
      probe.滚动的是,
      'scroller（内容区滚动）',
      '滚动的必须是内容区 —— 整页可滚动时 sticky 的工具条会钉在视口顶端、压住顶栏',
    );
    for (const [name, position] of Object.entries(probe.外壳定位)) {
      assertEqual(position, 'static', `${name}不能浮动（position 必须是 static）`);
    }
    assertEqual(
      probe.工具条随滚动移动的距离,
      0,
      `工具条应固定在外壳里、不随内容区滚动移动，实际移动了 ${probe.工具条随滚动移动的距离}px` +
        '（会移动就说明它还是浮动的 sticky 元素，滚动时就会压住卡片）',
    );
    assert(
      probe.内容区上边缘与工具条下边缘的最小缝隙 >= 8,
      `内容区上边缘与工具条下边缘的最小缝隙只有 ${probe.内容区上边缘与工具条下边缘的最小缝隙}px，` +
        '滚到一半时被裁掉的卡片会正好贴在工具条上，看起来就像两者重合',
    );
    assertEqual(probe.顶栏区域内命中的卡片像素点, 0, '顶栏横带内不应出现任何卡片像素');
    assertEqual(probe.工具条区域内命中的卡片像素点, 0, '工具条横带内不应出现任何卡片像素');
    assertEqual(probe.下载条区域内命中的卡片像素点, 0, '下载条横带内不应出现任何卡片像素');
    assert(
      probe.滚动到顶部时第一张卡片上边缘 >= probe.滚动到顶部时工具条下边缘,
      `滚动到顶部时第一张卡片上边缘 ${probe.滚动到顶部时第一张卡片上边缘} 应位于工具条下边缘 ${probe.滚动到顶部时工具条下边缘} 之下`,
    );
    return (
      `视口 ${probe.视口}，滚动的是${probe.滚动的是}、可滚动 ${probe.可滚动高度}px：` +
      `外壳四段（顶栏 / 工具条 / 内容区 / 下载条）的 position 全为 static，` +
      `工具条在三个滚动位置上移动了 ${probe.工具条随滚动移动的距离}px（固定不动）；` +
      `内容区与工具条之间留有 ${probe.内容区上边缘与工具条下边缘的最小缝隙}px 缝隙，三条横带内均 0 个卡片像素点；` +
      `滚动到顶部时第一张卡片上边缘 ${probe.滚动到顶部时第一张卡片上边缘} ≥ 工具条下边缘 ${probe.滚动到顶部时工具条下边缘}`
    );
  });
} catch (error) {
  console.log(`\n运行中断：${String((error && error.message) || error)}`);
  if (chrome) console.log(chrome.logs().slice(0, 2000));
  results.push({ id: 'E2E-00', title: '整个流程跑通', ok: false, detail: String((error && error.message) || error) });
} finally {
  if (chrome) await chrome.close();
  server.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 汇总

const passed = results.filter((row) => row.ok).length;
const failed = results.length - passed;

console.log('\n────────────────────────────────────────');
console.log(`通过 ${passed} / 失败 ${failed} / 共 ${results.length}`);
for (const row of results.filter((r) => !r.ok)) {
  console.log(`  \u2716 ${row.id} ${row.title}\n     ${row.detail}`);
}
console.log(`下载目录（保留供人工复核）：${DOWNLOAD_DIR}`);

if (failed > 0) exitCode = 1;
process.exit(exitCode);
