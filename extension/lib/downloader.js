/**
 * lib/downloader.js —— 批量下载调度（在 gallery 页面里运行）。
 *
 * 每张图片的生命周期：
 *   取图 → 转 PNG → createObjectURL → chrome.downloads.download（下载开始）
 *   → onChanged(state=complete)（下载完成）→ revokeObjectURL（释放 Blob URL）
 *
 * 三条硬性约定：
 *  1. Blob URL 必须在下载**结束之后**才释放，提前释放会让下载失败；
 *  2. 任何一张失败都不中断整个任务，失败原因逐项记录；
 *  3. Service Worker 里不能用 URL.createObjectURL，所以下载一定由本模块所在的
 *     扩展页面驱动，后台只负责把用户送到这里。
 */

import { processImage } from './image-processor.js';

/** 单张图片对外暴露的状态。 */
export const ITEM_STATE = Object.freeze({
  PENDING: 'pending',
  CONVERTING: 'converting',
  DOWNLOADING: 'downloading',
  DONE: 'done',
  FAILED: 'failed',
});

/** chrome.downloads.onChanged 里可能出现的中断原因，翻译成中文便于用户判断。 */
const INTERRUPT_REASONS = Object.freeze({
  FILE_FAILED: '写入文件失败',
  FILE_ACCESS_DENIED: '没有写入权限',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_NAME_TOO_LONG: '文件名过长',
  FILE_TOO_LARGE: '文件过大',
  FILE_VIRUS_INFECTED: '文件被安全软件判定为风险',
  FILE_TRANSIENT_ERROR: '写入时发生临时错误',
  FILE_BLOCKED: '文件被策略阻止',
  FILE_SECURITY_CHECK_FAILED: '安全校验失败',
  FILE_TOO_SHORT: '文件内容不完整',
  NETWORK_FAILED: '网络错误',
  NETWORK_TIMEOUT: '网络超时',
  NETWORK_DISCONNECTED: '网络已断开',
  NETWORK_SERVER_DOWN: '服务器不可用',
  NETWORK_INVALID_REQUEST: '请求无效',
  SERVER_FAILED: '服务器错误',
  SERVER_BAD_CONTENT: '服务器返回的内容无法识别',
  SERVER_UNAUTHORIZED: '服务器拒绝访问',
  SERVER_CERT_PROBLEM: '服务器证书有问题',
  SERVER_FORBIDDEN: '服务器禁止访问',
  USER_CANCELED: '用户取消',
  USER_SHUTDOWN: '浏览器正在退出',
  CRASH: '下载进程崩溃',
});

function describeInterrupt(reason) {
  if (!reason) return '下载被中断';
  return INTERRUPT_REASONS[reason] ? `${INTERRUPT_REASONS[reason]}（${reason}）` : `下载被中断（${reason}）`;
}

/**
 * 创建一个下载器实例。
 *
 * @param {object} [options]
 * @param {number} [options.concurrency] 同时进行的下载数
 * @param {number} [options.timeoutMs] 单张从取图到完成的超时
 * @param {(event: object) => void} [options.onEvent] 事件回调，事件类型见下方 emit 调用
 */
