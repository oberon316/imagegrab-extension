/**
 * scripts/check.mjs —— 提交前的静态校验。
 *
 *   node scripts/check.mjs
 *
 * 任何一项失败都会以非 0 退出码结束，方便将来接到 CI 或 Git 钩子上。
 * 它只做"静态可判定"的检查（结构、引用、一致性、禁用 API），
 * 浏览器里的实际行为仍然必须人工验证并记录到 TESTING.md。
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, relative, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readPngHeader } from './lib/png.mjs';
import { readZipEntries } from './lib/zip.mjs';
import { PALETTE } from './lib/palette.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DOWNLOADS = join(ROOT, 'docs', 'downloads');

const errors = [];
const warnings = [];
const passed = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function ok(message) {
  passed.push(message);
}

function rel(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function walk(dir, filter = () => true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 语法检查

const syntaxCache = new Map();

function checkSyntax(path) {
  if (syntaxCache.has(path)) return syntaxCache.get(path);
  const source = readText(path);
  const isModule = /^\s*(import|export)\s/m.test(source);
  const temp = join(tmpdir(), `ig-syntax-${randomUUID()}${isModule ? '.mjs' : '.cjs'}`);
  writeFileSync(temp, source);
  let result = { ok: true, message: '' };
  try {
    execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
  } catch (error) {
    const detail = `${error.stderr || error.stdout || error.message}`.split('\n').filter(Boolean).slice(0, 3).join(' ');
    result = { ok: false, message: detail };
  } finally {
    unlinkSync(temp);
  }
  syntaxCache.set(path, { ...result, isModule });
  return syntaxCache.get(path);
}

// ---------------------------------------------------------------- 去注释

/**
 * 去掉注释后再做"禁用 API"扫描。
 * 否则像 Service Worker 开头那段"不准使用 URL.createObjectURL"的说明文字，
 * 会被自己误判成违规用法。字符串字面量会完整保留，因此 URL 里的 // 不受影响。
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  let state = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        index += 2;
        continue;
      }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      out += char;
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    // 字符串 / 模板串
    if (char === '\\') {
      out += char + (next || '');
      index += 2;
      continue;
    }
    out += char;
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) {
      state = 'code';
    }
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------- 1. JSON

const jsonFiles = walk(EXT, (file) => extname(file) === '.json');
const manifestPath = join(EXT, 'manifest.json');
let manifest = null;

for (const file of jsonFiles) {
  try {
    const parsed = JSON.parse(readText(file));
    if (file === manifestPath) manifest = parsed;
  } catch (error) {
    fail(`JSON 解析失败：${rel(file)} —— ${error.message}`);
  }
}
if (!jsonFiles.length) fail('extension/ 下没有找到任何 JSON 文件');
if (!manifest) {
  fail('extension/manifest.json 缺失或无法解析，后续检查无法继续');
} else {
  ok(`JSON 全部可解析（${jsonFiles.length} 个文件）`);
}

// ---------------------------------------------------------------- 2. manifest 结构

let contentScriptFiles = [];

if (manifest) {
  if (manifest.manifest_version !== 3) fail(`manifest_version 必须是 3，实际为 ${manifest.manifest_version}`);
  else ok('manifest_version = 3');

  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    fail(`version 不是合法的语义化版本：${manifest.version}`);
  } else {
    ok(`version = ${manifest.version}`);
  }

  if (!manifest.name || !manifest.description) fail('manifest 缺少 name 或 description');

  const referenced = [];
  for (const value of Object.values(manifest.icons || {})) referenced.push(value);
  for (const value of Object.values((manifest.action && manifest.action.default_icon) || {})) referenced.push(value);
  if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    referenced.push(...(script.js || []), ...(script.css || []));
  }
  for (const value of manifest.web_accessible_resources || []) {
    referenced.push(...(value.resources || []));
  }

  for (const value of new Set(referenced)) {
    if (!existsSync(join(EXT, value))) fail(`manifest 引用的文件不存在：${value}`);
  }
  ok(`manifest 引用的 ${new Set(referenced).size} 个文件都存在`);

  const allowedPermissions = new Set(['activeTab', 'scripting', 'storage', 'downloads', 'contextMenus', 'sidePanel', 'offscreen', 'notifications', 'alarms']);
  const forbidden = new Set(['tabs', 'debugger', 'webRequest', 'webRequestBlocking', 'history', 'cookies', 'management', 'proxy', 'declarativeNetRequest']);
  for (const permission of manifest.permissions || []) {
    if (forbidden.has(permission)) fail(`禁止申请高权限：${permission}`);
    else if (!allowedPermissions.has(permission)) warn(`权限 ${permission} 不在许可清单里，请确认确有必要`);
  }
  for (const host of manifest.host_permissions || []) {
    if (host === '<all_urls>' || host === '*://*/*') fail(`host_permissions 不应包含全站通配：${host}`);
  }
  ok(`权限清单通过（${(manifest.permissions || []).length} 项权限，${(manifest.host_permissions || []).length} 条主机权限）`);

  contentScriptFiles = (manifest.content_scripts || []).flatMap((script) => script.js || []);
}

