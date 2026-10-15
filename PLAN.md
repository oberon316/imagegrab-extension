# ImageGrab / 图提取 — 实施计划

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1（草案） |
| 日期 | 2026-10-15 |
| 对应需求 | [REQUIREMENTS.md](REQUIREMENTS.md) |
| 当前进度 | M0 进行中（仓库骨架与文档已完成，代码未开始） |

工作量为单人开发的**粗略估算**，用于排序而非承诺。每个里程碑结束时都必须能在浏览器里看到可验证的结果，不做"写完一大坨再联调"。

---

## 里程碑总览

| 里程碑 | 目标 | 主要产出 | 预估 | 状态 |
| --- | --- | --- | --- | --- |
| M0 | 仓库骨架与工程约定 | 目录、`.gitignore`、README、测试记录模板、需求与计划文档 | 0.5 天 | 进行中 |
| M1 | 能采到图片并看见 | `manifest.json`、内容脚本采集内核、popup 列表 | 3 天 | 未开始 |
| M2 | 能挑图 | 侧边栏面板、筛选、网格、选择、元素高亮 | 3 天 | 未开始 |
| M3 | 能存下来 | 下载器、路径与命名模板、进度与失败清单、设置页 | 2.5 天 | 未开始 |
| M4 | 能截图 | 可视区域截图、整页拼接、固定元素处理 | 3 天 | 未开始 |
| M5 | 能发布 | 打包与校验脚本、官网、GitHub Pages、发布流程跑通 | 2.5 天 | 未开始 |
| M6 | 能长期用 | i18n、可访问性、虚拟化、边界场景打磨 | 2 天 | 未开始 |

M1–M3 完成即构成"首个可用版本"（对应 REQUIREMENTS §10 的放行条件）。M4、M5 可在 M3 之后并行推进。

---

## M0 — 仓库骨架与工程约定

**目标**：确定目录职责、忽略规则与文档基线，使后续每个改动都有放置位置。

**任务**

| 编号 | 任务 | 产出 |
| --- | --- | --- |
| M0-1 | 建立目录：`extension/`、`docs/`、`docs/downloads/`、`scripts/`、`tests/` | 已完成 |
| M0-2 | 编写 `.gitignore`：排除 `.env` 与凭据配置、`node_modules/`、临时测试目录、个人下载文件；用根锚定 `/downloads/` 避免误伤 `docs/downloads/`；`*.zip` 后跟 `!docs/downloads/*.zip` 保留发布包 | 已完成 |
| M0-3 | 编写 `README.md`（项目介绍、目录结构、加载方式、脚本用法、发布流程） | 已完成 |
| M0-4 | 编写 `TESTING.md` 并给出记录规范与用例框架 | 已完成 |
| M0-5 | 编写 `REQUIREMENTS.md` 与 `PLAN.md` | 已完成 |
| M0-6 | 各目录放 `README.md` 说明用途，保证空目录被 Git 跟踪 | 已完成 |
| M0-7 | `git init -b main` 并完成首次提交 | 已完成 |
| M0-8 | 确认 §13 的待确认决策（首发渠道、界面入口、零构建、许可证） | 用户确认 |

**验收**：`git log` 有一条初始提交；`git status` 干净；`.gitignore` 实测不忽略 `docs/downloads/` 下的 ZIP。

---

## M1 — 采集内核与最小可用界面

**目标**：点一下图标，就能看到页面里所有图片的地址列表。

**任务**

