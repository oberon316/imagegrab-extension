/**
 * 极简 PNG 编解码器（8 位 RGBA，无隔行扫描）。
 *
 * 用途有两个：
 *  1. 生成真实 PNG 图标与测试素材 —— 不依赖任何图像库，也不存在"把 SVG 改名成 .png"的可能。
 *  2. 在 check.mjs 中把生成结果解码回来做往返校验，确认写出的确实是合法 PNG。
 *
 * 不支持：调色板、灰度、16 位、隔行扫描、辅助块（除 IHDR/IDAT/IEND 之外一律不读）。
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length >>> 0, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width*height*4
 * @returns {Buffer} 完整 PNG 文件字节
 */
export function encodePng(width, height, rgba, { level = 9 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: 尺寸非法 ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: 像素缓冲长度 ${rgba.length} 与 ${width}x${height} 不匹配`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 过滤器类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 位深
  ihdr.writeUInt8(6, 9); // 颜色类型 6 = RGBA
  ihdr.writeUInt8(0, 10); // 压缩方法
  ihdr.writeUInt8(0, 11); // 过滤方法
  ihdr.writeUInt8(0, 12); // 隔行扫描

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 解析 PNG 结构，逐块校验长度与 CRC。
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,chunks:string[]}}
 */
export function readPngHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 文件：文件头不匹配');
  }
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new Error('PNG 结构损坏：块头被截断');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd + 4 > buf.length) throw new Error(`PNG 结构损坏：块 ${type} 被截断`);
    const expected = buf.readUInt32BE(bodyEnd);
    const actual = crc32(buf.subarray(offset + 4, bodyEnd));
    if (expected !== actual) {
      throw new Error(`PNG 校验失败：块 ${type} 的 CRC 不一致`);
    }
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('PNG 结构损坏：IHDR 长度不是 13');
      header = {
        width: buf.readUInt32BE(bodyStart),
        height: buf.readUInt32BE(bodyStart + 4),
        bitDepth: buf.readUInt8(bodyStart + 8),
        colorType: buf.readUInt8(bodyStart + 9),
      };
    }
    chunks.push(type);
    offset = bodyEnd + 4;
    if (type === 'IEND') break;
  }
  if (!header) throw new Error('PNG 缺少 IHDR');
  return { ...header, chunks };
}

/**
 * 完整解码回 RGBA，用于往返校验。
 * 只支持本文件写出的格式（8 位 RGBA、过滤器 0）。
 */
export function decodePng(buf) {
  const header = readPngHeader(buf);
  if (header.bitDepth !== 8 || header.colorType !== 6) {
    throw new Error('decodePng 只支持 8 位 RGBA');
  }
  const idat = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (!idat.length) throw new Error('PNG 缺少 IDAT');
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * 4;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`PNG 像素数据长度 ${raw.length}，期望 ${expected}`);
  }
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`decodePng 不支持过滤器类型 ${filter}`);
    raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba: out };
}

/** 24 位 BMP（BI_RGB、自下而上），用于提供"非 PNG 源图"的转换测试素材。 */
export function encodeBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelArraySize = rowSize * height;
  const dataOffset = 14 + 40;
  const buf = Buffer.alloc(dataOffset + pixelArraySize);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(dataOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // 正数 = 自下而上
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    let o = dataOffset + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const i = (srcRow * width + x) * 4;
      buf[o] = rgba[i + 2];
      buf[o + 1] = rgba[i + 1];
      buf[o + 2] = rgba[i];
      o += 3;
    }
  }
  return buf;
}
