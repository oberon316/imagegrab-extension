/**
 * 最小 ZIP 写入器与读取器（写入用 deflate 或 store，读取用于校验）。
 *
 * 为什么不用第三方库：这个项目坚持零运行时依赖，而扩展安装包的内容全部是
 * 本地可控文件，不需要 ZSTD/加密/分卷等能力。自己写反而能精确控制白名单。
 *
 * 支持：单盘、无加密、UTF-8 文件名、deflate（方法 8）与 store（方法 0）。
 * 不支持：ZIP64（单文件 > 4GB 时抛错，本项目不会触发）、目录条目以外的额外字段。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;

/** 已经是压缩格式的扩展名，再 deflate 只会变大。 */
const ALREADY_COMPRESSED = /\.(png|jpe?g|gif|webp|avif|zip|crx|woff2)$/i;

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {Array<{name: string, data: Buffer|string, store?: boolean}>} entries
 * @returns {Buffer}
 */
export function createZip(entries, { now = new Date() } = {}) {
  if (!entries.length) throw new Error('createZip: 条目为空');
  const { time, day } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.startsWith('/') || name.includes('..')) {
      throw new Error(`createZip: 条目路径非法 ${name}`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const store = entry.store === true || ALREADY_COMPRESSED.test(name);
    const payload = store ? raw : deflateRawSync(raw, { level: 9 });
    const method = store ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 额外字段长度

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 额外字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, payload);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/**
 * 读取 ZIP 并（默认）解压每个条目校验 CRC，用于确认写出的包真的能被解压。
 * @returns {Array<{name:string,size:number,compressedSize:number,method:number,data:Buffer|null}>}
 */
export function readZipEntries(buf, { inflate = true } = {}) {
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error('ZIP 结构损坏：找不到 EOCD');
  const count = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error('ZIP 结构损坏：中央目录签名不匹配');
    const method = buf.readUInt16LE(offset + 10);
    const sum = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    let data = null;
    if (inflate) {
      if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`ZIP 结构损坏：${name} 的本地头签名不匹配`);
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const payload = buf.subarray(start, start + compressedSize);
      data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
      if (data.length !== size) throw new Error(`ZIP 校验失败：${name} 解压后长度 ${data.length}，期望 ${size}`);
      if (crc32(data) !== sum) throw new Error(`ZIP 校验失败：${name} 的 CRC 不一致`);
    }
    out.push({ name, size, compressedSize, method, data });
  }
  return out;
}
