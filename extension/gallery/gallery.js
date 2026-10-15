/**
 * gallery/gallery.js —— 图库页面。
 *
 * 这是整个扩展里唯一"具备完整 DOM"的执行环境，因此承担两件只能在页面里做的事：
 *   1. Canvas 转 PNG（lib/image-processor.js）；
 *   2. 用 chrome.downloads + Blob URL 驱动下载（lib/downloader.js）。
 *
 * 数据来源：background 写入 chrome.storage.session 的采集结果（lib/session.js）。
 * 页面通过 chrome.storage.onChanged 感知"重新扫描"的结果，不依赖长连接。
 */

import { MSG, sendToBackground } from '../lib/messaging.js';
import { getScan, getLatestScan, watchScans } from '../lib/session.js';
import { buildPngFilename, formatBytes, guessExtension } from '../lib/url-utils.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { createDownloader, ITEM_STATE } from '../lib/downloader.js';

const KIND_LABELS = {
  img: '图片标签',
  picture: '响应式图片',
  background: 'CSS 背景图',
  'video-poster': '视频封面',
  'meta-og': '分享图',
  'link-icon': '站点图标',
};

const STATE_TEXT = {
  [ITEM_STATE.PENDING]: '待处理',
  [ITEM_STATE.CONVERTING]: '正在取图并转换为 PNG…',
  [ITEM_STATE.DOWNLOADING]: '下载中…',
};

const RENDER_CHUNK = 200;

// ---------------------------------------------------------------- DOM 引用

const el = {
  sourceLine: document.getElementById('source-line'),
  scanMeta: document.getElementById('scan-meta'),
  rescanButton: document.getElementById('rescan-button'),
  notice: document.getElementById('notice'),
  minWidth: document.getElementById('min-width'),
  minHeight: document.getElementById('min-height'),
  includeInline: document.getElementById('include-inline'),
  selectAll: document.getElementById('select-all'),
  selectInvert: document.getElementById('select-invert'),
  selectNone: document.getElementById('select-none'),
  selectedCount: document.getElementById('selected-count'),
  visibleCount: document.getElementById('visible-count'),
  grid: document.getElementById('grid'),
  emptyState: document.getElementById('empty-state'),
  errorPanel: document.getElementById('error-panel'),
  errorCount: document.getElementById('error-count'),
  errorList: document.getElementById('error-list'),
  retryButton: document.getElementById('retry-button'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  downloadButton: document.getElementById('download-button'),
};

// ---------------------------------------------------------------- 状态

const state = {
  /** 采集结果所属的标签页 id */
  tabId: null,
  /** 最近一次采集结果 */
  scan: null,
  /** 已选中的图片 id 集合（跨筛选保留） */
  selected: new Set(),
  /** id -> {card, status, serial, checkbox} */
  cardRefs: new Map(),
  /** 当前显示的条目（按采集顺序） */
  visible: [],
  filters: { minWidth: 0, minHeight: 0, includeInlineData: false },
  settings: null,
  running: false,
  stopped: false,
  /**
   * 下载结束后要保留在进度区的总结文案（"完成 · 成功 X / 失败 Y …"）。
   * 为什么要单独存一份：updateSelectionUI 在每次运行结束后都会被调用，
   * 如果它无条件重写进度区，"下载完成/失败了多少张"会被立刻覆盖成下载前的文件名预览，
   * 用户根本看不到结果。因此总结文案一直显示到用户改动选择或重新采集为止。
   */
  summaryText: '',
  /** 上一次运行的条目，供"重试失败项"使用 */
  lastEntries: [],
  lastResults: [],
  downloader: null,
  renderToken: 0,
  progress: { started: 0, done: 0, failed: 0, total: 0 },
};

// ---------------------------------------------------------------- 小工具

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function createTag(text, extraClass) {
  const span = document.createElement('span');
  span.className = extraClass ? `tag ${extraClass}` : 'tag';
  span.textContent = text;
  return span;
}

function describeSize(item) {
  if (!item.width || !item.height) return '尺寸未知';
  const prefix = item.sizeSource === 'natural' ? '' : '约 ';
  return `${prefix}${item.width}×${item.height}`;
}

function describeKind(item) {
  const labels = item.sources.map((kind) => KIND_LABELS[kind] || kind);
  return Array.from(new Set(labels)).join(' + ');
}

// ---------------------------------------------------------------- 提示条

/**
 * @param {Array<{text: string, level?: string}>|string|null} content
 */
function setNotice(content) {
  clearNode(el.notice);
  const items = Array.isArray(content) ? content : content ? [{ text: content }] : [];
  if (!items.length) {
    el.notice.hidden = true;
    return;
  }
  if (items.length === 1) {
    el.notice.textContent = items[0].text;
  } else {
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item.text;
      list.appendChild(li);
    }
    el.notice.appendChild(list);
  }
  el.notice.hidden = false;
}

