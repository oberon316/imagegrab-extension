# ImageGrab / 图提取 — 实施计划

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.2 |
| 日期 | 2026-10-15 |
| 对应需求 | [REQUIREMENTS.md](REQUIREMENTS.md) |
| 当前进度 | M0、M1 完成；M2、M3、M6 的关键部分完成并已在真实 Chrome 中验证；M5 的脚本与官网页面已完成（只剩开启 GitHub Pages 一步）；M4 未开始 |

工作量为单人开发的**粗略估算**，用于排序而非承诺。每个里程碑结束时都必须能在浏览器里看到可验证的结果，不做"写完一大坨再联调"。

---

## 里程碑总览

| 里程碑 | 目标 | 主要产出 | 预估 | 状态 |
| --- | --- | --- | --- | --- |
| M0 | 仓库骨架与工程约定 | 目录、`.gitignore`、README、测试记录模板、需求与计划文档 | 0.5 天 | 已完成 |
| M1 | 能采到图片并看见 | `manifest.json`、内容脚本采集内核、图库列表 | 3 天 | 已完成（界面形态按用户要求改为 `gallery.html`，未做 popup） |
| M2 | 能挑图 | 图库页面的筛选、网格、选择 | 3 天 | 部分完成（见下方交付状态） |
| M3 | 能存下来 | 下载器、命名、进度与失败清单 | 2.5 天 | 部分完成（见下方交付状态） |
| M4 | 能截图 | 可视区域截图、整页拼接、固定元素处理 | 3 天 | 未开始 |
| M5 | 能发布 | 打包与校验脚本、官网、发布流程 | 2.5 天 | 部分完成（脚本与官网三个页面已就绪；剩 GitHub Pages 未开启、更新日志页与官网深色模式两个 P1 项） |
| M6 | 能长期用 | i18n、可访问性、虚拟化、边界场景打磨 | 2 天 | 部分完成（见下方交付状态） |

M1–M3 的已交付部分构成"首个可用版本"，并已在真实 Chrome 中逐条验证（见 [TESTING.md](TESTING.md)）。

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

| 编号 | 任务 | 对应需求 | 产出文件 | 状态 |
| --- | --- | --- | --- | --- |
| M5-1 | `check.mjs`：按 REQUIREMENTS §7 的 10 项清单逐条校验，失败非 0 退出 | FR-900 | `scripts/check.mjs` | 已完成（18 项，另含"官网与发布包一致"） |
| M5-2 | `package.mjs`：白名单打包 `extension/`，生成 `imagegrab-v<版本>.zip`、`SHA256SUMS.txt`、`downloads/manifest.json` | FR-803 | `scripts/package.mjs` | 已完成（自写 ZIP 容器，零依赖） |
| M5-3 | `serve.mjs`：本地预览 `docs/` 与 `tests/fixtures/` | — | `scripts/serve.mjs`、`tests/local-server.mjs` | 已完成 |
| M5-4 | 官网首页：功能、安装指引、下载按钮、常见问题 | FR-802/803 | `docs/index.html`、`docs/assets/style.css` | 已完成 |
| M5-5 | 隐私政策页，逐条解释权限用途 | FR-804 | `docs/privacy.html` | 已完成，并与 `manifest.json` 的 5 项权限、13 条主机权限逐条对齐 |
| M5-6 | 更新日志页 | FR-805 | `docs/changelog.html` | 未做（当前只有 1.0.0 一个版本，尚无变更可记，见 `docs/README.md` 的说明） |
| M5-7 | 响应式 + 深色模式 + 无外部依赖 | FR-801/806/807 | `docs/assets/` | 部分完成：响应式（4 档断点，含 360px）与零外部依赖（1 个 CSS、1 个 JS、无 CDN/字体/统计）已完成；**深色模式未做**（全站只有 `@media(prefers-reduced-motion)`，没有 `prefers-color-scheme`） |
| M5-8 | 404 页与 `.nojekyll` | FR-808 | `docs/404.html`、`docs/.nojekyll` | 已完成 |
| M5-9 | 开启 GitHub Pages（`main` 分支 `/docs` 目录）并验证线上可访问 | FR-809 | 仓库设置 | **未做**，需要在仓库设置里手动开启后再验证一次 |
| M5-10 | 写出发布流程清单：改版本号 → check → package → 更新官网 → 提交 → 打 tag | README | `README.md`、`PLAN.md` | 已完成（`README.md` 的"发布流程"8 步） |