| 编号 | 任务 | 对应需求 | 产出文件 |
| --- | --- | --- | --- |
| M1-1 | `manifest.json`：MV3、最小权限集、`_locales`、图标占位 | NFR-300 | `extension/manifest.json`、`extension/icons/*` |
| M1-2 | 图标资源：先放程序生成的纯色带字 PNG（16/32/48/128），后续再美化 | FR-701 | `extension/icons/` |
| M1-3 | ImageItem 结构与校验、URL 规范化、文件名推导 | §8.1、FR-403 | `extension/lib/image-model.js`、`extension/lib/url-utils.js` |
| M1-4 | 采集内核：`<img>`、`srcset`、`<picture>`、懒加载属性 | FR-101/102/103 | `extension/content/collector.js` |
| M1-5 | 采集内核：CSS 背景图（含多重背景与 `image-set()`） | FR-104 | `extension/content/collector.js` |
| M1-6 | 内容脚本入口与消息监听（IIFE + 命名空间，不用静态 import） | NFR-400 | `extension/content/content-entry.js` |
| M1-7 | Service Worker：消息路由、注入采集脚本、结果回传 | §8.3 | `extension/background/service-worker.js` |
| M1-8 | popup 最小界面：图片数量 + URL 列表（此时还不做缩略图网格） | FR-701 | `extension/panel/popup.html/.js/.css` |
| M1-9 | 消息类型常量与发送封装 | §8.3 | `extension/lib/messaging.js` |
| M1-10 | 在 `chrome://extensions` 加载并跑通 `fixture-basic.html` | §10 | TESTING.md 记录 |

**技术要点**

- 采集在页面主线程执行，注意**不持有 DOM 引用**（NFR-100）；返回纯数据。
- 处理 `currentSrc` 与 `src` 的差异；相对路径用 `new URL(src, document.baseURI)` 转绝对地址。
- 背景图解析要处理 `url("...")`、`url(...)`、多值与 `image-set(url(a) 1x, url(b) 2x)`。
- 懒加载属性名做成可扩展数组，覆盖常见框架的命名习惯（FR-103）。

**验收**：在 `fixture-basic.html` 与 `fixture-css-bg.html` 上，popup 列出的图片与人工清点的结果完全一致；`fixture-edge.html` 的坏链接不导致报错。

---

## M2 — 侧边栏面板：筛选与选择

**目标**：把列表升级为可操作的缩略图网格，能筛、能挑、能定位。

**任务**

| 编号 | 任务 | 对应需求 | 产出文件 |
| --- | --- | --- | --- |
| M2-1 | 侧边栏面板骨架（`sidePanel` 权限 + `setPanelBehavior`） | FR-701 | `extension/panel/panel.html/.css/.js` |
| M2-2 | 筛选：最小宽高、格式白名单、仅可见、含背景图 | FR-203/204/205 | `extension/lib/filters.js` |
| M2-3 | 去重：规范化 URL 去重，合并重复来源 | FR-201/202 | `extension/lib/filters.js` |
| M2-4 | URL 关键词包含/排除 + 三种排序 | FR-206/207 | `extension/panel/panel.js` |
| M2-5 | 缩略图网格与选择交互（单击、全选、反选、Shift 范围） | FR-301/302/303 | `extension/panel/panel.js` |
| M2-6 | 筛选变化时保留已选状态 | FR-209 | `extension/panel/panel.js` |
| M2-7 | 自动滚动驱动懒加载 + 进度上报 + 中止 | FR-105/111/112 | `extension/content/scroll-driver.js` |
| M2-8 | 页面元素高亮/定位 | FR-109/305 | `extension/content/highlighter.js` |
| M2-9 | 大图预览页 | FR-304 | `extension/preview/preview.html/.css/.js` |
| M2-10 | 同源 iframe 递归采集与警告上报 | FR-106 | `extension/content/collector.js` |
| M2-11 | 采集结果在切换标签页/关闭面板后保留 | FR-307 | `extension/background/service-worker.js` |

**技术要点**

- 滚动驱动的节奏：`scrollStepPx` 步进 + `scrollDelayMs` 间隔 + `scrollTimeoutMs` 总超时；结束时收集新增的图片，汇报"滚动 N 次，新增 M 张"（对应 §12 风险对策）。
- Service Worker 随时可能被回收。任务状态必须落在 `chrome.storage.session`，不能只放在模块级变量里（NFR-600）。
- 面板与 SW 之间的消息一律带 `jobId` / `taskId`，避免多次采集的结果串台。
- 高亮元素必须插入带 `imagegrab-` 前缀的一次性样式，2 秒后自动清理（NFR-700）。