function noticesForScan(scan) {
  const out = [];
  if (!scan) return out;
  if (scan.pendingCount > 0) {
    out.push({
      level: 'warn',
      text: `检测到 ${scan.pendingCount} 张图片在采集时尚未加载（页面懒加载）。请回到商品页向下滚动让它们加载，再点右上角"重新扫描本页"。`,
    });
  }
  if (scan.trimmedByStorage) {
    out.push({ level: 'warn', text: '采集结果过大，仅保留了前若干张。建议缩小商品页的滚动范围后重新采集。' });
  }
  for (const warning of scan.warnings || []) {
    if (warning.code === 'storage-trimmed') continue;
    out.push({ level: 'warn', text: warning.message });
  }
  return out;
}

function updateScanMeta(scan) {
  if (!scan) {
    el.scanMeta.textContent = '';
    el.sourceLine.textContent = '尚未采集任何页面';
    el.sourceLine.title = '';
    return;
  }
  const time = new Date(scan.collectedAt || scan.savedAt || Date.now());
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const elapsed = scan.stats ? `${(scan.stats.elapsedMs / 1000).toFixed(1)} 秒` : '—';
  const site = scan.site ? `${scan.site} · ` : '';
  el.scanMeta.textContent = `采集于 ${hh}:${mm} · ${scan.items.length} 张 · 用时 ${elapsed}`;
  el.sourceLine.textContent = `${site}${scan.pageTitle || '(无标题)'} — ${scan.pageUrl}`;
  el.sourceLine.title = scan.pageUrl;
}

// ---------------------------------------------------------------- 筛选

function visibleItems() {
  const { minWidth, minHeight, includeInlineData } = state.filters;
  const items = (state.scan && state.scan.items) || [];
  return items.filter((item) => {
    if (minWidth > 0 && item.width > 0 && item.width < minWidth) return false;
    if (minHeight > 0 && item.height > 0 && item.height < minHeight) return false;
    if (!includeInlineData && item.url.startsWith('data:')) return false;
    return true;
  });
}

// ---------------------------------------------------------------- 渲染

function buildCard(item) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.itemId = item.id;
  li.dataset.pending = item.pending ? 'true' : 'false';

  const pick = document.createElement('label');
  pick.className = 'pick';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.itemId = item.id;
  checkbox.checked = state.selected.has(item.id);
  checkbox.setAttribute('aria-label', `选择 ${item.url}`);

  const serial = document.createElement('span');
  serial.className = 'serial';

  pick.append(checkbox, serial);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const image = document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = item.alt || '';
  image.src = item.url;
  image.addEventListener('error', () => {
    image.remove();
    const fallback = document.createElement('div');
    fallback.className = 'fallback';
    fallback.textContent = '此图无法预览（可能受防盗链限制），仍可尝试下载';
    thumb.appendChild(fallback);
  });
  thumb.appendChild(image);

  const info = document.createElement('div');
  info.className = 'info';

  const dims = document.createElement('span');
  dims.className = 'dims';
  dims.textContent = describeSize(item);

  const tags = document.createElement('div');
  tags.className = 'tags';
  tags.appendChild(createTag(describeKind(item), 'kind'));
  const ext = guessExtension(item.url);
  if (ext) tags.appendChild(createTag(`原 ${ext.toUpperCase()}`));
  if (item.pending) tags.appendChild(createTag('未加载', 'pending'));

  info.append(dims, tags);

  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = STATE_TEXT[ITEM_STATE.PENDING];

  li.append(pick, thumb, info, status);
  state.cardRefs.set(item.id, { card: li, status, serial, checkbox });
  return li;
}

