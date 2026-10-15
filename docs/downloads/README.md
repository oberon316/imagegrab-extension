# docs/downloads/ — 官网安装包

**状态：当前发布包是 `imagegrab-v1.0.0.zip`，压缩包顶层即 `manifest.json`，解压后可直接被"加载已解压的扩展程序"识别。**
按 `scripts/check.mjs` 与 `scripts/package.mjs` 的约定，本目录**只保留最新一版**，历史版本交给 Git 标签或 GitHub Releases 归档（旧包留在目录里会让版本一致性校验直接失败）。
（见 [TESTING.md](../../TESTING.md) 第二节的 ZIP 加载验证）。

本目录是仓库中**唯一允许提交 ZIP 的地方**。`.gitignore` 中的规则特意为此开了口子：

```gitignore
*.zip                  # 忽略任意位置的临时 ZIP
!docs/downloads/*.zip  # 例外：本目录下的发布包必须保留
```

同时注意个人下载目录的忽略规则写成了根锚定的 `/downloads/`，而不是 `downloads/`。如果写成后者，Git 会连带忽略 `docs/downloads/`，发布包就提交不进去了。

## 目录内容约定

| 文件 | 说明 |
| --- | --- |
| `imagegrab-v<版本>.zip` | 安装包。ZIP 内是 `extension/` 的**内容位于根目录**（`manifest.json` 在压缩包顶层），解压后即可被"加载已解压的扩展程序"识别 |
| `SHA256SUMS.txt` | 每个安装包的 SHA-256 校验值，官网页面直接展示，供用户核对下载完整性 |
| `manifest.json` | 机器可读的发布信息：版本号、文件名、字节数、SHA-256、生成时间。官网用它渲染下载按钮，避免手工改版本号时漏改页面 |

## 维护规则

- 打包由 `node scripts/package.mjs` 生成，**不要手工往这里放 ZIP**。
  （当前这份包由 PowerShell 的 `Compress-Archive -Path '.\extension\*'` 直接生成，因此压缩包里还多一个 `extension/README.md`；
  `scripts/package.mjs` 的白名单打包会跳过它。两种包都能被"加载已解压的扩展程序"直接识别。）
- 只保留最新版本，历史版本通过 Git 标签或 GitHub Releases 归档。仓库体积会随二进制文件线性增长，且 Git 无法有效压缩已提交的 ZIP。
- 提交前必须让 `node scripts/check.mjs` 通过：它会校验这里的版本号与 `extension/manifest.json` 是否一致、校验值是否匹配。
- ZIP 中不得包含 `.env`、`*.key`、`*.pem`、`node_modules/`、临时测试目录等内容，打包逻辑采用白名单而非黑名单。
