/**
 * tests/local-server.mjs —— 启本地素材页服务器。
 *
 *   node tests/local-server.mjs
 *   → http://localhost:8787/fixture-merchant-detail.html
 *
 * 素材页必须走 HTTP：扩展的 content_scripts 只匹配 http(s)，
 * 且 fetch 在 file:// 下受限，用 file:// 打开会得到与真实使用不符的结果。
 *
 * 端口默认 8787（写死在 TESTING.md 与 tests/README.md 里，便于照抄步骤）。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = Number(process.argv[2]) || 8787;

try {
  await startServer({ root: FIXTURES, port: PORT });
  console.log(`素材页首页：http://localhost:${PORT}/fixture-merchant-detail.html`);
} catch (error) {
  console.error(String((error && error.message) || error));
  process.exit(1);
}