**关于 ZIP 打包的实现方式**

需要把 `extension/` 打成 ZIP。三个选项：

1. 开发依赖 `archiver` 或 `jszip` —— 最省事，但给一个"零依赖"的项目引入 `node_modules`。
2. 用 Node 内置 `zlib` 自行写 ZIP 容器（本地文件头 + 中央目录）—— 无依赖，约 120 行，且打包内容是可控的本地文件，不需要压缩率优化。
3. 调用系统 `Compress-Archive`（Windows）/ `zip`（macOS/Linux）—— 简单但跨平台分支维护成本高。

**实际选了 2**：`scripts/lib/zip.mjs` 是自写的 ZIP 容器（本地文件头 + 中央目录 + CRC32），零依赖、白名单可控，`package.mjs` 打完包会立刻读回来逐条校验 CRC。

> 一个遗留的不一致：**线上这份 1.0.0 安装包并不是 `package.mjs` 打的**，而是用 PowerShell 的 `Compress-Archive -Path '.\extension\*'` 直接压的，因此包内多一个 `extension/README.md`（21 个条目，`package.mjs` 的白名单产出是 20 个，会跳过 `.md`）。
> 两种包都能被"加载已解压的扩展程序"识别，所以不影响使用，但只有 `package.mjs` 的产出是可复现的。
> **2026-10-15 决定不重打**：重打只会改变已对外展示的 SHA-256，换来的仅是包内少一个说明文件；从下一个版本起直接用 `package.mjs` 产出，届时两者即自然统一。

**技术要点**

- ZIP 内必须是 `extension/` 的**内容位于根**（即 `manifest.json` 在压缩包根目录），否则解压后无法直接加载。
- GitHub Pages 从 `/docs` 发布时，`docs/downloads/` 会随站点一起发布，ZIP 直接可下载；注意单个文件大小与仓库体积，避免把历史版本全部留在仓库里（建议只保留最新一版 + 一个 `SHA256SUMS.txt`）。
- GitHub Pages 默认启用 Jekyll，会忽略以下划线开头的文件；放一个空的 `.nojekyll` 可避免该类问题。

**验收**：下载官网 ZIP → 解压 → 加载已解压的扩展程序 → 功能正常；`check.mjs` 在版本号不一致时确实失败（故意改错验证一次）。

> 2026-10-15 的实测：把首页上的体积 `52.3 KB` 故意改回上一版的 `46.6 KB`，`check.mjs` 报出
> "官网首页没有出现当前发布包的安装包体积 52.3 KB，可能还挂着上一版"并以退出码 1 结束，改回后恢复通过。
> 这条检查覆盖版本号、体积、SHA-256 与下载按钮文件名四项，任意一项漏改都会失败。

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
| 静态校验 | `node scripts/check.mjs`（manifest、引用文件、权限、配色与消息常量一致性、SW 是否用了 DOM API、ZIP 可解压且校验值匹配、官网页面与当前发布包是否一致） | 每次提交前 |
| 逻辑测试 | `node --test "tests/*.test.mjs"`（DOM 桩，采集内核与工具函数） | 每次提交前 |
| 真实浏览器端到端 | `node tests/browser-e2e.mjs`（自动拉起临时 Chrome，加载扩展跑完整流程并断言） | 每个里程碑结束时 |
| 真实站点巡检 | 选 3~5 个典型真实站点（电商详情页、图片站、新闻长文、含跨源 iframe 的页面），手工并记录到 TESTING.md | M3、M4 完成后各一次 |
| 回归 | 上一个里程碑的用例重跑一遍 | 每个里程碑开始时 |

自动化到什么程度：**能在真实浏览器里断言的部分已经自动化**（16 条 E2E），
浏览器 UI 本身（工具栏图标点击、右键菜单、角标数字）和真实店铺页面仍必须手工验证，
这些在 [TESTING.md](TESTING.md) 第五节逐条列出并标注"未执行"，不冒充通过。

---

## 当前状态与下一步

### 已交付并在真实浏览器中验证

