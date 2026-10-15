/**
 * background/service-worker.js —— MV3 后台。
 *
 * 职责边界（严格限定，越界就会踩 MV3 的坑）：
 *  - 路由消息、注入内容脚本、决定何时打开图库、维护图标角标；
 *  - 采集结果写入 chrome.storage.session，不放在 Service Worker 的全局变量里（会被回收）；
 *  - 不碰 document / HTMLCanvasElement / URL.createObjectURL —— 那些都必须发生在图库页面。
 *
 * 因此本文件只 import lib/messaging.js 与 lib/session.js，绝不 import
 * lib/image-processor.js / lib/downloader.js。check.mjs 会顺着 import 链强制校验。
 */

import { MSG } from '../lib/messaging.js';
import { sendToTab } from '../lib/messaging.js';
import { saveScan, getScan, setGalleryTabId, getGalleryTabId } from '../lib/session.js';
import { PALETTE } from '../lib/theme.js';

/** 内容脚本文件列表，顺序与 manifest.json 的 content_scripts.js 保持一致。 */
const CONTENT_FILES = ['content/url-tools.js', 'content/collector.js', 'content/ui.js', 'content/content.js'];

const GALLERY_PATH = 'gallery/gallery.html';
const MENU_PAGE = 'ig-collect-page';

/** 注入失败的角标。 */
const BADGE_FAIL = '×';
/** 单张图片采集不到时的兜底上限，避免角标被撑爆。 */
const BADGE_MAX = 999;

// ---------------------------------------------------------------- 右键菜单

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // removeAll 后立刻 create，回调里读 lastError 避免未捕获异常
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: MENU_PAGE,
        title: '提取本页图片',
        contexts: ['page', 'frame', 'image', 'link', 'selection'],
      },
      () => void chrome.runtime.lastError,
    );
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

// ---------------------------------------------------------------- 角标

async function setBadge(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    if (title) await chrome.action.setTitle({ tabId, title });
  } catch {
    /* 标签页已关闭时忽略 */
  }
}

async function showCountBadge(tabId, count) {
  const text = count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
  await setBadge(tabId, count > 0 ? text : '', PALETTE.teal, `图提取：已找到 ${count} 张图片`);
}

async function showFailureBadge(tabId) {
  await setBadge(tabId, BADGE_FAIL, PALETTE.caramel, '图提取：本页无法采集，请刷新页面后重试');
}

// ---------------------------------------------------------------- 内容脚本

/** 确认内容脚本就绪，不在就补注入。 */
async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { type: MSG.PING });
  if (ping.ok) return true;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch {
    // 常见原因：chrome:// 页面、应用商店页面、PDF 预览等禁止注入
    return false;
  }

  const retry = await sendToTab(tabId, { type: MSG.PING });
  return Boolean(retry.ok);
}

/**
 * 让某个标签页开始采集。
 * @param {number} tabId
 * @param {{openGallery?: boolean}} [options]
 */
async function collectIn(tabId, options = {}) {
  if (!Number.isFinite(tabId)) return { ok: false, error: '缺少标签页 id' };

  const ready = await ensureContentScript(tabId);
  if (!ready) {
    await showFailureBadge(tabId);
    return { ok: false, error: '无法在该页面注入采集脚本（可能是浏览器内置页面）' };
  }

  const sent = await sendToTab(tabId, {
    type: MSG.SCAN_REQUEST,
    openGallery: options.openGallery !== false,
  });
  if (!sent.ok) {
    await showFailureBadge(tabId);
    return { ok: false, error: sent.error };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 图库标签页

/** 复用已打开的图库标签页，没有就新建。 */
async function openGalleryTab(sourceTabId) {
  const url = chrome.runtime.getURL(`${GALLERY_PATH}?tabId=${sourceTabId}`);
  const existingId = await getGalleryTabId();

  if (Number.isFinite(existingId)) {
    try {
      const tab = await chrome.tabs.update(existingId, { url, active: true });
      if (tab && Number.isFinite(tab.id)) return tab.id;
    } catch {
      // 标签页已被用户关闭，落到新建分支
    }
  }

  const created = await chrome.tabs.create({ url });
  if (Number.isFinite(created.id)) await setGalleryTabId(created.id);
  return created.id;
}

// ---------------------------------------------------------------- 消息路由

/** 内容脚本把采集结果交上来。 */
async function handleScanResult(sender, payload) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!Number.isFinite(tabId) || !payload) return;

  const { openGallery, ...record } = payload;
  const saved = await saveScan(tabId, record);

  if (!saved.ok) {
    await showFailureBadge(tabId);
    return;
  }

  await showCountBadge(tabId, (record.items || []).length);
  if (openGallery) await openGalleryTab(tabId);
}

async function handleScanError(sender, message) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!Number.isFinite(tabId)) return;
  await showFailureBadge(tabId);
  void message;
}

/** 图库页面要求重新扫描原标签页。 */
async function handleRescanRequest(requestedTabId) {
  const tabId = Number(requestedTabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: '缺少标签页 id' };

  const known = await getScan(tabId);
  if (!known) return { ok: false, error: '找不到该标签页的采集记录' };

  const result = await collectIn(tabId, { openGallery: false });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case MSG.SCAN_RESULT:
      handleScanResult(sender, message.payload).catch(() => {});
      sendResponse({ ok: true });
      return undefined;

    case MSG.SCAN_ERROR:
      handleScanError(sender, message.error).catch(() => {});
      sendResponse({ ok: true });
      return undefined;

    case MSG.RESCAN_REQUEST:
      handleRescanRequest(message.tabId).then(sendResponse, (error) =>
        sendResponse({ ok: false, error: String((error && error.message) || error) }),
      );
      return true; // 异步响应

    default:
      return undefined;
  }
});

// ---------------------------------------------------------------- 入口动作

chrome.action.onClicked.addListener((tab) => {
  if (tab && Number.isFinite(tab.id)) {
    collectIn(tab.id, { openGallery: true }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_PAGE) return;
  if (tab && Number.isFinite(tab.id)) {
    collectIn(tab.id, { openGallery: true }).catch(() => {});
  }
});

/** 页面跳转后旧结果已失效，清掉角标但保留记录（用户可能还要下载已采集的图）。 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setBadge(tabId, '').catch(() => {});
  }
});
