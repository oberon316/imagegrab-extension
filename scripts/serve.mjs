/**
 * scripts/serve.mjs —— 本地静态文件服务器。
 *
 *   node scripts/serve.mjs docs               # 预览官网 http://127.0.0.1:8080
 *   node scripts/serve.mjs tests/fixtures 8787
 *
 * 为什么需要它：内容脚本与 fetch 在 file:// 下行为与真实站点不一致，
 * 而扩展的 content_scripts 也只匹配 http(s)。素材页必须通过 HTTP 打开才有意义。
 *
 * 仅监听 127.0.0.1，拒绝目录穿越，不做目录列表。
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * @param {{root: string, port?: number, host?: string, quiet?: boolean}} options
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(options) {
  const root = resolve(options.root);
  const port = Number(options.port) || 8080;
  const host = options.host || '127.0.0.1';
  const quiet = options.quiet === true;

  if (!existsSync(root)) {
    return Promise.reject(new Error(`目录不存在：${root}`));
  }

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${host}:${port}`);
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const target = join(root, pathname);
    // 目录穿越保护：解析后的路径必须仍在 root 之内
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('403 越权路径');
      return;
    }

    if (!existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`404 找不到 ${pathname}`);
      if (!quiet) console.log(`404 ${pathname}`);
      return;
    }

    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    createReadStream(target).pipe(response);
    if (!quiet) console.log(`200 ${pathname}`);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      const address = server.address();
      if (!quiet) {
        console.log(`本地服务器已启动：http://${host}:${address.port}/`);
        console.log(`根目录：${root}`);
        console.log('按 Ctrl+C 停止。');
      }
      resolvePromise(server);
    });
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const target = process.argv[2] || 'docs';
  const port = Number(process.argv[3]) || 8080;
  const here = fileURLToPath(new URL('.', import.meta.url));
  startServer({ root: resolve(here, '..', target), port }).catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
}