async function renderGrid() {
  const token = (state.renderToken += 1);
  state.visible = visibleItems();
  state.cardRefs.clear();
  clearNode(el.grid);

  el.visibleCount.textContent = String(state.visible.length);
  el.emptyState.hidden = state.visible.length > 0;

  for (let offset = 0; offset < state.visible.length; offset += RENDER_CHUNK) {
    if (token !== state.renderToken) return;
    const fragment = document.createDocumentFragment();
    for (const item of state.visible.slice(offset, offset + RENDER_CHUNK)) {
      fragment.appendChild(buildCard(item));
    }
    el.grid.appendChild(fragment);
    updateSelectionUI();
    if (offset + RENDER_CHUNK < state.visible.length) await nextFrame();
  }
}

/** 选中条目的编号就是它的下载文件名编号，这里同步到卡片上。 */
function selectedInOrder() {
  return state.visible.filter((item) => state.selected.has(item.id));
}

function updateSelectionUI() {
  const selected = selectedInOrder();
  el.selectedCount.textContent = String(selected.length);

  for (const [id, refs] of state.cardRefs) {
    const index = selected.findIndex((item) => item.id === id);
    refs.serial.textContent = index >= 0 ? String(index + 1).padStart(3, '0') : '';
  }

  if (!state.running) {
    el.downloadButton.disabled = selected.length === 0;
    el.downloadButton.textContent = selected.length
      ? `下载选中的 ${selected.length} 张图片`
      : '下载选中的图片';
    if (state.summaryText) {
      // 保留上一次下载的结果总结，直到用户改动选择或重新采集
      el.progressText.textContent = state.summaryText;
    } else if (selected.length) {
      const first = buildPngFilename(1, { total: selected.length });
      const last = buildPngFilename(selected.length, { total: selected.length });
      el.progressText.textContent = `将保存为 ${first}${selected.length > 1 ? ` … ${last}` : ''}（全部为真实 PNG 编码）`;
    } else {
      el.progressText.textContent = '尚未开始下载';
    }
  }
}

/** 选择发生变化：上一次的下载总结不再适用。 */
function invalidateSummary() {
  state.summaryText = '';
}

function setProgressBar(percent, text) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  el.progressFill.style.width = `${value}%`;
  el.progress.setAttribute('aria-valuenow', String(value));
  el.progressText.textContent = text;
}

function setCardState(itemId, itemState, text) {
  const refs = state.cardRefs.get(itemId);
  if (!refs) return;
  refs.card.dataset.state = itemState;
  refs.status.textContent = text;
}

// ---------------------------------------------------------------- 失败清单

function renderErrors(results) {
  const failures = results.filter((result) => !result.ok);
  clearNode(el.errorList);
  el.errorCount.textContent = String(failures.length);
  el.errorPanel.hidden = failures.length === 0;
  for (const failure of failures) {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = `${failure.filename}：`;
    const reason = document.createElement('span');
    reason.textContent = `${failure.error}　`;
    const url = document.createElement('span');
    url.className = 'error-url';
    url.textContent = failure.url;
    li.append(name, reason, url);
    el.errorList.appendChild(li);
  }
}

// ---------------------------------------------------------------- 下载

