/**
 * lib/settings.js —— 用户设置的读写。
 *
 * 设置存在 chrome.storage.local（不需要跨设备同步，且商品图偏好属于本机习惯）。
 * content/content.js 里有一份等价的 SETTINGS_KEY 字面量，因为内容脚本无法 import；
 * check.mjs 会校验两处的键名一致。
 */

export const SETTINGS_KEY = 'ig:settings';

export const DEFAULT_SETTINGS = Object.freeze({
  /** 是否把 data: 内联图也纳入结果（默认否：详情页占位图太多） */
  includeInlineData: false,
  /** 图库中的最小宽/高筛选，单位为像素 */
  minWidth: 0,
  minHeight: 0,
  /** 同时进行的下载任务数。设为 2 是为了让"逐项错误"更容易复现，也避免触发浏览器限速 */
  concurrency: 2,
  /** 单张图片从取回到下载完成的超时（毫秒） */
  timeoutMs: 120000,
});

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
