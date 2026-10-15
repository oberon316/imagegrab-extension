/**
 * content/content.js —— 内容脚本入口。
 *
 * 负责把各部分串起来：
 *   tools（工具） + collector（采集） + ui（浮层）
 * 并对外提供两条通道：
 *   1. 页面上点击"获取图片"按钮；
 *   2. 后台 Service Worker 通过消息要求采集（工具栏图标、右键菜单、图库里的"重新扫描"）。
 *
 * 动态页面适配：页面不重新加载而只改地址（SPA 路由）时，靠定时自检重新判断
 * 是否该显示按钮；按钮宿主被页面框架删除时同样由自检补挂。
 */
(function () {
  'use strict';

  const NS = (window.__ImageGrab = window.__ImageGrab || {});
  if (NS.__booted) return; // 防止同一文档被注入两次
  NS.__booted = true;
  const { MSG } = NS.tools;

  const SETTINGS_KEY = 'ig:settings';
  const SELF_CHECK_INTERVAL_MS = 1500;

  let scanning = false;
  let lastHref = location.href;

  function sendToBackground(message) {
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
        // 扩展被重新加载后旧的内容脚本会失去上下文
        resolve({ ok: false, error: String((error && error.message) || error) });
      }
    });
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      return stored && stored[SETTINGS_KEY] ? stored[SETTINGS_KEY] : {};
    } catch {
      return {};
    }
  }

  /**
   * 执行一次采集并把结果交给后台保管。
   * @param {{openGallery?: boolean}} [options]
   */
  async function requestScan(options = {}) {
    const openGallery = options.openGallery !== false;
    if (scanning) return { ok: false, error: '正在采集中' };

    scanning = true;
    NS.ui.setStatus('scanning');
    try {
      const settings = await loadSettings();
      const result = await NS.collector.scan(
        { includeInlineData: settings.includeInlineData === true },
        (progress) => NS.ui.setProgress(progress),
      );

      const delivered = await sendToBackground({
        type: MSG.SCAN_RESULT,
        payload: { ...result, openGallery },
      });

      NS.ui.setStatus('done', result);

      if (!delivered.ok) {
        NS.ui.toast(`采集完成，但结果未能交给扩展后台：${delivered.error || '未知原因'}`, 'error', 8000);
        return { ok: false, error: delivered.error };
      }

      if (result.items.length === 0) {
        NS.ui.toast('未在本页找到图片。若这是懒加载页面，请向下滚动后重试。', 'warn', 6000);
      } else if (result.pendingCount > 0) {
        NS.ui.toast(
          `检测到 ${result.pendingCount} 张图片尚未加载。请向下滚动页面让它们加载，再点"重新采集"。`,
          'warn',
          8000,
        );
      } else if (result.warnings.length) {
        NS.ui.toast(result.warnings[0].message, 'warn', 6000);
      } else {
        NS.ui.toast(`已采集 ${result.items.length} 张图片，正在打开图库…`, 'info', 4000);
      }

      return { ok: true, total: result.items.length, pending: result.pendingCount };
    } catch (error) {
      const message = String((error && error.message) || error);
      NS.ui.setStatus('error');
      NS.ui.toast(`采集失败：${message}`, 'error', 8000);
      await sendToBackground({ type: MSG.SCAN_ERROR, error: message });
      return { ok: false, error: message };
    } finally {
      scanning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === MSG.PING) {
      sendResponse({ ok: true, ready: true, site: NS.tools.matchSite(location.href).site });
      return undefined;
    }

    if (message.type === MSG.SCAN_REQUEST) {
      requestScan({ openGallery: message.openGallery !== false });
      sendResponse({ ok: true, started: true });
      return undefined;
    }

    return undefined;
  });

  // 首次进入与后续自检
  NS.ui.sync();
  window.setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
    }
    NS.ui.sync();
  }, SELF_CHECK_INTERVAL_MS);

  NS.controller = { requestScan };
})();