function handleDownloadEvent(event) {
  const progress = state.progress;
  switch (event.type) {
    case 'prepare':
      setCardState(event.item.id, ITEM_STATE.CONVERTING, STATE_TEXT[ITEM_STATE.CONVERTING]);
      break;
    case 'start':
      progress.started += 1;
      setCardState(event.item.id, ITEM_STATE.DOWNLOADING, `下载中…（${event.sourceType} → PNG${event.converted ? '，已转换' : '，源文件即 PNG'}）`);
      break;
    case 'done':
      progress.done += 1;
      setCardState(
        event.item.id,
        ITEM_STATE.DONE,
        `已完成 · ${formatBytes(event.bytes)} · ${event.converted ? '已转换为 PNG' : '源文件即 PNG'}`,
      );
      break;
    case 'error':
      progress.failed += 1;
      setCardState(event.item.id, ITEM_STATE.FAILED, `失败：${event.error}`);
      break;
    default:
      return;
  }

  const finished = progress.done + progress.failed;
  const percent = progress.total ? (finished / progress.total) * 100 : 0;
  const parts = [`成功 ${progress.done}`, `失败 ${progress.failed}`, `共 ${progress.total}`];
  const converting = progress.started - finished;
  if (converting > 0) parts.push(`处理中 ${converting}`);
  setProgressBar(percent, `下载开始 ${progress.started} · ${parts.join(' / ')}`);
}

async function runDownload(entries) {
  if (state.running || entries.length === 0) return;

  state.running = true;
  state.stopped = false;
  state.progress = { started: 0, done: 0, failed: 0, total: entries.length };
  state.lastEntries = entries;
  state.summaryText = '';
  renderErrors([]);
  el.downloadButton.disabled = true;
  el.downloadButton.textContent = '下载中…';
  setProgressBar(0, `共 ${entries.length} 张，准备开始…`);

  for (const entry of entries) {
    setCardState(entry.item.id, ITEM_STATE.PENDING, STATE_TEXT[ITEM_STATE.PENDING]);
  }

  const downloader = createDownloader({
    concurrency: state.settings.concurrency,
    timeoutMs: state.settings.timeoutMs,
    onEvent: handleDownloadEvent,
  });
  state.downloader = downloader;

  const startedAt = Date.now();
  try {
    const results = await downloader.run(entries);
    state.lastResults = results;
    const ok = results.filter((result) => result.ok).length;
    const failed = results.length - ok;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    renderErrors(results);
    state.summaryText = `完成 · 成功 ${ok} / 失败 ${failed} / 共 ${results.length} · 用时 ${seconds} 秒` +
      (failed ? '；失败项见下方清单，可点"重试失败项"' : '');
    setProgressBar(100, state.summaryText);
  } catch (error) {
    const message = String((error && error.message) || error);
    state.summaryText = `下载任务异常终止：${message}`;
    setNotice(`下载任务异常终止：${message}`);
  } finally {
    downloader.dispose();
    state.downloader = null;
    state.running = false;
    updateSelectionUI();
  }
}

async function startDownload() {
  const items = selectedInOrder();
  if (!items.length) return;
  const total = items.length;
  // 文件名编号按图库中的显示顺序，从 1 开始：商品图_001.png
  const entries = items.map((item, index) => ({ item, filename: buildPngFilename(index + 1, { total }) }));
  await runDownload(entries);
}

async function retryFailed() {
  const failedIds = new Set(state.lastResults.filter((result) => !result.ok).map((result) => result.item.id));
  const entries = state.lastEntries.filter((entry) => failedIds.has(entry.item.id));
  if (!entries.length) return;
  await runDownload(entries);
}

// ---------------------------------------------------------------- 扫描结果接入

function applyScan(scan) {
  state.scan = scan;
  const validIds = new Set((scan ? scan.items : []).map((item) => item.id));
  // 只保留仍然存在的选中项
  state.selected = new Set(Array.from(state.selected).filter((id) => validIds.has(id)));
  // 新的一次采集结果：上一次的下载总结不再适用
  state.summaryText = '';

  updateScanMeta(scan);
  setNotice(noticesForScan(scan));
  if (!scan) {
    setNotice('尚未采集任何页面。请打开淘宝/天猫/京东/拼多多的商品详情页，点击右下角"获取图片"按钮。');
  }
  return renderGrid();
}