`extension/` 是一个可加载运行的 MV3 扩展（零构建，源码即运行代码）。逐条证据见 [TESTING.md](TESTING.md)。

| 里程碑 | 已交付 | 验证方式 |
| --- | --- | --- |
| M0 | 目录骨架、`.gitignore`、四份文档、各子目录 README、Git 初始化 | 静态检查 |
| M1 | `manifest.json`、真实 PNG 图标、采集内核（`img`/`currentSrc`/`srcset`/`data-src`/`data-lazy-src`/背景图/`poster`/`og:image`）、内容脚本入口与消息协议、后台路由与角标 | E2E-01、E2E-05；`collector.test.mjs` 11 例 |
| M2 | 去重与来源合并、最小宽高筛选、未加载图片标记与提示、全选/反选/取消/点缩略图选择、跨筛选保留选择、"重新扫描本页"、结果落在 `chrome.storage.session` | E2E-05、E2E-07、E2E-08、E2E-09、E2E-14、E2E-15 |
| M3 | 下载调度（并发、超时、`onChanged` 判定完成）、命名 `商品图_001.png`、进度与逐项状态、失败清单与"重试失败项"、右键菜单入口、单张失败不中断整批 | E2E-11、E2E-12、E2E-16 |
| M5（部分） | `check.mjs`（18 项）、`package.mjs`（自写 ZIP 容器，零依赖）、`serve.mjs`、发布包与 SHA-256；官网三个页面（`index.html` / `privacy.html` / `404.html`）、样式与脚本、`.nojekyll`、界面截图与图标 | `check.mjs` 逐项；官网 30 处内链经本地 HTTP 实测无断链、下载按钮与发布包一致（TESTING.md 第八节）；解压后的安装包另跑一轮 18 条 E2E（针对上一版 0.1.0 包） |
| M6（部分） | ARIA 标注与 `aria-live`、焦点环、缩略图分片渲染（每批 200 条） | `check.mjs`、E2E-08 |

### 尚未实现

| 项 | 说明 |
| --- | --- |
| M2 的排序、URL 关键词包含/排除、元素高亮定位、大图预览页、同源 iframe 递归采集 | 未实现。用户当前需求未包含这些 |
| M2-7 自动滚动驱动懒加载 | 未实现，改为提示用户手动滚动后点"重新扫描本页"（TESTING.md LIM-01） |
| M3 的下载路径模板、独立设置页、可选主机权限申请 | 未实现。筛选默认值直接存在图库页面并在 `chrome.storage.local` 持久化；非授权域名改为给出可读提示（TESTING.md LIM-08） |
| M4 截图与整页长图 | 未开始 |
| M5 的更新日志页（`docs/changelog.html`，FR-805） | 未生成：当前只有 1.0.0 一个版本，没有变更可记。发布第二个版本时再补 |
| M5 的官网深色模式（FR-807，P1） | 未实现：`docs/assets/style.css` 里没有 `prefers-color-scheme`，而写死的色值散落在 `:root` 变量之外，要先做一次样式重构（TESTING.md LIM-10） |
| M5-9 开启 GitHub Pages（FR-809，P0） | 需要在仓库设置里手动开启，并到线上验证一次下载按钮与 `.nojekyll` |
| M6 的完整 i18n（`_locales`）、网格虚拟化 | 未实现，界面文案为中文硬编码 |

### 下一步建议

1. 在仓库设置里开启 GitHub Pages（`main` 分支 `/docs` 目录），然后按 TESTING.md 的 TC-WEB-LIVE-01 到线上验证一次：这一步做完，M5 就只剩"更新日志页"和"官网深色模式"两个 P1 项。
2. 把 1.0.0 的安装包按 `scripts/package.mjs` 重打一遍，替换掉现在这份 `Compress-Archive` 产物，让发布物与发布脚本一致（详见 TESTING.md 第八节）。**2026-10-15 决定暂不重打**：两种包都能正常加载，差异只是包内多一个 `extension/README.md`；等 1.0.1 或下一个版本发布时，直接用 `package.mjs` 产出即可，不必为此单独改一次已发布的校验值。
3. 在真实的淘宝/天猫/京东/拼多多详情页各跑一次（TESTING.md 第五节的手工用例），确认详情页识别规则与长图采集效果。
4. 决定许可证，然后按 README 的发布流程打标签。
