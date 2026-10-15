/**
 * tests/layout-shots.mjs —— 图库布局"实拍"工具：给网格灌满图片，量各横带的位置并截图。
 *
 *   node tests/layout-shots.mjs                     # 默认 1010×640 视口
 *   $env:PROBE_W="1520"; $env:PROBE_H="940"; node tests/layout-shots.mjs   # 换视口尺寸
 *
 * 为什么需要它：`browser-e2e.mjs` 的 E2E-17 / E2E-18 只能用矩形与逐点命中测试来断言
 * "外壳的某一段没有浮到网格上面"，断言能过但版面看上去是否"像重合"（例如裁掉的卡片
 * 正好贴住底部下载条）只能靠眼睛看。这个脚本负责后者：素材页默认只有不到 10 张卡片，
 * 它会先往素材页里灌 120 张图（模拟真实商品页的几十上百张），再在内容区的
 * 顶部 / 中间 / 底部三个位置各截一张图。
 *
 * 产物：tests/tmp/layout-probe-<时间戳>/{top,mid,bottom}.png，以及 stdout 上的几何数字
 * （各段矩形、内容区上下缝隙、落在下载条矩形内的卡片数与最后一行位置）。
 * 它只用于人工核对与定位问题，不属于交付物，也不在 scripts/check.mjs 的检查范围里。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { findChrome, launchChrome, loadExtension, prepareProfile } from '../scripts/lib/chrome.mjs';
import { Cdp, listTargets, waitUntil } from '../scripts/lib/cdp.mjs';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures');
const OUT_DIR = join(ROOT, 'tests', 'tmp', `layout-probe-${Date.now()}`);
const PROFILE_DIR = join(OUT_DIR, 'profile');
const DOWNLOAD_DIR = join(OUT_DIR, 'downloads');
const PORT = 8791;
const WIDTH = Number(process.env.PROBE_W || 1010);
const HEIGHT = Number(process.env.PROBE_H || 640);
/** 灌进素材页的图片数量：够长即可，用来逼近真实商品页的卡片规模。 */
const EXTRA_IMAGES = 120;

mkdirSync(OUT_DIR, { recursive: true });
prepareProfile(PROFILE_DIR, DOWNLOAD_DIR);

const server = await startServer({ root: FIXTURES_DIR, port: PORT, quiet: true });
const chrome = await launchChrome({ profileDir: PROFILE_DIR, downloadsDir: DOWNLOAD_DIR, headless: true });
const extension = await loadExtension(chrome.browser, join(ROOT, 'extension'));

console.log(`浏览器：${findChrome()}`);
console.log(`扩展：${extension.id}（源码目录）`);

await chrome.browser.send('Target.createTarget', { url: 'about:blank' });
const pageTarget = await waitUntil(
  async () =>
    (await listTargets(chrome.port)).find(
      (t) => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://'),
    ),
  { label: '素材页' },
);
const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Page.navigate', { url: `http://localhost:${PORT}/fixture-merchant-detail.html` });
await waitUntil(
  () =>
    page.evaluate(
      `location.href.includes('fixture-merchant') && document.readyState === 'complete' && !!document.querySelector('main')`,
    ),
  { label: '素材页就绪', timeoutMs: 30000 },
);

await page.evaluate(`(() => {
  const row = document.createElement('div');
  row.className = 'row';
  const sizes = [[96, 96], [240, 90], [64, 160], [180, 180]];
  for (let i = 1; i <= ${EXTRA_IMAGES}; i += 1) {
    const [w, h] = sizes[i % sizes.length];
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '布局实拍 #' + i;
    img.src = 'assets/sample.png?shot=' + i;
    img.width = w;
    img.height = h;
    row.appendChild(img);
  }
  document.querySelector('main').appendChild(row);
  return 'ok';
})()`);

await page.evaluate(`document.getElementById('imagegrab-fab-host').shadowRoot.querySelector('.fab').click(); 'ok'`);
const galTarget = await waitUntil(
  async () => (await listTargets(chrome.port)).find((t) => t.url.includes('gallery/gallery.html')),
  { label: '图库页' },
);
const gallery = await Cdp.connect(galTarget.webSocketDebuggerUrl);
await gallery.send('Runtime.enable');
await gallery.send('Page.enable');
await waitUntil(async () => (await gallery.evaluate(`document.querySelectorAll('#grid .card').length`)) > 100, {
  label: '图库渲染',
  timeoutMs: 30000,
});

await gallery.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});
await gallery.evaluate(`document.getElementById('select-all').click(); 'ok'`);
await new Promise((resolve) => setTimeout(resolve, 1500));

/** 量一遍外壳各段的位置与"卡片是否落进某条横带"。 */
const MEASURE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), h: round(r.height) };
  };
  const scroller = document.getElementById('scroller');
  const bar = document.querySelector('.downloadbar');
  const barRect = bar.getBoundingClientRect();
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  // 被 overflow 裁掉的部分虽然看不见，矩形仍然伸到下载条下面，所以这里量的是矩形
  const belowBar = cards
    .map((card) => ({ id: card.dataset.itemId.slice(-24), bottom: round(card.getBoundingClientRect().bottom) }))
    .filter((row) => row.bottom > round(barRect.top) + 0.5);

  return JSON.stringify({
    视口: window.innerWidth + 'x' + window.innerHeight,
    整页高度: document.documentElement.scrollHeight,
    内容区滚动位置: round(scroller.scrollTop),
    顶栏: rect('.topbar'),
    工具条: rect('.toolbar'),
    内容区: rect('#scroller'),
    下载条: rect('.downloadbar'),
    下载条定位: getComputedStyle(bar).position,
    内容区与工具条的缝隙: round(scroller.getBoundingClientRect().top - document.querySelector('.toolbar').getBoundingClientRect().bottom),
    内容区与下载条的缝隙: round(barRect.top - scroller.getBoundingClientRect().bottom),
    卡片数: cards.length,
    '卡片矩形越过下载条上边缘的张数（被内容区裁掉的部分）': belowBar.length,
  });
})()`;

const shoot = async (label, scrollTop) => {
  if (scrollTop !== null) {
    await gallery.evaluate(
      `(() => { const s = document.getElementById('scroller'); s.scrollTop = ${scrollTop === 'max' ? 's.scrollHeight' : scrollTop}; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const measured = JSON.parse(await gallery.evaluate(MEASURE));
  console.log(`\n--- ${label} ---`);
  console.log(measured);
  const shot = await gallery.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${label}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`截图 → ${file}`);
};

await shoot('top', 0);
await shoot('mid', 400);
await shoot('bottom', 'max');

await gallery.send('Emulation.clearDeviceMetricsOverride');
await chrome.close();
server.close();
process.exit(0);