// ---------------------------------------------------------------- 3. 图标必须是真 PNG

const iconFiles = walk(join(EXT, 'icons'), (file) => extname(file) === '.png');
if (iconFiles.length < 4) fail(`图标数量不足，至少需要 16/32/48/128 四种，当前 ${iconFiles.length}`);

for (const file of iconFiles) {
  const buf = readFileSync(file);
  const declared = Number(basename(file, '.png').replace(/\D/g, ''));
  try {
    const header = readPngHeader(buf);
    if (declared && header.width !== declared) {
      fail(`图标尺寸与文件名不符：${rel(file)} 实际为 ${header.width}x${header.height}`);
    }
    if (header.bitDepth !== 8 || header.colorType !== 6) {
      warn(`图标 ${rel(file)} 的颜色类型/位深非标准 RGBA8`);
    }
    if (!header.chunks.includes('IEND')) fail(`图标结构不完整：${rel(file)} 缺少 IEND`);
  } catch (error) {
    fail(`图标不是合法 PNG：${rel(file)} —— ${error.message}`);
  }
}
if (!errors.length) ok(`图标均为真实 PNG（${iconFiles.length} 个，尺寸与文件名一致）`);

// ---------------------------------------------------------------- 4. JS 语法 + 内容脚本必须是经典脚本

const jsFiles = walk(EXT, (file) => extname(file) === '.js');
for (const file of jsFiles) {
  const result = checkSyntax(file);
  if (!result.ok) fail(`语法错误：${rel(file)} —— ${result.message}`);
}
ok(`全部 ${jsFiles.length} 个 JS 文件通过语法检查`);

for (const name of contentScriptFiles) {
  const file = join(EXT, name);
  if (!existsSync(file)) continue;
  const result = checkSyntax(file);
  if (result.isModule) {
    fail(`内容脚本不能使用 import/export（MV3 不允许）：${name}`);
  }
}
if (contentScriptFiles.length) ok(`内容脚本 ${contentScriptFiles.length} 个文件均为经典脚本（无 import/export）`);

// ---------------------------------------------------------------- 5. Service Worker 不得触碰 DOM

const swPath = join(EXT, 'background', 'service-worker.js');
if (existsSync(swPath)) {
  const swSource = readText(swPath);
  const swCode = stripComments(swSource);
  const forbiddenInWorker = [
    ['document.', 'document 在 Service Worker 中不存在'],
    ['window.', 'window 在 Service Worker 中不存在'],
    ['HTMLCanvasElement', 'Service Worker 里没有 Canvas'],
    ['URL.createObjectURL', 'Service Worker 里不能用 URL.createObjectURL'],
    ['createImageBitmap', 'Service Worker 里不应做图片解码'],
  ];
  for (const [needle, why] of forbiddenInWorker) {
    if (swCode.includes(needle)) fail(`Service Worker 使用了 ${needle} —— ${why}`);
  }

  // 顺着 import 链走一遍，确认没有间接引用到图片处理/下载器
  const forbiddenModules = new Set(['lib/image-processor.js', 'lib/downloader.js']);
  const visited = new Set();
  const queue = [swPath];
  const reachable = [];
  while (queue.length) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readText(current);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = join(dirname(current), match[1]);
      const normalized = rel(target);
      reachable.push(normalized);
      if (forbiddenModules.has(normalized)) {
        fail(`Service Worker 通过 ${rel(current)} 间接引用了 ${normalized}，该模块只能在图库页面运行`);
      }
      if (existsSync(target)) queue.push(target);
    }
  }
  ok(`Service Worker 未使用 DOM API；import 链覆盖 ${reachable.length} 个模块，未触及图片处理/下载器`);
}

