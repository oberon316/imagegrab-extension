/**
 * lib/messaging.js —— 消息类型与收发封装（供后台 Service Worker 与扩展页面使用）。
 *
 * 注意：内容脚本无法静态 import ES 模块，它使用的是 content/url-tools.js 里
 * 一份内容相同的 MSG 定义。两者的一致性由 tests/unit.test.mjs 校验。
 */

/** 消息类型常量。必须与 extension/content/url-tools.js 中的 MSG 完全一致。 */
export const MSG = Object.freeze({
  PING: 'ig:ping',
  SCAN_REQUEST: 'ig:scan-request',
  SCAN_RESULT: 'ig:scan-result',
  SCAN_ERROR: 'ig:scan-error',
  RESCAN_REQUEST: 'ig:rescan-request',
  OPEN_GALLERY: 'ig:open-gallery',
});

/** 统一的采集结果来源标记，便于排查"这条结果是谁给的"。 */
export const SOURCE_ACTIONS = Object.freeze({
  CONTENT_BUTTON: 'content-button',
  TOOLBAR: 'toolbar',
  CONTEXT_MENU: 'context-menu',
  GALLERY_RESCAN: 'gallery-rescan',
});

/**
 * 给后台发消息，永不抛异常，出错时返回 {ok:false, error}。
 * @param {object} message
 */
export function sendToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response || { ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String((error && error.message) || error) });
    }
  });
}

/**
 * 给某个标签页的内容脚本发消息。
 * 内容脚本尚未注入时 Chrome 会报 "Receiving end does not exist"，这里统一转成 {ok:false}。
 */
export function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response || { ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String((error && error.message) || error) });
    }
  });
}
