/**
 * scripts/make-test-assets.mjs —— 生成测试素材图片。
 *
 *   node scripts/make-test-assets.mjs
 *
 * 生成 tests/fixtures/assets/ 下的素材：
 *   sample.png   96×96   普通图片
 *   sample.bmp   96×96   非 PNG 源图，用来验证"JPG/WebP 等必须真正转成 PNG 编码"
 *   wide.png    240×90   非正方形，用来验证尺寸展示
 *   tiny.png      8×8    用来验证最小尺寸筛选
 *   lazy.png    120×120  只被 data-src 引用，用来验证"未加载"提示链路
 *
 * JPEG / WebP 素材由 make-image-assets.mjs 生成（需要本机 Chrome 提供编码器）。
 *
 * 全部由脚本用真实编码器写出（PNG / BMP），不是改后缀的假文件。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, encodeBmp, readPngHeader } from './lib/png.mjs';
import { PALETTE, hexToRgb } from './lib/palette.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'assets');

const TEAL = hexToRgb(PALETTE.teal);
const CARAMEL = hexToRgb(PALETTE.caramel);
const GOLD = hexToRgb(PALETTE.gold);
const CREAM = hexToRgb(PALETTE.cream);

/** 画一张对角渐变 + 圆点 + 边框的图，尺寸不同内容一眼可辨。 */
function draw(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const radius = Math.min(width, height) / 4;
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      let color = [
        Math.round(CREAM[0] + (TEAL[0] - CREAM[0]) * t),
        Math.round(CREAM[1] + (TEAL[1] - CREAM[1]) * t),
        Math.round(CREAM[2] + (TEAL[2] - CREAM[2]) * t),
      ];

      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance <= radius) color = CARAMEL;

      const onBorder = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      if (onBorder) color = GOLD;

      const i = (y * width + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  { name: 'sample.png', width: 96, height: 96, format: 'png' },
  { name: 'sample.bmp', width: 96, height: 96, format: 'bmp' },
  { name: 'wide.png', width: 240, height: 90, format: 'png' },
  { name: 'tiny.png', width: 8, height: 8, format: 'png' },
  // 只通过 data-src 引用，页面上没有已加载的同地址图片，用来验证"未加载"提示链路。
  // 如果它被别的已加载图片引用，合并逻辑会把 pending 清掉，这条路径就测不到了。
  { name: 'lazy.png', width: 120, height: 120, format: 'png' },
];

const report = [];
for (const item of outputs) {
  const rgba = draw(item.width, item.height);
  const buffer = item.format === 'png' ? encodePng(item.width, item.height, rgba) : encodeBmp(item.width, item.height, rgba);
  const file = join(OUT_DIR, item.name);
  writeFileSync(file, buffer);

  let detail = `${item.format.toUpperCase()}`;
  if (item.format === 'png') {
    const header = readPngHeader(buffer);
    if (header.width !== item.width || header.height !== item.height) {
      throw new Error(`${item.name} 往返校验失败：写出的尺寸为 ${header.width}x${header.height}`);
    }
    detail += ` 结构校验通过 ${header.width}x${header.height}`;
  } else {
    // BMP 头部自检
    if (buffer.toString('ascii', 0, 2) !== 'BM') throw new Error(`${item.name} 不是合法 BMP`);
    const declaredWidth = buffer.readInt32LE(18);
    const declaredHeight = buffer.readInt32LE(22);
    if (declaredWidth !== item.width || declaredHeight !== item.height) {
      throw new Error(`${item.name} BMP 头部尺寸不符：${declaredWidth}x${declaredHeight}`);
    }
    detail += ` 头部校验通过 ${declaredWidth}x${declaredHeight}`;
  }

  report.push({ name: item.name, bytes: buffer.length, detail });
}

console.log('已生成测试素材：');
for (const row of report) {
  console.log(`  tests/fixtures/assets/${row.name.padEnd(12)} ${String(row.bytes).padStart(6)} 字节  ${row.detail}`);
}