// ---------------------------------------------------------------- 6. 禁用 API 与远程脚本

for (const file of jsFiles) {
  const source = stripComments(readText(file));
  if (/\beval\s*\(/.test(source)) fail(`源码中出现 eval()：${rel(file)}`);
  if (/new\s+Function\s*\(/.test(source)) fail(`源码中出现 new Function()：${rel(file)}`);
}

const htmlFiles = walk(EXT, (file) => extname(file) === '.html');
for (const file of htmlFiles) {
  const source = readText(file);
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(source)) {
    fail(`HTML 中存在内联脚本：${rel(file)}`);
  }
  if (/\son[a-z]+\s*=/i.test(source)) {
    fail(`HTML 中存在内联事件处理器（on*=）：${rel(file)}`);
  }
  if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(source)) {
    fail(`HTML 中引用了远程资源：${rel(file)}`);
  }
  for (const match of source.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^(?:https?:|data:|#|mailto:)/i.test(value)) continue;
    const target = join(dirname(file), value.split('?')[0]);
    if (!existsSync(target)) fail(`HTML 引用的本地文件不存在：${rel(file)} → ${value}`);
  }
}
ok(`HTML 无内联脚本/内联事件/远程资源，且本地引用均存在（${htmlFiles.length} 个文件）`);

// ---------------------------------------------------------------- 7. 跨文件一致性

function extractHexCodes(source) {
  const codes = new Set();
  for (const match of source.matchAll(/#([0-9a-f]{6})\b/gi)) codes.add(`#${match[1].toUpperCase()}`);
  return codes;
}

const paletteSources = [
  join(ROOT, 'scripts', 'lib', 'palette.mjs'),
  join(EXT, 'content', 'url-tools.js'),
  join(EXT, 'lib', 'theme.js'),
  join(EXT, 'gallery', 'gallery.css'),
].filter(existsSync);

const expected = Object.values(PALETTE).map((value) => value.toUpperCase());
for (const file of paletteSources) {
  const codes = extractHexCodes(readText(file));
  for (const value of expected) {
    if (!codes.has(value)) fail(`配色不一致：${rel(file)} 缺少 ${value}`);
  }
}
if (paletteSources.length >= 3) ok(`品牌配色在 ${paletteSources.length} 个文件中一致（${expected.join(' ')}）`);

function extractObjectKeys(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*(?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\}\\s*\\)?;`).exec(source);
  if (!match) return null;
  const body = match[1];
  const pairs = new Map();
  for (const entry of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*['"]?([^'",\n}]+)['"]?/g)) {
    pairs.set(entry[1], entry[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  return pairs;
}

const msgPairs = [
  ['extension/lib/messaging.js', join(EXT, 'lib', 'messaging.js')],
  ['extension/content/url-tools.js', join(EXT, 'content', 'url-tools.js')],
].filter(([, file]) => existsSync(file));

const msgMaps = msgPairs.map(([label, file]) => [label, extractObjectKeys(readText(file), 'MSG')]);
if (msgMaps.every(([, map]) => map)) {
  const [base] = msgMaps;
  for (const [label, map] of msgMaps.slice(1)) {
    for (const [key, value] of base[1]) {
      if (map.get(key) !== value) fail(`消息常量不一致：${label} 的 ${key} 应为 ${value}，实际为 ${map.get(key)}`);
    }
  }
  ok(`消息常量在两个文件中一致（${base[1].size} 个，${msgPairs.map(([label]) => label).join(' 与 ')}）`);
} else {
  warn('未能解析出 MSG 常量，跳过一致性检查');
}

const settingsKeySources = [
  ['extension/lib/settings.js', join(EXT, 'lib', 'settings.js')],
  ['extension/content/content.js', join(EXT, 'content', 'content.js')],
].filter(([, file]) => existsSync(file));
const keyValues = settingsKeySources.map(([label, file]) => {
  const match = /SETTINGS_KEY\s*=\s*['"]([^'"]+)['"]/.exec(readText(file));
  return [label, match ? match[1] : null];
});
if (keyValues.every(([, value]) => value)) {
  const unique = new Set(keyValues.map(([, value]) => value));
  if (unique.size !== 1) {
    fail(`设置存储键不一致：${keyValues.map(([label, value]) => `${label}=${value}`).join('，')}`);
  } else {
    ok(`设置存储键一致：${[...unique][0]}`);
  }
}

// Service Worker 的注入文件列表必须与 manifest 的 content_scripts 顺序一致
if (existsSync(swPath) && contentScriptFiles.length) {
  const match = /CONTENT_FILES\s*=\s*\[([\s\S]*?)\]/.exec(readText(swPath));
  const declared = match
    ? Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g)).map((item) => item[1])
    : [];
  if (declared.join(',') !== contentScriptFiles.join(',')) {
    fail(`Service Worker 的 CONTENT_FILES 与 manifest 不一致：\n     manifest: ${contentScriptFiles.join(', ')}\n     worker:   ${declared.join(', ')}`);
  } else {
    ok(`内容脚本注入顺序一致：${declared.join(' → ')}`);
  }
}

// ---------------------------------------------------------------- 8. 发布包

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (!existsSync(DOWNLOADS)) {
  warn('docs/downloads 目录不存在，跳过发布包检查');
} else {
  const zips = readdirSync(DOWNLOADS).filter((name) => name.endsWith('.zip'));
  const sumsPath = join(DOWNLOADS, 'SHA256SUMS.txt');
  const sums = existsSync(sumsPath) ? readText(sumsPath) : '';

  if (!zips.length) {
    warn('docs/downloads 下还没有安装包（尚未执行 scripts/package.mjs）');
  }

  for (const name of zips) {
    const file = join(DOWNLOADS, name);
    const buffer = readFileSync(file);

    const versionInName = /-v(\d+\.\d+\.\d+)\.zip$/.exec(name);
    if (!versionInName) {
      fail(`安装包命名不符合 imagegrab-v<版本>.zip：${name}`);
    } else if (manifest && versionInName[1] !== manifest.version) {
      fail(`安装包版本与 manifest 不一致：包内为 ${versionInName[1]}，manifest 为 ${manifest.version}`);
    }

    try {
      const entries = readZipEntries(buffer, { inflate: true });
      const names = entries.map((entry) => entry.name);
      if (!names.includes('manifest.json')) fail(`${name} 的压缩包顶层没有 manifest.json，解压后无法直接加载`);
      for (const entry of names) {
        if (entry.includes('..')) fail(`${name} 含可疑路径：${entry}`);
        if (/(^|\/)(\.env|.*\.key|.*\.pem|node_modules\/)/.test(entry)) fail(`${name} 含敏感文件：${entry}`);
      }
      ok(`安装包 ${name} 可完整解压（${entries.length} 个条目，解压出 ${entries.reduce((sum, e) => sum + e.size, 0)} 字节）`);
    } catch (error) {
      fail(`安装包无法解压或校验失败：${name} —— ${error.message}`);
    }

    const digest = sha256(buffer);
    if (!sums) {
      warn(`${name} 缺少 SHA256SUMS.txt 记录`);
    } else if (!sums.includes(digest)) {
      fail(`SHA256SUMS.txt 中找不到与 ${name} 匹配的校验值（实际 ${digest}）`);
    } else {
      ok(`校验值匹配：${name} → ${digest.slice(0, 16)}…`);
    }
  }

  // 官网静态页必须与发布包对得上，否则用户看到的是上一版的版本号与校验值。
  // 这里只做"页面里到底有没有当前这几个字符串"的检查，不关心页面怎么排版，
  // 因此不会因为显示格式（例如版本号写不写 v 前缀）误报。
  const indexPath = join(ROOT, 'docs', 'index.html');
  const releasePath = join(DOWNLOADS, 'manifest.json');
  if (!existsSync(indexPath)) {
    warn('docs/index.html 尚未生成，跳过官网与发布包的一致性检查');
  } else if (!existsSync(releasePath)) {
    warn('docs/downloads/manifest.json 缺失，跳过官网与发布包的一致性检查');
  } else {
    let info = null;
    try {
      info = JSON.parse(readText(releasePath));
    } catch (error) {
      fail(`docs/downloads/manifest.json 无法解析：${error.message}`);
    }
    if (info) {
      const site = readText(indexPath);
      const file = String(info.file || '');
      const version = String(info.version || '');
      const checks = [];

      // 版本号：允许写成 1.0.0 或 v1.0.0，但两侧不能紧挨着别的数字或点
      const versionPattern = new RegExp(`(?<![\\d.])v?${version.replace(/\./g, '\\.')}(?![\\d.])`);
      if (!versionPattern.test(site)) checks.push(`版本号 ${version}`);
      if (info.humanBytes && !site.includes(String(info.humanBytes))) checks.push(`安装包体积 ${info.humanBytes}`);
      if (info.sha256 && !site.includes(String(info.sha256))) checks.push(`SHA-256 ${String(info.sha256).slice(0, 16)}…`);
      if (checks.length) {
        fail(`官网首页没有出现当前发布包的${checks.join('、')}，可能还挂着上一版（当前发布包是 ${file}）`);
      }

      const anchors = Array.from(site.matchAll(/<a\b[^>]*\bdata-download\b[^>]*>/g), (m) => m[0]);
      if (!anchors.length) {
        fail('官网首页找不到带 data-download 标记的下载按钮');
      }
      for (const tag of anchors) {
        if (!tag.includes(`href="./downloads/${file}"`)) {
          fail(`下载按钮的 href 不是 ./downloads/${file}：${tag.slice(0, 90)}…`);
        }
        if (!tag.includes(`download="${file}"`)) {
          fail(`下载按钮缺少 download="${file}"`);
        }
      }
      for (const match of site.matchAll(/href="\/downloads\/[^"]*"/g)) {
        fail(`官网出现根路径下载链接（GitHub Pages 子路径部署下会 404）：${match[0]}`);
      }
      if (!checks.length && anchors.length) {
        ok(`官网首页与发布包一致（${file}，版本号 / 体积 / SHA-256 均已同步，${anchors.length} 个下载按钮）`);
      }
    }
  }
}

// ---------------------------------------------------------------- 9. 打包内容白名单预检

/** 会被打进安装包的扩展名。 */
const PACKED_EXTENSIONS = new Set(['.json', '.js', '.html', '.css', '.png']);
/** 允许存在于 extension/ 但不会入包的文件（说明文档）。 */
const ALLOWED_BUT_UNPACKED = new Set(['.md']);

const strays = walk(EXT).filter((file) => {
  const ext = extname(file).toLowerCase();
  return !PACKED_EXTENSIONS.has(ext) && !ALLOWED_BUT_UNPACKED.has(ext);
});
if (strays.length) {
  warn(`extension/ 下存在不会进入安装包、也不在允许清单里的文件：${strays.map(rel).join(', ')}`);
}

const credentials = walk(EXT).filter((file) => {
  const name = basename(file).toLowerCase();
  return name === '.env' || name.endsWith('.key') || name.endsWith('.pem') || file.includes('node_modules');
});
if (credentials.length) {
  fail(`extension/ 下出现了凭据类文件，必须立刻清理：${credentials.map(rel).join(', ')}`);
} else {
  ok('extension/ 下没有凭据类文件，打包白名单覆盖所有源码文件');
}

// ---------------------------------------------------------------- 输出

console.log('\n检查通过的项目：');
for (const line of passed) console.log(`  ✓ ${line}`);

if (warnings.length) {
  console.log('\n警告（不阻塞）：');
  for (const line of warnings) console.log(`  ! ${line}`);
}

if (errors.length) {
  console.log('\n错误：');
  for (const line of errors) console.log(`  ✗ ${line}`);
  console.log(`\n检查失败：${errors.length} 个错误，${warnings.length} 个警告。`);
  process.exit(1);
}

console.log(`\n检查通过：0 个错误，${warnings.length} 个警告。`);
