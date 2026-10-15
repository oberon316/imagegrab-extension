/**
 * content/ui.js —— 注入到商品详情页右下角的"获取图片"浮层。
 *
 * 实现要点：
 *  - 用 Shadow DOM 隔离样式，避免与商家页面互相污染；
 *  - 用 Constructable Stylesheet（adoptedStyleSheets）承载样式，不往页面插入 <style>，
 *    因此不受页面 CSP 影响，也能正常使用 :hover / :focus-visible；
 *  - 不使用任何内联事件属性，全部 addEventListener；
 *  - 重复注入由"宿主节点是否存在 + 模块标记 + 定时自检"三重保护。
 */
(function () {
  'use strict';

  const NS = (window.__ImageGrab = window.__ImageGrab || {});
  if (NS.ui) return;
  const { PALETTE, matchSite } = NS.tools;

  const HOST_ID = 'imagegrab-fab-host';
  const LABEL_IDLE = '获取图片';
  const LABEL_SCANNING = '采集中…';
  const LABEL_AGAIN = '重新采集';
  const LABEL_ERROR = '重试采集';

  const CSS_TEXT = `
:host { all: initial; }
.wrap {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  color: ${PALETTE.ink};
}
.toast {
  max-width: 300px;
  padding: 8px 12px;
  border-radius: 10px;
  background: ${PALETTE.cream};
  border: 1px solid ${PALETTE.gold};
  box-shadow: 0 6px 18px rgba(11, 42, 39, 0.18);
  color: ${PALETTE.ink};
  font-size: 13px;
  word-break: break-word;
}
.toast[data-kind="warn"], .toast[data-kind="error"] {
  border-color: ${PALETTE.caramel};
  background: #FBF1E7;
}
.toast[hidden] { display: none; }
.fab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid ${PALETTE.gold};
  border-radius: 999px;
  background: ${PALETTE.teal};
  color: ${PALETTE.cream};
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(10, 70, 64, 0.28);
  transition: background-color 120ms ease, transform 120ms ease;
}
.fab:hover { background: ${PALETTE.tealDeep}; }
.fab:active { transform: translateY(1px); }
.fab:focus-visible { outline: 3px solid ${PALETTE.gold}; outline-offset: 2px; }
.fab[disabled] { cursor: progress; opacity: 0.85; }
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${PALETTE.gold};
  flex: 0 0 auto;
}
.count {
  padding: 1px 7px;
  border-radius: 999px;
  background: ${PALETTE.caramel};
  color: ${PALETTE.cream};
  font-size: 12px;
  font-weight: 700;
}
.count[hidden] { display: none; }
`;

  let host = null;
  let root = null;
  let button = null;
  let labelEl = null;
  let countEl = null;
  let toastEl = null;
  let toastTimer = 0;
  let status = 'idle';

  function buildStyles() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    return sheet;
  }

  function build() {
    root = host.attachShadow({ mode: 'open' });
    try {
      root.adoptedStyleSheets = [buildStyles()];
    } catch {
      // 极旧内核的兜底；Chrome 120+ 走上面的分支
      const style = document.createElement('style');
      style.textContent = CSS_TEXT;
      root.appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.hidden = true;

    button = document.createElement('button');
    button.className = 'fab';
    button.type = 'button';
    button.setAttribute('aria-label', LABEL_IDLE);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = LABEL_IDLE;

    countEl = document.createElement('span');
    countEl.className = 'count';
    countEl.hidden = true;

    button.append(dot, labelEl, countEl);
    button.addEventListener('click', () => {
      const controller = window.__ImageGrab && window.__ImageGrab.controller;
      if (controller && typeof controller.requestScan === 'function') {
        controller.requestScan().catch(() => {});
      }
    });

    wrap.append(toastEl, button);
    root.appendChild(wrap);
  }

  function mount() {
    if (host && host.isConnected) return;
    if (!host) {
      const existing = document.getElementById(HOST_ID);
      host = existing || document.createElement('div');
      if (!existing) {
        host.id = HOST_ID;
        host.style.cssText = 'all: initial;';
      }
      if (!host.shadowRoot) build();
      else {
        // 复用页面里已存在的宿主（脚本被重复注入的情况）
        root = host.shadowRoot;
        button = root.querySelector('.fab');
        labelEl = root.querySelector('.label');
        countEl = root.querySelector('.count');
        toastEl = root.querySelector('.toast');
        if (button && !button.dataset.bound) {
          button.dataset.bound = '1';
          button.addEventListener('click', () => {
            const controller = window.__ImageGrab && window.__ImageGrab.controller;
            if (controller && typeof controller.requestScan === 'function') controller.requestScan().catch(() => {});
          });
        }
      }
    }
    document.documentElement.appendChild(host);
    applyStatus();
  }

  function unmount() {
    if (host && host.isConnected) host.remove();
  }

  function applyStatus() {
    if (!button || !labelEl || !countEl) return;
    button.disabled = status === 'scanning';
    if (status === 'scanning') {
      labelEl.textContent = LABEL_SCANNING;
    } else if (status === 'done') {
      labelEl.textContent = LABEL_AGAIN;
    } else if (status === 'error') {
      labelEl.textContent = LABEL_ERROR;
    } else {
      labelEl.textContent = LABEL_IDLE;
    }
    button.setAttribute('aria-label', labelEl.textContent);
  }

  /** 页面地址变化或 DOM 被改动时的自检：决定按钮该显示、隐藏还是补挂。 */
  function sync() {
    if (window.top !== window.self) return; // 只挂在顶层文档
    const { isDetail } = matchSite(location.href);
    if (!isDetail) {
      unmount();
      return;
    }
    mount();
  }

  function setStatus(next, result) {
    status = next;
    applyStatus();
    if (next === 'done' && result) {
      const total = result.items.length;
      countEl.textContent = String(total);
      countEl.hidden = total === 0;
      countEl.setAttribute('aria-label', `共 ${total} 张`);
    }
    if (next === 'idle') {
      countEl.hidden = true;
    }
  }

  function setProgress(progress) {
    if (!labelEl || status !== 'scanning') return;
    const total = progress.total || 0;
    labelEl.textContent = total
      ? `采集中 ${Math.min(progress.scanned + 1, total)}/${total}`
      : `采集中 已找到 ${progress.found}`;
  }

  function toast(text, kind = 'info', duration = 4000) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.dataset.kind = kind;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, duration);
  }

  NS.ui = { sync, setStatus, setProgress, toast, get mounted() { return Boolean(host && host.isConnected); } };
})();