**验收**：`fixture-lazy.html` 开启自动滚动后采集到全部图片；`fixture-srcset-picture.html` 的当前生效项与候选列表正确；`fixture-iframe.html` 给出跨源警告；筛选切换不丢失选择。

---

## M3 — 下载、命名与设置

**目标**：选中一批图片，点一下，文件按规则落到下载目录里。

**任务**

| 编号 | 任务 | 对应需求 | 产出文件 |
| --- | --- | --- | --- |
| M3-1 | `chrome.storage` 设置读写、默认值合并、改动广播 | FR-601/602 | `extension/lib/storage.js` |
| M3-2 | 设置页（路径模板、命名模板、并发数、筛选默认值、主题） | FR-601/603 | `extension/options/options.html/.css/.js` |
| M3-3 | 下载调度：并发队列、重试一次、进度事件 | FR-401/404/406/407 | `extension/lib/downloader.js` |
| M3-4 | 下载路径与文件名模板渲染（含非法字符替换、重名加序号） | FR-402/403/405 | `extension/lib/url-utils.js` |
| M3-5 | Service Worker 侧下载编排与失败清单 | FR-401/406/407 | `extension/background/service-worker.js` |
| M3-6 | 面板底部下载区：目录预览、模板预览、进度条、失败展开重试 | FR-401/407 | `extension/panel/panel.js` |
| M3-7 | 右键菜单入口「提取此图片」「提取本页图片」 | FR-703 | `extension/background/service-worker.js` |
| M3-8 | 可选主机权限申请 + blob 回退下载（解决 403） | FR-408 | `extension/lib/downloader.js` |
| M3-9 | 设置页显示最近下载任务记录（可选，默认关闭） | FR-410/604 | `extension/options/options.js` |

**技术要点**

- `chrome.downloads.download` 的 `filename` 是相对于浏览器下载目录的路径，且不允许绝对路径与 `..`；需在渲染前做白名单字符校验。
- 并发控制用信号量，不要用 `setInterval` 轮询。
- 下载完成判定依赖 `chrome.downloads.onChanged`，不是 `download()` 返回就结束。
- blob 回退模式下在 SW 里 `fetch` 后转 `URL.createObjectURL`；注意 `downloads.download` 完成后要 `revokeObjectURL`，否则内存泄漏。
- data URL 与 blob URL 的命名规则单独处理，不能从 URL 直接推导扩展名，需靠 MIME 推断。

**验收**：`fixture-basic.html` 选中 10 张下载后，文件全部落在 `ImageGrab/<域名>/<日期>/` 下且命名符合预览；制造一个 403 的图片验证回退模式与失败清单。

---

## M4 — 截图与整页长图

**目标**：视口截图与整页长图可下载。

**任务**

| 编号 | 任务 | 对应需求 | 产出文件 |
| --- | --- | --- | --- |
| M4-1 | 可视区域截图与下载 | FR-501 | `extension/lib/capture.js` |
| M4-2 | 离屏文档（`offscreen` 权限）承载 Canvas 拼接 | NFR-300 | `extension/offscreen/offscreen.html/.js` |
| M4-3 | 分段滚动截图 + 拼接，注意 `captureVisibleTab` 的频率限制 | FR-502 | `extension/lib/capture.js` |
| M4-4 | 固定/粘性元素在截图期间隐藏并恢复 | FR-503 | `extension/content/highlighter.js`（复用一个临时样式注入器） |
| M4-5 | 高度与画布上限保护，超限提示 | FR-504 | `extension/lib/capture.js` |
| M4-6 | 高 DPI 缩放处理 | FR-505 | `extension/lib/capture.js` |
| M4-7 | 面板中加入截图区与参数（是否隐藏固定元素、最大高度） | FR-501/502 | `extension/panel/panel.js` |

