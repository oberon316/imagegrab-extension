/**
 * 生成 extension/icons/ 下的真实 PNG 图标（16 / 32 / 48 / 128）。
 *
 *   node scripts/make-icons.mjs
 *
 * 图标内容（一张"照片"简化图形）：
 *   深松石绿圆角方块底 + 雾金内框 + 奶油白画芯 + 雾金太阳 + 焦糖棕山峦
 *
 * 每个像素做 4x4 超采样再降采样，得到抗锯齿边缘；16px 尺寸下自动省略太阳，
 * 否则缩小后只剩一团模糊的金点。
 *
 * 生成后立刻解码回像素做往返校验，确认写出的确实是合法 PNG 而非改了后缀的文本。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng, readPngHeader } from './lib/png.mjs';
import { PALETTE, hexToRgb } from './lib/palette.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SUBSAMPLES = 4;

const TEAL = hexToRgb(PALETTE.teal);
const GOLD = hexToRgb(PALETTE.gold);
const CREAM = hexToRgb(PALETTE.cream);
const CARAMEL = hexToRgb(PALETTE.caramel);

/** 圆角矩形的内部判定（矩形 0..1 坐标）。 */
function insideRoundedBox(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= r;
}

function insideRect(px, py, x0, y0, x1, y1) {
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

/** 三角形内部判定（重心符号法）。 */
function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 返回某个采样点的 [r,g,b,a]，a 为 0 或 1。
 * @param {number} u 0..1
 * @param {number} v 0..1
 * @param {number} size 目标像素尺寸，用于在小尺寸下简化细节
 */
function shade(u, v, size) {
  const detailed = size > 20;

  // 1. 外轮廓：深松石绿圆角方块
  if (!insideRoundedBox(u, v, 0, 0, 1, 1, 0.22)) return null;
  let color = TEAL;

  // 2. 雾金内框（两个圆角矩形相减得到环）
  const outerFrame = insideRoundedBox(u, v, 0.11, 0.11, 0.89, 0.89, 0.16);
  const innerFrame = insideRoundedBox(u, v, 0.21, 0.21, 0.79, 0.79, 0.1);
  if (outerFrame && !innerFrame) return [...GOLD, 1];

  // 3. 画芯：奶油白
  if (innerFrame) {
    color = CREAM;

    // 4. 太阳（小尺寸下省略，避免糊成一片）
    if (detailed && Math.hypot(u - 0.4, v - 0.37) <= 0.075) return [...GOLD, 1];

    // 5. 山峦：焦糖棕，受限在画芯内
    const peaks = detailed
      ? [
          [0.21, 0.79, 0.42, 0.42, 0.6, 0.79],
          [0.47, 0.79, 0.63, 0.5, 0.79, 0.79],
        ]
      : [[0.21, 0.79, 0.5, 0.42, 0.79, 0.79]];
    for (const [ax, ay, bx, by, cx, cy] of peaks) {
      if (v >= 0.4 && insideTriangle(u, v, ax, ay, bx, by, cx, cy)) return [...CARAMEL, 1];
    }
    return [...color, 1];
  }

  return [...color, 1];
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const n = SUBSAMPLES * SUBSAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const u = (x + (sx + 0.5) / SUBSAMPLES) / size;
          const v = (y + (sy + 0.5) / SUBSAMPLES) / size;
          const c = shade(u, v, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        // 非预乘 alpha 存储：颜色取覆盖到的采样点均值，alpha 取覆盖率
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });

const report = [];
for (const size of SIZES) {
  const rgba = render(size);
  const png = encodePng(size, size, rgba);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);

  // 往返校验：解码回来必须能得到同样的像素
  const header = readPngHeader(png);
  const decoded = decodePng(png);
  const identical = decoded.rgba.equals(rgba);

  // 统计不透明像素，确认图形真的画上去了（而不是整张透明）
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 8) opaque += 1;

  report.push({
    file: `extension/icons/icon${size}.png`,
    bytes: png.length,
    ihdr: `${header.width}x${header.height} 位深${header.bitDepth} 颜色类型${header.colorType}`,
    chunks: header.chunks.join(' '),
    roundTrip: identical ? '通过' : '失败',
    opaqueRatio: `${((opaque / (size * size)) * 100).toFixed(1)}%`,
  });

  if (!identical) {
    throw new Error(`icon${size}.png 往返校验失败`);
  }
  if (opaque / (size * size) < 0.5) {
    throw new Error(`icon${size}.png 不透明像素过少（${opaque}），图形可能没画上`);
  }
}

console.log('已生成 PNG 图标：');
for (const row of report) {
  console.log(`  ${row.file.padEnd(32)} ${String(row.bytes).padStart(4)} 字节  ${row.ihdr}  不透明 ${row.opaqueRatio}  往返校验 ${row.roundTrip}`);
}
console.log(`\n完整 PNG 结构：IHDR + IDAT + IEND（${report[0].chunks}）`);
