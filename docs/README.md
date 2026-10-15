# docs/ — 纯静态官网

**状态：尚未生成网站代码。** 本目录是 GitHub Pages 的发布目录，推送后站点自动更新。

## 约束

1. **纯静态**：只有 HTML、CSS、原生 JS。没有构建步骤、没有框架、没有包管理器。
2. **无外部依赖**：不引用任何 CDN、第三方字体、统计脚本或图标库。原因有两方面——避免第三方请求带来的隐私问题，以及避免在国内网络环境下加载失败。
3. **离线可读**：除下载功能外，直接用浏览器打开 `docs/index.html` 也应能正常显示。

## 计划中的页面

| 文件 | 内容 |
| --- | --- |
| `index.html` | 功能介绍、安装指引、下载按钮（含版本号与 SHA-256）、常见问题 |
| `privacy.html` | 隐私政策；逐条说明每个浏览器权限的用途，声明不采集上传任何数据 |
| `changelog.html` | 各版本变更记录 |
| `404.html` | 自定义 404 页面 |
| `assets/style.css` | 样式，含深色模式与响应式 |
| `assets/main.js` | 仅处理轻交互（读取 `downloads/manifest.json` 显示最新版本等） |
| `.nojekyll` | 关闭 GitHub Pages 的 Jekyll 处理，避免下划线开头的文件被忽略 |
| `downloads/` | 安装包与校验值，详见该目录的 README |

## 本地预览

```bash
node scripts/serve.mjs docs
```

在 `file://` 下打开可以检查排版，但下载链接与 `fetch('downloads/manifest.json')` 需要 HTTP 环境才能验证，请通过本地服务器测试。
