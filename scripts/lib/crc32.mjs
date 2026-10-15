/**
 * CRC-32（IEEE 802.3，PNG / ZIP 通用多项式 0xEDB88320）。
 *
 * PNG 的每个数据块末尾、以及 ZIP 的每个条目都要写这个校验值，
 * 因此两个生成器共用这一份实现。
 */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[i] = c >>> 0;
}

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 无符号 32 位校验值
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
