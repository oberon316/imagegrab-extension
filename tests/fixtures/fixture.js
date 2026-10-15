/**
 * tests/fixtures/fixture.js —— 素材页的交互脚本（仅测试用途）。
 *
 * 覆盖三件扩展必须自己扛住的动态场景：
 *   1. 页面在加载后继续注入新的图片；
 *   2. 页面框架把扩展注入的浮层节点删掉；
 *   3. 单页应用只改地址、不重新加载文档。
 */

/** 原始入口地址，用于"回到详情页"按钮。 */
const DETAIL_URL = location.pathname + location.search;

function appendDynamicImage() {
  const slot = document.getElementById('dynamic-slot');
  if (!slot || slot.querySelector('img')) return;
  const img = document.createElement('img');
  img.className = 'thumb';
  img.width = 96;
  img.height = 96;
  img.alt = '动态注入的图片 240x90';
  img.src = 'assets/wide.png?dynamic=1';
  slot.appendChild(img);
}

window.setTimeout(appendDynamicImage, 2000);

document.getElementById('remove-fab').addEventListener('click', () => {
  const host = document.getElementById('imagegrab-fab-host');
  if (host) host.remove();
});

document.getElementById('leave-detail').addEventListener('click', () => {
  history.pushState({}, '', '/not-a-detail-page');
});

document.getElementById('back-detail').addEventListener('click', () => {
  history.pushState({}, '', DETAIL_URL);
});