async function loadInitial() {
  const params = new URLSearchParams(location.search);
  const requested = Number(params.get('tabId'));

  state.settings = await getSettings();
  state.filters.minWidth = state.settings.minWidth;
  state.filters.minHeight = state.settings.minHeight;
  state.filters.includeInlineData = state.settings.includeInlineData;
  el.minWidth.value = String(state.filters.minWidth);
  el.minHeight.value = String(state.filters.minHeight);
  el.includeInline.value = state.filters.includeInlineData;

  let scan = null;
  if (Number.isFinite(requested)) {
    state.tabId = requested;
    scan = await getScan(requested);
  }
  if (!scan) {
    scan = await getLatestScan();
    if (scan) state.tabId = scan.tabId;
  }
  await applyScan(scan);
}

// ---------------------------------------------------------------- 事件绑定

el.minWidth.addEventListener('input', () => {
  const value = Math.max(0, Math.trunc(Number(el.minWidth.value) || 0));
  state.filters.minWidth = value;
  renderGrid();
  saveSettings({ minWidth: value });
});

el.minHeight.addEventListener('input', () => {
  const value = Math.max(0, Math.trunc(Number(el.minHeight.value) || 0));
  state.filters.minHeight = value;
  renderGrid();
  saveSettings({ minHeight: value });
});

el.includeInline.addEventListener('change', () => {
  state.filters.includeInlineData = el.includeInline.checked;
  renderGrid();
  saveSettings({ includeInlineData: el.includeInline.checked });
  if (el.includeInline.checked) {
    setNotice('已启用"包含内联小图"。该开关在采集阶段生效，请点右上角"重新扫描本页"重新采集。');
  } else {
    setNotice(noticesForScan(state.scan));
  }
});

el.selectAll.addEventListener('click', () => {
  invalidateSummary();
  for (const item of state.visible) state.selected.add(item.id);
  for (const refs of state.cardRefs.values()) refs.checkbox.checked = true;
  updateSelectionUI();
});

el.selectInvert.addEventListener('click', () => {
  invalidateSummary();
  for (const item of state.visible) {
    if (state.selected.has(item.id)) state.selected.delete(item.id);
    else state.selected.add(item.id);
  }
  for (const [id, refs] of state.cardRefs) refs.checkbox.checked = state.selected.has(id);
  updateSelectionUI();
});

el.selectNone.addEventListener('click', () => {
  invalidateSummary();
  state.selected.clear();
  for (const refs of state.cardRefs.values()) refs.checkbox.checked = false;
  updateSelectionUI();
});

el.grid.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
  const id = input.dataset.itemId;
  if (!id) return;
  invalidateSummary();
  if (input.checked) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionUI();
});

// 点缩略图等同于勾选，鼠标只用一次
el.grid.addEventListener('click', (event) => {
  const thumb = event.target.closest('.thumb');
  if (!thumb) return;
  const card = thumb.closest('.card');
  if (!card) return;
  const refs = state.cardRefs.get(card.dataset.itemId);
  if (!refs) return;
  refs.checkbox.checked = !refs.checkbox.checked;
  refs.checkbox.dispatchEvent(new Event('change', { bubbles: true }));
});

el.downloadButton.addEventListener('click', () => {
  startDownload().catch(() => {});
});

el.retryButton.addEventListener('click', () => {
  retryFailed().catch(() => {});
});

el.rescanButton.addEventListener('click', async () => {
  if (!Number.isFinite(state.tabId)) {
    setNotice('找不到来源标签页，无法重新扫描。请回到商品页重新点击"获取图片"。');
    return;
  }
  const result = await sendToBackground({ type: MSG.RESCAN_REQUEST, tabId: state.tabId });
  if (!result.ok) {
    setNotice(`重新扫描失败：${result.error || '未知原因'}`);
    return;
  }
  setNotice('已请求重新扫描，原页面返回结果后这里会自动刷新。');
});

// 后台写入新的采集结果时自动刷新
watchScans((record, tabId) => {
  if (!state.scan) {
    return;
  }
  if (Number.isFinite(state.tabId) && tabId !== state.tabId) return;
  if (record) {
    state.tabId = record.tabId;
    applyScan(record).catch(() => {});
  }
});

loadInitial().catch((error) => {
  setNotice(`读取采集结果失败：${String((error && error.message) || error)}`);
});