export function createDownloader(options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency) || 2);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  /** @type {Map<number, {id:number, settle:(error?: Error)=>void, timer:number}>} */
  const waiters = new Map();

  function settleWaiter(waiter, error) {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.settle(error);
  }

  function handleChanged(delta) {
    const waiter = waiters.get(delta.id);
    if (!waiter) return;
    const state = delta.state && delta.state.current;
    if (state === 'complete') {
      waiters.delete(delta.id);
      settleWaiter(waiter, null);
    } else if (state === 'interrupted') {
      waiters.delete(delta.id);
      settleWaiter(waiter, new Error(describeInterrupt(delta.error && delta.error.current)));
    }
  }

  function handleErased(downloadId) {
    const waiter = waiters.get(downloadId);
    if (!waiter) return;
    waiters.delete(downloadId);
    settleWaiter(waiter, new Error('下载记录在使用者手动清除后消失'));
  }

  chrome.downloads.onChanged.addListener(handleChanged);
  chrome.downloads.onErased.addListener(handleErased);

  /** 调用 chrome.downloads.download，并把 downloadId 同步登记进 waiters。 */
  function startDownload(downloadOptions, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new Error('任务已取消'));
        return;
      }
      chrome.downloads.download(downloadOptions, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(`无法开始下载：${error.message}`));
          return;
        }
        if (!Number.isFinite(downloadId)) {
          reject(new Error('无法开始下载：未返回下载 id'));
          return;
        }
        // 关键：在 download() 的回调里同步登记，避免 onChanged 比登记更早到达
        const waiter = { id: downloadId, settled: false, settle: () => {}, timer: 0 };
        waiter.timer = setTimeout(() => {
          waiters.delete(downloadId);
          settleWaiter(waiter, new Error(`等待下载完成超时（${timeoutMs}ms）`));
        }, timeoutMs);
        waiters.set(downloadId, waiter);
        resolve({ downloadId, waiter });
      });
    });
  }

  function waitForCompletion(waiter, signal) {
    return new Promise((resolve, reject) => {
      waiter.settle = (error) => (error ? reject(error) : resolve());
      if (signal) {
        const onAbort = () => {
          // 取消只是不再等待；已开始的下载交给浏览器完成
          waiters.delete(waiter.id);
          reject(new Error('任务已取消'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * 处理一张图片。
   * @returns {Promise<{ok: boolean, index: number, item: object, filename: string, error?: string}>}
   */
  async function runOne(entry, index, signal) {
    const base = { index, item: entry.item, filename: entry.filename, url: entry.item.url };
    let blobUrl = '';

    try {
      onEvent({ type: 'prepare', state: ITEM_STATE.CONVERTING, ...base });
      const processed = await processImage(entry.item.url, { signal, timeoutMs });
      blobUrl = URL.createObjectURL(processed.blob);

      const { downloadId, waiter } = await startDownload(
        {
          url: blobUrl,
          filename: entry.filename,
          conflictAction: 'uniquify',
          saveAs: false,
        },
        signal,
      );

      onEvent({
        type: 'start',
        state: ITEM_STATE.DOWNLOADING,
        ...base,
        downloadId,
        bytes: processed.blob.size,
        sourceType: processed.sourceType,
        converted: processed.converted,
      });

      await waitForCompletion(waiter, signal);

      onEvent({
        type: 'done',
        state: ITEM_STATE.DONE,
        ...base,
        downloadId,
        bytes: processed.blob.size,
        sourceType: processed.sourceType,
        converted: processed.converted,
      });

      return {
        ok: true,
        index,
        item: entry.item,
        filename: entry.filename,
        url: entry.item.url,
        downloadId,
        bytes: processed.blob.size,
        sourceType: processed.sourceType,
        converted: processed.converted,
        scaled: processed.scaled,
        note: processed.note,
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      onEvent({ type: 'error', state: ITEM_STATE.FAILED, ...base, error: message });
      return { ok: false, index, item: entry.item, filename: entry.filename, url: entry.item.url, error: message };
    } finally {
      // 需求要求 Blob URL 在下载结束后才释放：成功、失败、取消都走到这里
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  /**
   * 批量执行。返回的结果数组与传入顺序一致；任何一项失败都不影响其它项。
   *
   * @param {Array<{item: object, filename: string}>} entries
   * @param {{signal?: AbortSignal}} [runOptions]
   */
  async function run(entries, runOptions = {}) {
    const signal = runOptions.signal;
    const results = new Array(entries.length);
    let cursor = 0;

    async function worker() {
      while (cursor < entries.length) {
        if (signal && signal.aborted) return;
        const index = cursor;
        cursor += 1;
        results[index] = await runOne(entries[index], index, signal);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, entries.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  function dispose() {
    chrome.downloads.onChanged.removeListener(handleChanged);
    chrome.downloads.onErased.removeListener(handleErased);
    for (const waiter of waiters.values()) clearTimeout(waiter.timer);
    waiters.clear();
  }

  return { run, dispose, concurrency, timeoutMs };
}
