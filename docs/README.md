# docs/ — 纯静态官网

**状态：官网已发布。** https://oberon316.github.io/imagegrab-extension/ 。本目录由 GitHub Pages 从 main 分支 /docs 发布，后续推送自动更新。

## 约束

1. **纯静态**：只有 HTML、CSS、原生 JS。没有构建步骤、没有框架、没有包管理器。
2. **无外部依赖**：不引用任何 CDN、第三方字体、统计脚本或图标库。原因有两方面——避免第三方请求带来的隐私问题，以及避免在国内网络环境下加载失败。
3. **离线可读**：除下载功能外，直接用浏览器打开 `docs/index.html` 也应能正常显示。

## 页面清单

| 文件 | 内容 |
| --- | --- |
| `index.html` | 首页：产品介绍、插件功能、界面展示、支持与测试范围、下载安装步骤、常见问题、GitHub 链接、首屏与页尾的下载按钮（含版本号与 SHA-256） |
| `privacy.html` | 隐私说明：权限用途、页面来源信息的本地存储、预览和下载向图片原站发起的请求 |
| `404.html` | 自定义 404 页面 |
| `assets/style.css` | 样式（米白纸色 · 墨绿正文 · 陶土橙强调），响应式 |
| `assets/main.js` | 轻交互：移动端导航、FAQ 折叠、图片灯箱、复制校验值、读取 `downloads/manifest.json` 显示最新版本 |
| `assets/icon128.png` | 站点图标（复用扩展图标） |
| `assets/screenshot-*.png` | 插件界面截图（画廊展示） |
| `.nojekyll` | 关闭 GitHub Pages 的 Jekyll 处理，避免下划线开头的文件被忽略 |
| `downloads/` | 安装包与校验值，详见该目录的 README |

> 两份未完成项，避免以后误以为官网已经完整：
> - `changelog.html`（更新日志页，FR-805）尚未生成：当前仅有 1.0.0 一个版本，暂不需要独立的变更记录页。
> - **深色模式（FR-807）尚未实现**：`assets/style.css` 里只有 `@media(prefers-reduced-motion)`，没有 `prefers-color-scheme`。
>   原因是核心配色虽然写在 `:root` 变量里，但组件样式里还散落着几十处写死的十六进制色值（`#e9eadb`、`#ecece1`、`#1e4137`、`#53705e` 等），
>   补深色模式要先把这些改成变量，再给深色选一套对比度达标的配色。属于一次独立的样式重构，详见 [TESTING.md](../TESTING.md) 的 LIM-10。**2026-10-15 确认本轮不做**，所以 FR-807 仍未满足。

## 本地预览

```bash
node scripts/serve.mjs docs
```

在 `file://` 下打开可以检查排版，但下载链接与 `fetch('downloads/manifest.json')` 需要 HTTP 环境才能验证，请通过本地服务器测试。
