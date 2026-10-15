/**
 * lib/session.js —— 采集结果的会话存储。
 *
 * 为什么不用 Service Worker 的全局变量：MV3 的 Service Worker 会在空闲约 30 秒后
 * 被强制回收，全局变量随之消失；而"采集结果"需要活得比它久（用户可能过几分钟
 * 才回到图库页面下载）。因此结果一律写入 chrome.storage.session：
 *  - 它在浏览器会话内保持，重启浏览器后自动清空，不会把商品图地址长期留在磁盘上；
 *  - 默认只对可信上下文（Service Worker 与扩展页面）可见，页面脚本读不到。
 *
 * 键约定（内容脚本也用到同一套前缀，见 content/content.js 的 SETTINGS_KEY）：
 *   ig:scan:<tabId>   某个标签页最近一次采集结果
 *   ig:active         最近一次采集所属的 tabId
 *   ig:gallery-tab    图库页面所在标签页 id，用于复用而不是反复打开新标签
 */
import { SETTINGS_KEY } from './settings.js';

export const SCAN_PREFIX = 'ig:scan:';
export const ACTIVE_KEY = 'ig:active';
export const GALLERY_TAB_KEY = 'ig:gallery-tab';

/** 最多保留几个标签页的采集结果，避免会话存储无限增长。 */
const MAX_RETAINED_SCANS = 3;

/** 存储配额不足时裁剪到多少条。 */
const TRIM_TO_ITEMS = 400;

function area() {
  return chrome.storage.session || chrome.storage.local;
}

function areaName() {
  return chrome.storage.session ? 'session' : 'local';
}

/** 会话存储不可用时（理论上不会，Chrome 120+ 都有）退回本地存储。 */
export function isUsingSessionArea() {
  return areaName() === 'session';
}

/**
 * 保存一次采集结果。
 * @param {number} tabId
 * @param {object} payload collector.scan() 的返回值
 * @returns {Promise<{ok: boolean, trimmed: boolean, error?: string}>}
 */
export async function saveScan(tabId, payload) {
  if (!Number.isFinite(tabId)) return { ok: false, trimmed: false, error: '缺少标签页 id' };
  const key = SCAN_PREFIX + tabId;
  const record = { ...payload, tabId, savedAt: Date.now() };

  try {
    await area().set({ [key]: record, [ACTIVE_KEY]: tabId });
  } catch (error) {
    // 常见原因：结果太多超出会话存储配额。裁掉一部分再存，界面会提示"已裁剪"。
    try {
      const trimmed = {
        ...record,
        items: record.items.slice(0, TRIM_TO_ITEMS),
        trimmedByStorage: true,
        warnings: [
          ...(record.warnings || []),
          {
            code: 'storage-trimmed',
            message: `采集结果过大，已只保留前 ${TRIM_TO_ITEMS} 张。建议先滚动到需要的区域再采集。`,
          },
        ],
      };
      await area().set({ [key]: trimmed, [ACTIVE_KEY]: tabId });
      return { ok: true, trimmed: true };
    } catch (innerError) {
      return { ok: false, trimmed: false, error: String((innerError && innerError.message) || innerError) };
    }
  }

  await pruneScans(tabId);
  return { ok: true, trimmed: false };
}

/** @returns {Promise<object|null>} */
export async function getScan(tabId) {
  if (!Number.isFinite(tabId)) return null;
  const stored = await area().get(SCAN_PREFIX + tabId);
  return stored[SCAN_PREFIX + tabId] || null;
}

/** 读取最近一次采集结果（图库页在没有 tabId 参数时使用）。 */
export async function getLatestScan() {
  const stored = await area().get([ACTIVE_KEY]);
  const tabId = stored[ACTIVE_KEY];
  if (!Number.isFinite(tabId)) return null;
  return getScan(tabId);
}

/** 删除某个标签页的采集结果。 */
export async function clearScan(tabId) {
  if (!Number.isFinite(tabId)) return;
  await area().remove(SCAN_PREFIX + tabId);
}

/** 只保留最近若干个标签页的结果。 */
async function pruneScans(keepTabId) {
  try {
    const all = await area().get(null);
    const entries = Object.entries(all)
      .filter(([key]) => key.startsWith(SCAN_PREFIX))
      .map(([key, value]) => ({ key, tabId: value && value.tabId, savedAt: (value && value.savedAt) || 0 }))
      .sort((a, b) => b.savedAt - a.savedAt);

    const removable = entries
      .filter((entry, index) => index >= MAX_RETAINED_SCANS && entry.key !== SCAN_PREFIX + keepTabId)
      .map((entry) => entry.key);

    if (removable.length) await area().remove(removable);
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 监听采集结果变化（图库页据此刷新）。
 * @param {(record: object|null, tabId: number) => void} handler
 * @returns {() => void} 取消监听
 */
export function watchScans(handler) {
  const listener = (changes, changedArea) => {
    if (changedArea !== areaName()) return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(SCAN_PREFIX)) continue;
      const tabId = Number(key.slice(SCAN_PREFIX.length));
      handler(change.newValue || null, tabId);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** 记录图库标签页 id，便于复用同一个标签而不是每次新开。 */
export async function setGalleryTabId(tabId) {
  try {
    await area().set({ [GALLERY_TAB_KEY]: tabId });
  } catch {
    /* 忽略 */
  }
}

/** @returns {Promise<number|null>} */
export async function getGalleryTabId() {
  try {
    const stored = await area().get(GALLERY_TAB_KEY);
    const tabId = stored[GALLERY_TAB_KEY];
    return Number.isFinite(tabId) ? tabId : null;
  } catch {
    return null;
  }
}

export { SETTINGS_KEY };
