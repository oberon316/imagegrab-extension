/**
 * scripts/make-image-assets.mjs —— 生成 JPEG / WebP 测试素材。
 *
 *   node scripts/make-image-assets.mjs
 *
 * 生成：
 *   tests/fixtures/assets/sample.jpg   96×96   JPEG 源图
 *   tests/fixtures/assets/sample.webp  96×96   WebP 源图
 *
 * 为什么要借用浏览器：JPEG 与 WebP 的编码器实现量都很大，纯 Node 手写不现实，
 * 而本机上就有 Chrome 的成熟编码器。素材内容取自 make-test-assets.mjs 生成的
 * sample.png，用 canvas 重新编码为 JPEG / WebP —— 因此这两个文件是**真实编码**的
 * JPEG / WebP 字节流，不是改后缀的假货，用来验证"下载时必须真正转成 PNG 编码"。
 *
 * PNG/BMP 素材由 make-test-assets.mjs 生成（那个脚本不需要浏览器）。
 * 没装 Chrome 时本脚本会明确报错并给出替代做法，不会悄悄生成假文件。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, prepareProfile } from './lib/chrome.mjs';
import { Cdp, listTargets, waitUntil } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'tests', 'fixtures', 'assets');
const SOURCE = join(ASSETS, 'sample.png');

const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff],
  webp: null, // WebP 是 RIFF 容器，单独判断
};

function assertJpeg(buffer) {
  for (let i = 0; i < MAGIC.jpeg.length; i += 1) {
    if (buffer[i] !== MAGIC.jpeg[i]) throw new Error('写出的文件不是 JPEG 编码（magic number 不符）');
  }
  // 从 SOF 段里读真实尺寸，确认不是空壳
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG 里找不到 SOF 段');
}

function assertWebp(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('写出的文件不是 WebP 编码（RIFF/WEBP 标记不符）');
  }
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // 扩展格式：flags(1) + reserved(3) + canvas width-1(3, LE) + canvas height-1(3, LE)
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: 0, height: 0 };
}

const profileDir = mkdtempSync(join(tmpdir(), 'ig-assets-profile-'));
prepareProfile(profileDir, null);

console.log('启动本机 Chrome 以借用其 JPEG / WebP 编码器…');
const chrome = await launchChrome({ profileDir, headless: true });

const results = [];
try {
  const target = await waitUntil(
    async () => {
      const list = await listTargets(chrome.port);
      return list.find((item) => item.type === 'page');
    },
    { label: 'Chrome 页面目标', timeoutMs: 20000 },
  );

  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');

  const base64Png = readFileSync(SOURCE).toString('base64');
  const encoded = await page.call(
    async (pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return JSON.stringify({
        jpeg: canvas.toDataURL('image/jpeg', 0.92),
        webp: canvas.toDataURL('image/webp', 0.9),
        width: canvas.width,
        height: canvas.height,
      });
    },
    base64Png,
  );

  mkdirSync(ASSETS, { recursive: true });

  for (const [format, dataUrl] of Object.entries({ jpeg: encoded.jpeg, webp: encoded.webp })) {
    const prefix = `data:image/${format};base64,`;
    if (!dataUrl.startsWith(prefix)) {
      throw new Error(`浏览器返回的不是 ${format} 编码：${dataUrl.slice(0, 40)}`);
    }
    const buffer = Buffer.from(dataUrl.slice(prefix.length), 'base64');
    const name = `sample.${format === 'jpeg' ? 'jpg' : 'webp'}`;
    writeFileSync(join(ASSETS, name), buffer);

    const header = format === 'jpeg' ? assertJpeg(buffer) : assertWebp(buffer);
    if (header.width !== encoded.width || header.height !== encoded.height) {
      throw new Error(
        `${name} 头部尺寸与画布不符：${header.width}×${header.height} vs ${encoded.width}×${encoded.height}`,
      );
    }
    results.push({ name, bytes: buffer.length, width: header.width, height: header.height });
  }

  page.close();
} finally {
  await chrome.close();
  rmSync(profileDir, { recursive: true, force: true });
}

console.log('已生成 JPEG / WebP 素材（真实编码，头部自检通过）：');
for (const row of results) {
  console.log(`  tests/fixtures/assets/${row.name.padEnd(12)} ${String(row.bytes).padStart(6)} 字节  ${row.width}×${row.height}`);
}