**技术要点**

- `chrome.tabs.captureVisibleTab` 每秒最多调用约 2 次，切片间隔必须 ≥ 500ms，否则返回失败。整页截图天然较慢，界面必须给出进度，不能让用户以为卡死。
- 拼接需考虑 `devicePixelRatio`：每张切片像素宽高是视口尺寸乘以 DPR。
- 滚动过程中页面可能因懒加载改变高度，需在滚动前记录总高度、每步校验 `scrollY` 是否到位。
- 隐藏固定元素的判定：`getComputedStyle` 的 `position` 为 `fixed`/`sticky`，且元素高度小于视口高度（避免误伤整页容器）。结束时用 `try/finally` 确保样式一定被还原。

**验收**：`fixture-long-page.html`（约 3 屏高）拼接结果无重复行、无缺失行，页头只出现一次；2x 屏幕上文字清晰。

---

## M5 — 打包脚本、官网与发布

**目标**：`node scripts/check.mjs && node scripts/package.mjs` 之后，官网可下载到与源码版本一致的 ZIP。

**任务**

| 编号 | 任务 | 对应需求 | 产出文件 |
| --- | --- | --- | --- |
| M5-1 | `check.mjs`：按 REQUIREMENTS §7 的 10 项清单逐条校验，失败非 0 退出 | FR-900 | `scripts/check.mjs` |
| M5-2 | `package.mjs`：白名单打包 `extension/`，生成 `imagegrab-v<版本>.zip`、`SHA256SUMS.txt`、`downloads/manifest.json` | FR-803 | `scripts/package.mjs` |
| M5-3 | `serve.mjs`：本地预览 `docs/` 与 `tests/fixtures/` | — | `scripts/serve.mjs`、`tests/local-server.mjs` |
| M5-4 | 官网首页：功能、安装指引、下载按钮、常见问题 | FR-802/803 | `docs/index.html`、`docs/assets/style.css` |
| M5-5 | 隐私政策页，逐条解释权限用途 | FR-804 | `docs/privacy.html` |
| M5-6 | 更新日志页 | FR-805 | `docs/changelog.html` |
| M5-7 | 响应式 + 深色模式 + 无外部依赖 | FR-801/806/807 | `docs/assets/` |
| M5-8 | 404 页与 `.nojekyll` | FR-808 | `docs/404.html`、`docs/.nojekyll` |
| M5-9 | 开启 GitHub Pages（`main` 分支 `/docs` 目录）并验证线上可访问 | FR-809 | 仓库设置 |
| M5-10 | 写出发布流程清单：改版本号 → check → package → 更新官网 → 提交 → 打 tag | README | `README.md`、`PLAN.md` |

**关于 ZIP 打包的实现方式**

需要把 `extension/` 打成 ZIP。三个选项：

1. 开发依赖 `archiver` 或 `jszip` —— 最省事，但给一个"零依赖"的项目引入 `node_modules`。
2. 用 Node 内置 `zlib` 自行写 ZIP 容器（本地文件头 + 中央目录）—— 无依赖，约 120 行，且打包内容是可控的本地文件，不需要压缩率优化。
3. 调用系统 `Compress-Archive`（Windows）/ `zip`（macOS/Linux）—— 简单但跨平台分支维护成本高。

**建议选 2**：既保持零依赖，又能精确控制白名单（安全收益，对应 §12 的凭据泄漏风险）。若实现成本被证明高于预期，退回到方案 1，并在 README 里说明 `node_modules` 仅用于开发。

**技术要点**

- ZIP 内必须是 `extension/` 的**内容位于根**（即 `manifest.json` 在压缩包根目录），否则解压后无法直接加载。
- GitHub Pages 从 `/docs` 发布时，`docs/downloads/` 会随站点一起发布，ZIP 直接可下载；注意单个文件大小与仓库体积，避免把历史版本全部留在仓库里（建议只保留最新一版 + 一个 `SHA256SUMS.txt`）。
- GitHub Pages 默认启用 Jekyll，会忽略以下划线开头的文件；放一个空的 `.nojekyll` 可避免该类问题。

