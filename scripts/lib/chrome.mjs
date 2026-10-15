/**
 * scripts/lib/chrome.mjs —— 找到并启动本机 Chrome，供验证脚本使用。
 *
 * 使用本机已安装的 Chrome，不下载任何东西（保持零依赖）。
 * 端口用 --remote-debugging-port=0 让系统分配，再从 stderr 里读实际端口，
 * 避免与用户机器上其它调试端口冲突。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp, waitUntil } from './cdp.mjs';

const WINDOWS_CANDIDATES = [
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
];

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/**
 * 找一个可用的 Chromium 系浏览器。
 * 优先 CHROME_PATH 环境变量（方便指定 Chrome for Testing 或其它版本）。
 * @returns {string}
 */
export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new Error(`CHROME_PATH 指向的文件不存在：${fromEnv}`);
  }

  const candidates =
    process.platform === 'win32' ? WINDOWS_CANDIDATES : process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  // 再尝试 PATH 里的命令名（Linux 发行版常见）
  if (process.platform !== 'win32') {
    for (const name of ['google-chrome', 'chromium', 'microsoft-edge']) {
      for (const dir of (process.env.PATH || '').split(':')) {
        const full = join(dir, name);
        if (dir && existsSync(full)) return full;
      }
    }
  }

  throw new Error(
    '找不到 Chrome/Edge。请安装 Chrome，或用环境变量指定，例如：\n' +
      '  PowerShell: $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\n' +
      '  bash:       CHROME_PATH=/usr/bin/google-chrome node tests/browser-e2e.mjs',
  );
}

/** 准备一个全新的用户数据目录，并把默认下载目录指到指定位置。 */
export function prepareProfile(profileDir, downloadsDir) {
  mkdirSync(join(profileDir, 'Default'), { recursive: true });
  if (downloadsDir) mkdirSync(downloadsDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadsDir || profileDir, prompt_for_download: false },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    }),
  );
}

/**
 * 启动 Chrome 并连上浏览器级 CDP。
 *
 * @param {object} options
 * @param {string} options.profileDir    用户数据目录（已存在或会被创建）
 * @param {string} [options.downloadsDir] 默认下载目录
 * @param {string} [options.extensionDir] 未打包扩展目录（通过 CDP 加载，见 loadExtension）
 * @param {boolean} [options.headless]   默认 true
 * @param {string[]} [options.extraArgs]
 */
export async function launchChrome(options) {
  const binary = options.binary || findChrome();
  const headless = options.headless !== false;

  const args = [
    ...(headless ? ['--headless=new'] : []),
    // Chrome 137+ 起，未打包扩展必须显式开启这个开关才能在调试会话里加载
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    ...(options.extraArgs || []),
    'about:blank',
  ];

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动 Chrome 超时，stderr：\n${stderr}`)), 30000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出（code=${code}）：\n${stderr}`));
    });
  });

  // /json/version 里有完整的浏览器级 WebSocket 地址
  const version = await waitUntil(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    { label: 'Chrome 调试端口就绪' },
  );
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  return {
    child,
    port,
    browser,
    /** 关闭浏览器与连接 */
    async close() {
      browser.close();
      if (!child.killed) child.kill();
      // 给 Chrome 一点时间收尾，避免临时 profile 被占用
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    logs() {
      return `${stdout}\n${stderr}`;
    },
  };
}

/**
 * 通过 CDP 加载未打包扩展，返回扩展 id。
 * Chrome 137+ 已经不再支持用 --load-extension 配合调试端口，必须走这个命令。
 * @param {import('./cdp.mjs').Cdp} browser
 * @param {string} extensionDir
 * @returns {Promise<{id: string, path: string}>}
 */
export async function loadExtension(browser, extensionDir) {
  const result = await browser.send('Extensions.loadUnpacked', { path: extensionDir });
  if (!result || !result.id) throw new Error('Extensions.loadUnpacked 未返回扩展 id');
  return result;
}
