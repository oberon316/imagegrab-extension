# scripts/ — 校验与打包

**状态：尚未生成脚本。** 以下是接口约定，实现在 [PLAN.md](../PLAN.md) 的 M5。

统一使用 Node 内置模块实现，不引入第三方依赖（关于 ZIP 打包的实现取舍见 [PLAN.md](../PLAN.md) M5 一节）。要求 Node 18 以上。

## `check.mjs` — 提交前校验

```bash
node scripts/check.mjs
```

逐项检查，任何一项失败都以非 0 退出码结束（便于将来接入 CI 或 Git 钩子）：

1. `extension/manifest.json` 可解析，`manifest_version` 为 3，`version` 为合法语义化版本
2. 清单中引用的每个 JS / HTML / 图标路径都真实存在
3. `extension/` 下所有 JSON 文件可解析（含 `_locales/*/messages.json`）
4. `_locales` 的 `zh_CN` 与 `en` key 集合完全一致
5. 权限均在允许清单内；出现 `tabs`、`debugger`、`webRequest`、必需 `<all_urls>` 时报错
6. 源码中不存在 `eval(`、`new Function(`，以及指向外部的上报地址
7. `docs/downloads/` 中最新的 ZIP 版本号与 `manifest.json` 的 `version` 一致
8. 每个 ZIP 都有 SHA-256 记录，且重新计算结果与记录一致（只需存在即可，不强制最新版本）
9. `docs/` 页面中出现的下载链接都指向实际存在的文件
10. 待打包内容中不含 `.env`、`*.key`、`*.pem`、`node_modules/`、`tests/tmp/` 等敏感或临时文件

## `package.mjs` — 生成安装包

```bash
node scripts/package.mjs
```

1. 读取 `extension/manifest.json` 的 `version`
2. 把 `extension/` 打包为 `docs/downloads/imagegrab-v<版本>.zip`，压缩包内以 `manifest.json` 为顶层
3. 更新 `docs/downloads/SHA256SUMS.txt` 与 `docs/downloads/manifest.json`
4. 输出：文件名、字节数、SHA-256

打包采用**白名单**：只收集 `extension/` 下显式允许的文件类型（`json`、`js`、`html`、`css`、`png`、`svg`、`woff2`），其余一律不进包。这样即便仓库里混入了凭据文件，也不会被意外发布。

## `serve.mjs` — 本地预览

```bash
node scripts/serve.mjs docs            # 预览官网，默认 http://localhost:8080
node scripts/serve.mjs tests/fixtures  # 预览测试素材
```

静态文件服务器，仅监听 `127.0.0.1`，不做目录穿越。用于替代直接打开 `file://`（内容脚本与 `fetch` 在 `file://` 下受限制）。
