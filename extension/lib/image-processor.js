/**
 * lib/image-processor.js —— 取图与"真正的 PNG 转换"。
 *
 * 只能在具备 DOM 的扩展页面（gallery）里调用，绝不能被 Service Worker 引用：
 * 这里用到 document / HTMLCanvasElement / createImageBitmap / URL.createObjectURL，
 * MV3 的 Service Worker 全都没有。check.mjs 会顺着 import 链检查这一点。
 *
 * 关于"真转换"：JPG / WebP / BMP / GIF 会被浏览器解码后画进 <canvas>，
 * 再由 canvas.toBlob(type='image/png') 重新编码，得到的是货真价实的 PNG 字节流；
 * 最后再校验一遍 PNG magic number。只改后缀的做法在这里是不可能通过的。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 画布单边上限（Chromium 实际限制），超过就等比缩小。 */
const MAX_CANVAS_SIDE = 16384;
/** 画布总像素上限，防止超大图直接把标签页内存撑爆。 */
const MAX_CANVAS_PIXELS = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;

/**
 * 取回图片原始字节。
 *
 * 在扩展页面里带上 host_permissions 发起请求，属于跨域特权请求，不受页面 CORS 限制。
 * credentials 采用 'omit'：商品图 CDN（alicdn / 360buyimg / pddpic）都是公开资源，
 * 不带 Cookie 也能取到，少发一份凭据更安全。
 *
 * @param {string} url
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<Blob>}
 */
export async function fetchImageBlob(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`取图超时（${timeoutMs}ms）`, 'TimeoutError'));
  }, timeoutMs);
  const external = options.signal;
  const forwardAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) forwardAbort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: controller.signal,
      cache: 'default',
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`服务器返回 HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) {
      throw new Error('图片内容为空');
    }
    await assertNotHtmlError(blob);
    return blob;
  } catch (error) {
    throw explainFetchError(error, url);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', forwardAbort);
  }
}

/** 从地址里取出主机名，用于给出"是哪个域名出问题"的可读提示。 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '未知地址');
  }
}

/**
 * fetch 失败时给出一句能指导用户的话。
 *
 * 为什么需要这一步：跨域取图失败时浏览器只抛一句 `TypeError: Failed to fetch`，
 * 完全看不出是网络问题、图片服务器拒绝，还是该域名不在扩展的 host_permissions 里
 * （这恰恰是最常见的一种，见 manifest.json 的主机权限清单）。
 */
function explainFetchError(error, url) {
  if (!(error instanceof TypeError)) return error;
  return new Error(
    `无法取回图片（${hostOf(url)}）：网络不通，或该图片所在域名不在扩展的访问权限内`,
  );
}

/**
 * 有些 CDN 出错时会返回 200 + HTML 错误页。若直接画进 canvas 只会得到一句
 * 无从下手的 "解码失败"，这里提前给出可读的原因。
 */
async function assertNotHtmlError(blob) {
  const sniff = await blob.slice(0, 128).text().catch(() => '');
  const head = sniff.trimStart().slice(0, 40).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('{')) {
    throw new Error('返回的不是图片（疑似错误页或接口响应）');
  }
}

/** 判断 Blob 是否以 PNG magic number 开头。 */
async function isPngEncoded(blob) {
  if (blob.size < 8) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return PNG_SIGNATURE.every((byte, index) => head[index] === byte);
}

/** 兜底断言：交给 chrome.downloads 的字节必须真的是 PNG。 */
async function assertPngEncoded(blob) {
  if (!(await isPngEncoded(blob))) {
    throw new Error('转换结果不是 PNG 编码（已阻止下载，避免生成假 .png 文件）');
  }
}

/**
 * 把任意浏览器可解码的图片转成可绘制对象。
 * createImageBitmap 不支持 SVG，此时退回 <img> + 临时 Object URL。
 */
async function decodeToDrawable(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // 落到 <img> 分支
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('浏览器无法解码该图片格式')), { once: true });
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    // 这个临时 Object URL 只用于解码，用完立即释放；与下载用的 Blob URL 是两回事
    release: () => URL.revokeObjectURL(objectUrl),
  };
}

/**
 * 转成 PNG。
 *
 * @param {Blob} blob 原始图片
 * @param {{maxSide?: number, maxPixels?: number}} [options]
 * @returns {Promise<{blob: Blob, converted: boolean, scaled: boolean, width: number, height: number, note: string}>}
 */
export async function convertToPng(blob, options = {}) {
  const maxSide = Number.isFinite(options.maxSide) ? options.maxSide : MAX_CANVAS_SIDE;
  const maxPixels = Number.isFinite(options.maxPixels) ? options.maxPixels : MAX_CANVAS_PIXELS;
  const sourceType = String(blob.type || '').toLowerCase();

  const drawable = await decodeToDrawable(blob);
  try {
    const naturalWidth = drawable.width;
    const naturalHeight = drawable.height;
    if (!naturalWidth || !naturalHeight) {
      throw new Error('图片尺寸为 0，无法转换');
    }

    const scale = Math.min(
      1,
      maxSide / naturalWidth,
      maxSide / naturalHeight,
      Math.sqrt(maxPixels / (naturalWidth * naturalHeight)),
    );
    const scaled = scale < 1;
    const targetWidth = scaled ? Math.max(1, Math.floor(naturalWidth * scale)) : naturalWidth;
    const targetHeight = scaled ? Math.max(1, Math.floor(naturalHeight * scale)) : naturalHeight;

    if (sourceType === 'image/png' && !scaled) {
      // 源文件本来就是 PNG 编码，直接沿用原始字节。
      // 文件内容确实是 PNG，因此仍然满足"不能只改后缀"的要求，同时避免重编码损失。
      await assertPngEncoded(blob);
      return {
        blob,
        converted: false,
        scaled: false,
        width: naturalWidth,
        height: naturalHeight,
        note: '源文件已是 PNG 编码，未重新编码',
      };
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 2D 画布上下文');
    context.drawImage(drawable.source, 0, 0, targetWidth, targetHeight);

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('PNG 编码失败'));
      }, 'image/png');
    });

    // 大图很占内存，转换完立刻把画布清空
    canvas.width = 0;
    canvas.height = 0;

    if (pngBlob.type !== 'image/png') {
      throw new Error(`浏览器返回的编码不是 PNG（${pngBlob.type || '未知'}）`);
    }
    await assertPngEncoded(pngBlob);

    return {
      blob: pngBlob,
      converted: true,
      scaled,
      width: targetWidth,
      height: targetHeight,
      note: scaled ? `原图 ${naturalWidth}×${naturalHeight} 超出画布上限，已等比缩小` : '',
    };
  } finally {
    drawable.release();
  }
}

/**
 * 完整流程：取图 → 转 PNG。
 * @param {string} url
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxSide?: number, maxPixels?: number}} [options]
 */
export async function processImage(url, options = {}) {
  const blob = await fetchImageBlob(url, options);
  const sourceType = String(blob.type || '').toLowerCase() || '未知';
  const converted = await convertToPng(blob, options);
  return {
    blob: converted.blob,
    sourceBytes: blob.size,
    sourceType,
    converted: converted.converted,
    scaled: converted.scaled,
    width: converted.width,
    height: converted.height,
    note: converted.note,
  };
}