**验收**：下载官网 ZIP → 解压 → 加载已解压的扩展程序 → 功能正常；`check.mjs` 在版本号不一致时确实失败（故意改错验证一次）。

---

## M6 — 打磨

**目标**：让它在真实、脏乱的页面上依然稳定。

| 编号 | 任务 | 对应需求 |
| --- | --- | --- |
| M6-1 | 完整 i18n：`_locales/zh_CN`、`_locales/en`，代码中无硬编码文案，两个语言 key 集合一致 | FR-706、§7.4 |
| M6-2 | 键盘可达性与 ARIA：焦点环、`aria-label`、`aria-live` 播报选中数 | FR-705、NFR-500 |
| M6-3 | 缩略图网格虚拟化，验证 3000 张下的滚动流畅度 | FR-306、NFR-100 |
| M6-4 | 大页面采集分片，避免长任务阻塞主线程 | NFR-100 |
| M6-5 | 边界场景清扫：`<base>` 标签、CSS `url()` 带引号/转义、`blob:` 与 `data:`、超长 URL、同图不同参数、SVG `viewBox` | FR-101/102/104 |
| M6-6 | 验收走查：按 `tests/fixtures/` 全量执行，填写 TESTING.md | §10 |
| M6-7 | 万一需要上架：准备商店文案、截图、权限用途说明 | §13.1 |

---

## 依赖与顺序

```
M0 ──> M1 ──> M2 ──> M3 ──┬──> M6
                           └──> M4 ──> M5
```

- M1 是硬前提，M2 依赖 `collector.js` 的输出形态，M3 依赖 M2 的选择状态模型。
- M4（截图）与 M3 无耦合，可在 M3 期间并行做。
- M5 的官网可以在 M1 结束后就开始写静态页面（下载按钮先指向占位），不必等到全部功能完成。
- M6 的 i18n 建议不要等到最后：`_locales` 从 M1 就建立，文案随写随提取，否则后期集中替换成本很高。

---

## 测试策略

| 层级 | 手段 | 何时执行 |
| --- | --- | --- |
| 静态校验 | `node scripts/check.mjs`（manifest、引用文件、权限、i18n key、版本一致性） | 每次提交前 |
| 手工功能测试 | `tests/fixtures/` 七个场景页 + 记录到 TESTING.md | 每个里程碑结束时 |
| 真实站点巡检 | 选 3~5 个典型真实站点（电商详情页、图片站、新闻长文、含跨源 iframe 的页面） | M3、M4 完成后各一次 |
| 回归 | 上一个里程碑的用例重跑一遍 | 每个里程碑开始时 |

暂不引入自动化 UI 测试：扩展的手工验证成本低于搭建 Puppeteer 扩展测试环境的成本，且场景页本身就是可复现的。若 M6 之后仍有回归遗漏，再评估引入自动化。

---

## 当前状态与下一步

**已完成（M0）**

- 目录骨架：`extension/`、`docs/`、`docs/downloads/`、`scripts/`、`tests/`
- `.gitignore`（含根锚定 `/downloads/` 与 `!docs/downloads/*.zip` 的例外规则）
- `README.md`、`TESTING.md`、`REQUIREMENTS.md`、`PLAN.md`
- 各子目录的 `README.md` 占位说明
- Git 仓库初始化，主分支 `main`，含首次提交

**下一步（M1-1 起）**

1. 确认 REQUIREMENTS §13 的待确认决策（尤其：首发渠道、界面入口、是否零构建、许可证）
2. 生成 `extension/manifest.json` 与图标占位
3. 实现 `collector.js` 与 `content-entry.js`，先在 `fixture-basic.html` 上跑通
4. 用 popup 把结果显示出来

**暂不生成任何应用代码**——等 §13 的决策确认后再开始 M1。
