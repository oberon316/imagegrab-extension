/**
 * scripts/package.mjs —— 生成官网可下载的安装包。
 *
 *   node scripts/package.mjs
 *
 * 产出（全部在 docs/downloads/ 下）：
 *   imagegrab-v<版本>.zip   扩展本体，压缩包顶层就是 manifest.json，解压即可加载
 *   SHA256SUMS.txt          校验值，官网页面上直接展示
 *   manifest.json           发布信息（版本/文件名/字节数/校验值/生成时间），供官网读取
 *
 * 采用**白名单**收集文件：只收 .json/.js/.html/.css/.png，其余一律不入包。
 * 这样即便有人误把 .env 放进 extension/，也不会被发布出去。
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, readZipEntries } from './lib/zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DOWNLOADS = join(ROOT, 'docs', 'downloads');

const PACKED_EXTENSIONS = new Set(['.json', '.js', '.html', '.css', '.png']);
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------- 收集

const manifestPath = join(EXT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('找不到 extension/manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = String(manifest.version);
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`manifest.version 不是语义化版本：${version}`);
  process.exit(1);
}

const files = walk(EXT).sort();
const skipped = [];
const entries = [];
let rawTotal = 0;

for (const file of files) {
  const ext = extname(file).toLowerCase();
  const archiveName = relative(EXT, file).replace(/\\/g, '/');
  if (!PACKED_EXTENSIONS.has(ext)) {
    skipped.push(archiveName);
    continue;
  }
  const data = readFileSync(file);
  rawTotal += data.length;
  entries.push({ name: archiveName, data });
}

if (!entries.some((entry) => entry.name === 'manifest.json')) {
  console.error('打包内容里没有顶层 manifest.json，解压后将无法直接加载');
  process.exit(1);
}
if (rawTotal > MAX_UNCOMPRESSED_BYTES) {
  console.error(`未压缩体积 ${humanBytes(rawTotal)} 超过 ${humanBytes(MAX_UNCOMPRESSED_BYTES)}，请先精简资源`);
  process.exit(1);
}

// ---------------------------------------------------------------- 写包

const zipName = `imagegrab-v${version}.zip`;
const zipPath = join(DOWNLOADS, zipName);
const zipBuffer = createZip(entries, { now: new Date() });
writeFileSync(zipPath, zipBuffer);

// 立刻读回来校验一遍：能完整解压、CRC 正确、顶层有 manifest.json
const verified = readZipEntries(zipBuffer, { inflate: true });
const names = verified.map((entry) => entry.name);
if (!names.includes('manifest.json')) {
  console.error('自检失败：生成的压缩包顶层没有 manifest.json');
  process.exit(1);
}
for (const entry of verified) {
  if (/(^|\/)(\.env|.*\.key|.*\.pem)|node_modules\//.test(entry.name)) {
    console.error(`自检失败：压缩包包含敏感文件 ${entry.name}`);
    process.exit(1);
  }
}

const digest = sha256(zipBuffer);

// ---------------------------------------------------------------- 清单文件

/** 只保留当前版本的安装包，历史版本交给 Git 标签归档。 */
const removed = [];
for (const name of readdirSync(DOWNLOADS)) {
  if (name === zipName) continue;
  if (/^imagegrab-v\d+\.\d+\.\d+\.zip$/.test(name)) {
    unlinkSync(join(DOWNLOADS, name));
    removed.push(name);
  }
}

const sums =
  [
    '# 图提取 / ImageGrab 安装包校验值（SHA-256）',
    '# 校验方法：certutil -hashfile <文件名> SHA256   （或 sha256sum <文件名>）',
    '',
    `${digest}  ${zipName}`,
    '',
  ].join('\n');
writeFileSync(join(DOWNLOADS, 'SHA256SUMS.txt'), sums, 'utf8');

const releaseInfo = {
  name: manifest.name,
  version,
  file: zipName,
  bytes: zipBuffer.length,
  humanBytes: humanBytes(zipBuffer.length),
  sha256: digest,
  entries: entries.length,
  unpackedBytes: rawTotal,
  generatedAt: new Date().toISOString(),
  installNote: '下载后解压到固定目录，再在 chrome://extensions 打开开发者模式，选择"加载已解压的扩展程序"指向解压出的目录。',
};
writeFileSync(join(DOWNLOADS, 'manifest.json'), `${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------- 报告

console.log(`已生成 docs/downloads/${zipName}`);
console.log(`  压缩后 ${humanBytes(zipBuffer.length)}，解压后 ${humanBytes(rawTotal)}，共 ${entries.length} 个文件`);
console.log(`  SHA-256 ${digest}`);
console.log(`  自检：完整解压 ${verified.length} 个条目，CRC 全部通过，顶层含 manifest.json`);
if (removed.length) console.log(`  已移除旧版本安装包：${removed.join(', ')}`);
if (skipped.length) console.log(`  未入包（不在白名单内）：${skipped.join(', ')}`);

const stale = statSync(zipPath).size !== zipBuffer.length;
if (stale) {
  console.log('  警告：写入后的文件大小与内存中不一致，请检查磁盘。');
}
