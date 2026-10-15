/**
 * lib/url-utils.js —— URL 与文件名工具（扩展页面 / Service Worker 使用）。
 *
 * 这里的 toAbsoluteUrl / normalizeUrl / parseSrcset 与 content/url-tools.js 中的同名函数
 * 是刻意重复的实现：内容脚本不能静态 import ES 模块。两份行为一致性由
 * tests/unit.test.mjs 用同一批用例双向校验，任何一侧改了行为都会测试失败。
 */

export const DOWNLOAD_PREFIX = '商品图';
export const PNG_EXTENSION = 'png';

/**
 * 补全相对/协议相对地址。
 * @param {string} raw
 * @param {string} [base]
 * @returns {string} 无法解析时返回空字符串
 */
export function toAbsoluteUrl(raw, base) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s.replace(/^url\((.*)\)$/i, '$1').trim();
  s = s.replace(/^['"]|['"]$/g, '').trim();
  if (!s || s === 'none') return '';
  if (s.startsWith('//')) s = 'https:' + s;
  try {
    return new URL(s, base || 'https://example.invalid/').href;
  } catch {
    return '';
  }
}

/**
 * 去重用的规范形式：去掉 hash，保留查询串。
 *
 * 保留查询串是刻意的：CDN 常用 ?width=800 这类参数选择实际尺寸，
 * 全删会把 800 与 1200 两个不同文件误判成同一张。
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '');
  }
}

/**
 * 解析 srcset / image-set 候选列表。
 * @returns {Array<{url: string, descriptor: string}>}
 */
export function parseSrcset(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  let current = null;
  for (const rawToken of text.split(/\s+/)) {
    let token = rawToken.trim();
    if (!token) continue;

    // 'a.png 1x,b.png 2x' 这种逗号后没有空格的写法也是合法的，先把它拆开
    const merged = /^(\d+(?:\.\d+)?[wx]),(.+)$/i.exec(token);
    if (merged) {
      if (current) {
        current.descriptor = merged[1];
        out.push(current);
        current = null;
      }
      token = merged[2];
    } else if (/^\d+(\.\d+)?[wx],?$/i.test(token)) {
      // 描述符后面直接跟分隔逗号（"a.png 1x, b.png 2x" 分词后是 "1x,"）
      if (current) {
        current.descriptor = token.replace(/,$/, '');
        out.push(current);
        current = null;
      }
      continue;
    }

    let url = token;
    let trailingComma = false;
    if (url.endsWith(',')) {
      url = url.slice(0, -1);
      trailingComma = true;
    }
    if (current) {
      out.push(current);
      current = null;
    }
    if (url) current = { url, descriptor: '' };
    if (trailingComma && current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * 生成下载文件名：商品图_001.png
 *
 * 编号按图库中的显示顺序，从 1 开始；位数至少 3 位，条目超过 999 时自动加宽，
 * 以便文件管理器按名称排序时顺序正确。
 *
 * @param {number} index 从 1 开始
 * @param {{total?: number, prefix?: string}} [options]
 */
export function buildPngFilename(index, options = {}) {
  const prefix = options.prefix || DOWNLOAD_PREFIX;
  const total = Number.isFinite(options.total) ? options.total : index;
  const pad = Math.max(3, String(Math.max(total, index)).length);
  const serial = String(Math.max(1, Math.trunc(index))).padStart(pad, '0');
  return `${prefix}_${serial}.${PNG_EXTENSION}`;
}

/** 从 URL 猜测扩展名（仅用于界面上展示"原格式"，不参与命名）。 */
export function guessExtension(url) {
  try {
    const pathname = new URL(url, 'https://example.invalid/').pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
