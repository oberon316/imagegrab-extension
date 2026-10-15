# scripts/ — 校验、打包与开发辅助

统一使用 Node 内置模块实现，不引入第三方依赖。要求 Node 18 以上（本机用 v24 验证）。
`scripts/lib/` 下是 `cdp.mjs`（最小 CDP 客户端）、`chrome.mjs`（查找并启动本机 Chrome）、
`png.mjs` / `zip.mjs` / `crc32.mjs` / `palette.mjs`（自写的 PNG 与 ZIP 编码器及配色常量）。

## `check.mjs` — 提交前校验

```bash
node scripts/check.mjs
```

逐项检查，任何一项失败都以非 0 退出码结束（便于接入 CI 或 Git 钩子）。当前 18 项，按输出顺序：

1. `extension/` 下所有 JSON 可解析
2. `manifest_version` 为 3
3. `version` 为合法语义化版本
4. 清单中引用的每个 JS / HTML / 图标路径都真实存在
5. 权限均在允许清单内；出现 `tabs`、`debugger`、`webRequest`、必需 `<all_urls>` 时报错
6. 4 个图标都是**真实 PNG**（校验 magic number 与 IHDR 尺寸，不是改后缀的假文件）
7. 全部 JS 文件通过语法检查
8. 4 个内容脚本均为经典脚本（无 `import` / `export`，MV3 内容脚本不支持）
9. **顺序**检查 Service Worker 的 import 链：不得触达 `lib/image-processor.js` 与 `lib/downloader.js`，
   并静态确认 SW 里没有 `document` / `HTMLCanvasElement` / `createObjectURL` 等 DOM API
10. HTML 无内联脚本、无内联事件属性、无远程资源引用，且本地引用均真实存在
11. 品牌配色在 `content/url-tools.js`、`lib/theme.js`、`gallery/gallery.css`、`scripts/lib/palette.mjs` 中一致
12. 消息常量在内容脚本侧与扩展页面侧一致
13. 设置存储键两侧一致（`ig:settings`）
14. 内容脚本注入顺序与 `manifest.json` 的 `content_scripts.js` 一致
15. `docs/downloads/` 中最新的 ZIP 可完整解压（逐条校验 CRC）
16. ZIP 的 SHA-256 与 `SHA256SUMS.txt` 记录一致
17. **官网首页与发布包一致**：页面上必须出现当前发布包的版本号、体积与 SHA-256，
    每个下载按钮的 `href` / `download` 都指向当前 ZIP 文件名，且不允许出现根路径下载链接
    （`/downloads/…` 在 GitHub Pages 子路径部署下会 404）。这项检查只看"页面上有没有这几个字符串"，
    不解析排版，因此版本号写成 `v1.0.0` 也能通过；它拦的是"改了版本号、忘了改官网"这类发布事故
18. 打包白名单覆盖 `extension/` 下所有源码文件，且包内没有凭据类文件

## `package.mjs` — 生成安装包

```bash
node scripts/package.mjs
```

1. 读取 `extension/manifest.json` 的 `version`
2. 把 `extension/` 打包为 `docs/downloads/imagegrab-v<版本>.zip`，压缩包内以 `manifest.json` 为顶层
3. 立刻读回自检：能完整解压、CRC 正确、顶层有 `manifest.json`、不含敏感文件
4. 更新 `docs/downloads/SHA256SUMS.txt` 与 `docs/downloads/manifest.json`

打包采用**白名单**：只收集 `extension/` 下显式允许的文件类型（`json`、`js`、`html`、`css`、`png`），
其余一律不进包。这样即便仓库里混入了凭据文件，也不会被意外发布（`extension/README.md` 会被跳过，属预期）。

当前发布包：`docs/downloads/imagegrab-v1.0.0.zip`，52.3 KB，解压后 119.4 KB / 21 个文件
（这份包由 PowerShell 的 `Compress-Archive -Path '.\extension\*'` 直接生成，因此额外含 `extension/README.md`；
`package.mjs` 的白名单打包会跳过它，产出 20 个文件）。

## `serve.mjs` — 本地预览

```bash
node scripts/serve.mjs docs            # 预览官网，默认 http://127.0.0.1:8080
node scripts/serve.mjs tests/fixtures 8787
```

静态文件服务器，仅监听 `127.0.0.1`，拒绝目录穿越。用于替代直接打开 `file://`（内容脚本与 `fetch` 在 `file://` 下受限）。
`tests/local-server.mjs` 是它在素材页目录上的薄封装。

## `make-test-assets.mjs` — 生成 PNG / BMP 测试素材

```bash
node scripts/make-test-assets.mjs
```

生成 `tests/fixtures/assets/` 下的 `sample.png`、`sample.bmp`、`wide.png`、`tiny.png`、`lazy.png`，
全部由脚本自带的编码器写出并读回头部校验（PNG 检查 IHDR，BMP 检查 `BM` 与尺寸字段）。

## `make-image-assets.mjs` — 生成 JPEG / WebP 测试素材

```bash
node scripts/make-image-assets.mjs
```

生成 `tests/fixtures/assets/sample.jpg` 与 `sample.webp`。JPEG / WebP 编码器实现量太大，纯 Node 手写不现实，
因此启动本机 Chrome，用 canvas 把 `sample.png` 重新编码为这两种格式，再解析 SOF / RIFF 头部校验尺寸。
找不到 Chrome 时会明确报错，不会悄悄生成假文件。

## 浏览器验证用的两个库

| 文件 | 作用 |
| --- | --- |
| `lib/cdp.mjs` | 最小 Chrome DevTools Protocol 客户端：连接、`send`、事件监听、`evaluate`、`waitUntil`。Node 24 自带全局 `WebSocket`，因此无需 puppeteer |
| `lib/chrome.mjs` | 查找本机 Chrome/Edge、准备临时 profile（并把默认下载目录指到测试目录）、启动并等调试端口就绪、通过 `Extensions.loadUnpacked` 加载未打包扩展 |

`tests/browser-e2e.mjs` 用这两个库驱动真实浏览器。

> 注意：Chrome 137 起，`--load-extension` 配合调试端口会被忽略，必须用 CDP 的 `Extensions.loadUnpacked`
> 并加上 `--enable-unsafe-extension-debugging`。`lib/chrome.mjs` 已按此处理。
