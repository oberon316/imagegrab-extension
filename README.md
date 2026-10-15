# ImageGrab / 图提取

一个 Manifest V3 的 Chrome 浏览器扩展：把当前网页里的图片一次性找出来、挑好、批量下载，并支持可视区域截图与整页长图截图。配套一个纯静态官网，直接通过 GitHub Pages 发布。

> 当前状态：**已完成仓库骨架与需求/计划文档，尚未编写应用代码。**
> 需求见 [REQUIREMENTS.md](REQUIREMENTS.md)，实施步骤见 [PLAN.md](PLAN.md)。

## 它解决什么问题

普通用户想保存网页上的图片时，通常只有两种办法：右键一张张另存，或者打开开发者工具翻网络请求。两种都很慢，而且都会漏掉：

- 懒加载图片（滚动到才会真正加载的 `data-src` 图片）
- CSS 背景图（`background-image`，在 DOM 里看不到 `<img>`）
- `srcset` / `<picture>` 里当前实际生效的那一张
- 同源 iframe 内部、内联 SVG、`<canvas>` 里的内容

ImageGrab 把这些来源统一采集、去重、按尺寸和格式筛选，然后交给 `chrome.downloads` 批量下载到按域名分好的子目录里。

## 计划中的功能

| 分组 | 能力 |
| --- | --- |
| 采集 | `<img>` / `<picture>` / `srcset`、CSS 背景图、内联 SVG、`<canvas>`、`<video poster>`、`og:image` 与 favicon；同源 iframe 递归采集；可选自动滚动触发懒加载 |
| 筛选 | 去重、最小宽高、格式白名单、仅可见、仅背景图、URL 关键词包含/排除、按面积/顺序/文件大小排序 |
| 选择 | 缩略图网格、多选/全选/反选、大图预览、原页面元素高亮定位 |
| 下载 | 批量下载到 `ImageGrab/<域名>/<日期>/`、可自定义命名模板、并发控制与重试、失败清单 |
| 截图 | 可视区域截图、整页滚动拼接长图、单元素截图 |
| 设置 | 下载目录与命名模板、并发数、滚动超时、缩略图尺寸；设置经 `chrome.storage.sync` 同步 |
| 官网 | 功能介绍、安装指引、版本下载（含 SHA-256 校验）、隐私政策、更新日志 |

明确不做的事情（防止范围失控）：账号体系、云同步、付费、视频/音频下载、绕过付费墙或 DRM、采集需要登录态才可见的内容、上传任何用户数据到服务器。

## 目录结构

```
imagegrab-extension/
├─ extension/              # 可直接"加载已解压的扩展程序"的 MV3 插件源码（零构建）
│  └─ README.md            # 预留结构说明，代码尚未生成
├─ docs/                   # 纯静态官网，GitHub Pages 的发布目录
│  ├─ downloads/           # 官网提供的 ZIP 安装包（唯一保留 ZIP 的目录）
│  └─ README.md
├─ scripts/                # 校验与打包脚本（Node，无第三方依赖优先）
│  └─ README.md
├─ tests/                  # 本地测试素材、本地静态服务器与测试说明
│  └─ README.md
├─ README.md               # 本文件
├─ TESTING.md              # 实际测试记录（执行测试后逐条填写）
├─ REQUIREMENTS.md         # 需求说明书
├─ PLAN.md                 # 实施计划与里程碑
└─ .gitignore
```

`extension/`、`docs/`、`scripts/`、`tests/` 是四个彼此独立的关注点：插件只依赖浏览器 API，官网只依赖静态托管，脚本负责在提交前校验一致性，测试素材负责提供可复现的页面场景。

## 开发环境

- Node.js 18+（仅用于运行 `scripts/` 与 `tests/`，插件本身不依赖 Node）
- Chrome / Edge 120 或更新版本
- Git

```bash
git clone <repo-url>
cd imagegrab-extension
node --version   # 确认 18+
```

## 在浏览器中加载插件（解压目录方式）

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 修改 `extension/` 内的文件后，在扩展卡片上点「重新加载」；内容脚本改动还需刷新目标网页

## 从官网安装（ZIP 方式）

1. 打开官网（GitHub Pages 地址），下载最新版 `imagegrab-vX.Y.Z.zip`
2. 解压到任意固定目录（该目录不能删除，否则扩展会失效）
3. `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择解压出的目录

ZIP 包必须是解压后加载，浏览器的安全策略不允许直接双击安装 `.crx`。若后续上架 Chrome 应用商店，官网下载按钮会改为指向商店链接。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `node scripts/check.mjs` | 校验 manifest、图标、被引用文件、官网下载包与版本号一致性；失败时以非 0 退出 |
| `node scripts/package.mjs` | 把 `extension/` 打为 `docs/downloads/imagegrab-v<版本>.zip` 并生成 SHA-256 清单 |
| `node tests/local-server.mjs` | 在本地起静态服务器，用于打开 `tests/fixtures/` 下的测试页面 |

脚本尚未实现，接口约定见 [scripts/README.md](scripts/README.md)。

## 测试

手工测试用例、素材页面与执行步骤见 [tests/README.md](tests/README.md)；每次实际执行的结论（Chrome 版本、系统、预期与实际结果）记录到 [TESTING.md](TESTING.md)。

## 发布流程（概要）

1. 更新 `extension/manifest.json` 中的 `version`
2. `node scripts/check.mjs` 通过
3. `node scripts/package.mjs` 生成新的 ZIP 与校验值
4. 更新官网页面上的版本号与下载说明
5. 提交并推送，GitHub Pages 自动发布 `docs/`

## 隐私

扩展只在用户主动点击时读取当前标签页的 DOM 与图片地址，不采集页面文本以外的信息，不向任何服务器发送数据。设置项通过浏览器自带的 `chrome.storage` 保存在本地/浏览器账号内。官网为纯静态页面，无统计脚本、无第三方字体或 CDN 请求。

## 许可证

待确定（计划在首个可用版本前选定，例如 MIT）。
