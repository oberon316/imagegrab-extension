/* 官网交互：导航、截图预览、复制反馈与发布清单。不拦截文件下载。 */
(function () {
  'use strict';
  var toastTimer;
  function toast(message) {
    var node = document.querySelector('.toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('is-visible'); }, 3500);
  }
  function initNav() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.querySelector('.nav');
    if (!toggle || !nav) return;
    function close() {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', '打开导航菜单');
    }
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    });
    nav.querySelectorAll('a').forEach(function (link) { link.addEventListener('click', close); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    document.addEventListener('click', function (event) {
      if (!nav.contains(event.target) && !toggle.contains(event.target)) close();
    });
    var breakpoint = window.matchMedia('(min-width: 701px)');
    if (breakpoint.addEventListener) breakpoint.addEventListener('change', close);
  }
  function initLightbox() {
    var box = document.querySelector('dialog.lightbox');
    if (!box || typeof box.showModal !== 'function') return;
    var picture = box.querySelector('img');
    var caption = box.querySelector('figcaption');
    var trigger;
    document.querySelectorAll('[data-lightbox]').forEach(function (button) {
      button.addEventListener('click', function () {
        trigger = button;
        var description = button.getAttribute('data-alt') || '插件界面截图';
        picture.src = button.getAttribute('data-src');
        picture.alt = description;
        caption.textContent = description;
        box.showModal();
        document.body.classList.add('modal-open');
      });
    });
    box.querySelector('.lb-close').addEventListener('click', function () { box.close(); });
    box.addEventListener('click', function (event) {
      if (event.target !== box) return;
      var rect = box.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) box.close();
    });
    box.addEventListener('close', function () {
      document.body.classList.remove('modal-open');
      if (trigger) trigger.focus();
    });
  }
  function copyText(text) {
    function fallback() {
      var active = document.activeElement;
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(textarea);
      textarea.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* 显示失败反馈 */ }
      textarea.remove();
      if (active && active.focus) active.focus();
      return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(fallback);
    }
    return Promise.resolve(fallback());
  }
  function initCopy() {
    document.querySelectorAll('[data-copy], [data-copy-ref]').forEach(function (button) {
      button.addEventListener('click', function () {
        var target = document.getElementById(button.getAttribute('data-copy-ref'));
        var value = button.getAttribute('data-copy') || (target && target.textContent.trim());
        if (!value) return;
        copyText(value).then(function (ok) {
          toast(ok ? (target ? '校验值已复制' : '地址已复制，请粘贴到浏览器地址栏') : '复制未成功，请手动选中并复制');
        });
      });
    });
  }
  function loadReleaseInfo() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    fetch('./downloads/manifest.json', { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('发布清单不可用'); return response.json(); })
      .then(function (data) {
        document.querySelectorAll('[data-release]').forEach(function (element) {
          var key = element.getAttribute('data-release');
          if (data[key] !== undefined) element.textContent = key === 'version' ? 'v' + data[key] : String(data[key]);
        });
        if (typeof data.file === 'string' && /^imagegrab-v[0-9]+\.[0-9]+\.[0-9]+\.zip$/.test(data.file)) {
          document.querySelectorAll('a[data-download]').forEach(function (link) {
            link.setAttribute('href', './downloads/' + data.file);
            link.setAttribute('download', data.file);
          });
        }
      })
      .catch(function () { /* 清单不可用时保留静态信息与链接。 */ });
  }
  function init() {
    initNav(); initLightbox(); initCopy(); loadReleaseInfo();
    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());
    document.querySelectorAll('[data-download]').forEach(function (link) {
      link.addEventListener('click', function () { toast('浏览器将开始下载 ZIP，解压后请按安装指南加载。'); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
