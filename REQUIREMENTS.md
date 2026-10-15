# ImageGrab / 图提取 — 需求说明书

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1（草案） |
| 日期 | 2026-10-15 |
| 状态 | 待评审 |
| 对应实施计划 | [PLAN.md](PLAN.md) |
| 目标平台 | Chrome / Edge，Manifest V3 |

---

## 1. 背景与目标

### 1.1 背景

在网页上批量保存图片目前只能靠"右键逐张另存"或"开发者工具看网络请求"。这两种方式都无法可靠覆盖懒加载图片、CSS 背景图、`srcset` 生效项、同源 iframe 内容；即便找到地址，也要手工重命名归档。

### 1.2 产品目标

1. **一次点击，页面图片全量可见**：把页面里所有可下载的图片来源汇总成一个列表，不漏、不重复。
2. **挑得动**：在缩略图网格里按尺寸/格式/可见性筛选和排序，多选后一次性下载。
3. **存得整齐**：按域名与日期自动建目录，文件名可自定义模板，下载失败有明确清单可重试。
4. **顺带能截图**：可视区域截图与整页长图，用于保存那些拿不到图片地址的内容。
5. **可被信任、可被安装**：权限最小化、无数据外传；官网提供不需要安装 Node 的 ZIP 下载方式。

### 1.3 成功标准

- 在 `tests/fixtures/` 的六个场景页面上，采集结果的**召回率**与**精确率**均可人工核对通过（详见 §10 验收标准）。
- 单页面 300 张图片时，从点击图标到网格可交互 < 3 秒（本机、冷启动）。
- 打包 ZIP 双击解压后可通过「加载已解压的扩展程序」直接加载，无控制台报错。
- 官网下载包与 `extension/manifest.json` 版本号一致，SHA-256 可校验。

---

## 2. 目标用户与场景

| 用户 | 场景 | 关心什么 |
| --- | --- | --- |
| 内容/设计从业者 | 从竞品落地页、素材站收集参考图 | 背景图与懒加载图要全套；文件名有意义 |
| 电商运营 | 收集商品图与详情长图 | 批量下载要快；长图要完整不截断 |
| 普通用户 | 保存一组照片、漫画、表情包 | 简单、点几下就好；不要广告和弹窗 |
| 前端开发 | 检查页面实际加载了哪些图片、多大 | 要能看到真实地址、尺寸、格式、来源类型 |

### 2.1 用户故事

- US-01：作为运营，我在商品详情页点击扩展图标后，希望立刻看到所有图片缩略图，并能一键全选下载。
- US-02：作为设计师，我希望页面滚动到底之前就采集到懒加载图片，不必手工滚动。
- US-03：作为普通用户，我希望下载下来的图片按网站分好文件夹，不要全堆在"下载"里。
- US-04：作为开发，我希望看到每张图是来自 `<img>` 还是 CSS 背景，以及它真实的像素尺寸。
- US-05：作为用户，我想把一整页长图保存成一张图片，用于存档或打印。
- US-06：作为谨慎的用户，我想在动手前知道这个扩展申请了什么权限、会不会读我的其他标签页。

---

## 3. 名词表

| 名词 | 含义 |
| --- | --- |
| 采集（Collect） | 在页面上下文中遍历 DOM 与样式，产出候选图片列表的过程 |
| ImageItem | 采集产出的单条图片记录，字段见 §8.1 |
| 来源类型（kind） | 该图片被发现的途径：`img` / `picture` / `css-background` / `inline-svg` / `canvas` / `video-poster` / `meta-og` / `link-icon` |
| 可见（visible） | 元素计算样式非 `display:none`、`visibility:hidden`、`opacity:0`，且尺寸大于 0 |
| 懒加载触发 | 通过自动滚动让 `IntersectionObserver` / `data-src` 图片真正加载 |
| 切片（slice） | 整页截图时按视口高度分段捕获的单张画面 |
| 面板（Panel） | 扩展的侧边栏界面，用于展示与选择图片 |
| 热链保护 | 服务端校验 `Referer` 等头部，导致直接下载得到 403 的行为 |

---

## 4. 功能需求

优先级：**P0** 首个可用版本必须完成；**P1** 首个公开版本应完成；**P2** 后续迭代。

### 4.1 采集（FR-100）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-101 | 采集当前标签页所有 `<img>`，使用 `currentSrc` 优先、`src` 兜底 | P0 | `fixture-basic.html` 中每张 `<img>` 均出现且 URL 正确 |
| FR-102 | 解析 `srcset` 与 `<picture>/<source>`，取当前实际渲染的那一项，同时保留其他候选尺寸 | P0 | `fixture-srcset-picture.html` 结果与浏览器实际显示一致；可选列表中列出所有候选 |
| FR-103 | 识别懒加载属性：`data-src`、`data-original`、`data-lazy-src`、`data-echo`、`loading="lazy"` | P0 | `fixture-lazy.html` 未滚动时也能采集到全部图片地址 |
| FR-104 | 遍历元素计算样式，提取 `background-image`（含多重背景、`image-set()`） | P0 | `fixture-css-bg.html` 中所有背景图被采集，且标注 `kind: css-background` |
| FR-105 | 可选自动滚动触发懒加载后再采集 | P0 | 开启后 `fixture-lazy.html` 中滚动才出现的图片被采集；滚动过程可中止，超时后有提示 |
| FR-106 | 同源 iframe 递归采集，结果标注所属 frame | P1 | `fixture-iframe.html` 中同源 iframe 的图片被采集；跨源 iframe 跳过并在报告中记一条警告 |
| FR-107 | 采集体 `<video poster>`、`<link rel="icon">`、`<meta property="og:image">` | P1 | `fixture-basic.html` 中以上来源均出现 |
| FR-108 | 可选采集内联 `<svg>`（序列化为 data URL）与 `<canvas>`（`toDataURL`） | P2 | `fixture-svg-canvas.html` 中两类内容可选择采集；默认关闭，避免体积爆炸 |
| FR-109 | 采集时记录元素的 CSS 选择器路径，供高亮定位 | P1 | 点击列表项可在页面上高亮对应元素 |
| FR-110 | 单个图片资源加载失败时不得中断整体采集 | P0 | `fixture-edge.html` 含坏链接，采集完成并返回其余结果 |
| FR-111 | 采集过程上报进度（已扫描节点数 / 已发现图片数 / 当前阶段） | P1 | 面板显示进度；大页面（>3000 张）不出现界面卡死 |
| FR-112 | 用户可随时中止采集 | P1 | 点击中止后 200ms 内停止，已采集结果保留 |

### 4.2 去重、筛选与排序（FR-200）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-201 | 按规范化 URL 去重；同一 URL 出现多次只保留一条，并合并来源信息 | P0 | `fixture-edge.html` 中重复引用的同一图片只出现一次 |
| FR-202 | 过滤 `data:` 内联小图（阈值可配置，默认 <1KB 且仅用于布局时排除） | P1 | 1x1 占位图不进入列表；被保留的内联图标注 `kind: inline-data` |
| FR-203 | 按最小宽高过滤 | P0 | 设定 200×200 后，小于该尺寸的图片不显示 |
| FR-204 | 按格式白名单过滤（jpg/jpeg/png/webp/gif/svg/avif/bmp） | P0 | 取消勾选 GIF 后 GIF 不再出现在列表 |
| FR-205 | 「仅显示可见元素」开关 | P1 | 关闭后出现隐藏元素中的图片 |
| FR-206 | URL 关键词包含 / 排除 | P1 | 输入排除 `sprite` 后相关图片被隐藏 |
| FR-207 | 排序：面积、DOM 顺序、文件大小 | P1 | 三种排序结果稳定且与标注一致；文件大小未知的排在末尾 |
| FR-208 | 探测文件大小与 MIME（HEAD 请求，失败时回退为未知） | P2 | 有 `Content-Length` 时显示大小；网络失败不报错，显示"—" |
| FR-209 | 筛选条件即时生效，不清空已选项 | P0 | 修改筛选后，仍可见的已选图片保持勾选状态 |

### 4.3 预览与选择（FR-300）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-301 | 缩略图网格展示图片、尺寸、格式、来源类型 | P0 | 网格正确渲染，图片加载失败时显示占位与错误标记 |
| FR-302 | 单击选中/取消，支持全选、反选、清除选择 | P0 | 选择状态与计数实时更新 |
| FR-303 | Shift 范围选择、Ctrl/Cmd 追加选择 | P1 | 操作行为与系统文件管理器一致 |
| FR-304 | 点击缩略图打开大图预览，可左右切换 | P1 | 预览中显示原始尺寸与完整 URL，可复制 URL |
| FR-305 | 一键定位：让原页面滚动并高亮对应元素 | P1 | 高亮持续 2 秒后自动消失 |
| FR-306 | 网格虚拟化：图片超过 500 张时只渲染可视区域 | P1 | 3000 张图片下滚动帧率不低于 45fps |
| FR-307 | 采集结果在面板关闭后保留，切回标签页可继续操作 | P1 | 同标签页切换前后选择状态不变 |

### 4.4 批量下载（FR-400）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-401 | 通过 `chrome.downloads` 批量下载已选图片 | P0 | 选中 10 张后全部出现在下载目录 |
| FR-402 | 下载到子目录 `ImageGrab/<域名>/<日期>/`，路径模板可配置 | P0 | 下载文件确实落在该相对路径下 |
| FR-403 | 文件名模板支持 `{index}` `{name}` `{w}` `{h}` `{date}` `{domain}` | P0 | 修改模板后文件名按模板生成 |
| FR-404 | 并发上限可配置（默认 4），避免触发浏览器限制 | P0 | 同时进行中的下载数不超过设定值 |
| FR-405 | 非法文件名字符自动替换，重名自动加序号后缀 | P0 | 同名图片不会互相覆盖 |
| FR-406 | 下载失败自动重试 1 次，仍失败则记录到失败清单 | P1 | 失败清单显示 URL 与原因，可单独重试 |
| FR-407 | 下载进度与汇总（成功 / 失败 / 总数）实时显示 | P0 | 进度条与计数随下载推进更新 |
| FR-408 | 热链保护导致失败时，回退为在扩展后台 `fetch` 取 blob 再下载 | P1 | 开启后 403 图片可成功下载；仅在用户授予可选主机权限后可用 |
| FR-409 | 可选将所选图片打包为一个 ZIP 下载 | P2 | ZIP 内容完整、可正常解压 |
| FR-410 | 记录最近若干次下载任务（时间、数量、结果），供回溯 | P2 | 设置页可查看最近 20 条任务记录 |

### 4.5 截图（FR-500）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-501 | 可视区域截图并下载 PNG | P1 | 截图内容与当前视口可见内容一致 |
| FR-502 | 整页长图：自动分段滚动 + 拼接 | P1 | 高度为 3 屏的测试页拼接后无重复、无缺失 |
| FR-503 | 拼接前隐藏 `position:fixed/sticky` 元素，避免重复出现；结束后恢复 | P1 | 长图中页头只出现一次；原页面样式被完整还原 |
| FR-504 | 页面高度上限保护（默认 20000px）与画布尺寸保护 | P1 | 超长页面提示并截断，不出现空白或崩溃 |
| FR-505 | 高 DPI 屏幕按 `devicePixelRatio` 缩放，避免模糊 | P1 | 2x 屏幕上截图清晰度符合预期 |
| FR-506 | 单元素截图 | P2 | 指定元素完整出现在图片中，含溢出隐藏内容时给出提示 |
| FR-507 | 区域内框选截图 | P2 | 拖拽框选后可下载框选内容 |

### 4.6 设置与本地数据（FR-600）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-601 | 设置项：下载路径模板、文件名模板、并发数、最小宽高、格式白名单、滚动超时、缩略图尺寸、主题 | P0 | 修改后立即生效并持久化 |
| FR-602 | 设置通过 `chrome.storage.sync` 同步，容量不足时降级到 `local` | P1 | 换设备登录同一浏览器账号后设置保持一致 |
| FR-603 | 提供「恢复默认设置」 | P1 | 一键恢复，且不影响已采集结果 |
| FR-604 | 提供采集与下载的历史统计（可选开关，默认关闭） | P2 | 关闭时不写入任何历史数据 |

### 4.7 交互入口与界面（FR-700）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-701 | 点击工具栏图标打开侧边栏面板（Side Panel），不遮挡页面 | P0 | 侧边栏在当前标签页打开，切换标签页时内容随之切换 |
| FR-702 | 侧边栏内提供「重新采集」按钮与筛选区 | P0 | 按钮可重复触发采集 |
| FR-703 | 右键菜单「提取此图片」「提取本页图片」 | P1 | 右键图片可直接加入采集结果 |
| FR-704 | 侧边栏宽度不足时自动切换为单列布局 | P1 | 窄宽度下无横向滚动条 |
| FR-705 | 键盘可达：Tab 遍历、空格与回车触发、Esc 关闭预览 | P1 | 全流程可无鼠标完成 |
| FR-706 | 界面语言按浏览器语言自动切换（简体中文 / 英文） | P1 | 切换浏览器语言后界面文案跟随变化 |

### 4.8 官网（FR-800）

| 编号 | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| FR-801 | 纯静态站点，无构建步骤、无框架、无外部 CDN 依赖 | P0 | 直接用浏览器打开 `docs/index.html` 即可正常显示（下载功能除外） |
| FR-802 | 首页包含：功能说明、安装指引、下载按钮、常见问题 | P0 | 内容完整，安装步骤与 README 一致 |
| FR-803 | 下载按钮指向 `docs/downloads/imagegrab-v<版本>.zip`，并显示版本号、文件大小、SHA-256 | P0 | 点击可下载；校验值与 `scripts/package.mjs` 输出一致 |
| FR-804 | 隐私政策页，说明权限用途与数据流向（Chrome 应用商店要求） | P0 | 逐条解释每个权限的用途，声明不采集上传数据 |
| FR-805 | 更新日志页 | P1 | 记录每个版本的变更 |
| FR-806 | 响应式布局，移动端可正常阅读 | P1 | 宽度 360px 下无内容溢出 |
| FR-807 | 支持深色模式（跟随系统） | P1 | 系统深色下配色与对比度符合 §5.5 |
| FR-808 | 404 页面 | P2 | 访问不存在路径时展示自定义页面 |
| FR-809 | 通过 GitHub Pages 从 `docs/` 目录发布 | P0 | 推送到 `main` 后站点自动更新 |
| FR-810 | 每张安装包提供 SHA-256 文本，便于用户核对 | P1 | 页面上可直接复制校验值 |

---

## 5. 非功能需求

### 5.1 性能（NFR-100）

- 300 张图片的页面：采集 < 1.5s，面板首屏可交互 < 3s（本机冷启动）。
- 5000 张图片的页面：采集不得阻塞页面主线程超过 50ms/帧；采集分片执行，使用 `requestIdleCallback` 或时间片切分。
- 内存：采集结果不得长期持有 DOM 节点引用（只保存字符串与数值），防止页面无法回收。
- 缩略图使用 `loading="lazy"` 与 `decoding="async"`，不预加载全量原图；缩略图优先使用页面已缓存的原图 URL，不额外发起请求；若为超大图则按需生成小尺寸预览（可选）。

### 5.2 隐私与数据（NFR-200）

- 扩展**不向任何服务器发送数据**，代码中不得出现外部上报接口。
- 不读取与用户操作无关的标签页内容。
- 官网不引入统计脚本、第三方字体、CDN，避免任何第三方请求。
- 采集结果默认只保存在内存与 `chrome.storage.local`（仅在用户开启历史功能时持久化）。

### 5.3 权限最小化（NFR-300）

必须申请的权限及理由：

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 用户点击图标后，才获得当前标签页的读取权限。这样无需申请全站主机权限 |
| `scripting` | 向当前标签页注入采集与滚动脚本 |
| `downloads` | 批量下载图片与截图 |
| `storage` | 保存设置 |
| `sidePanel` | 提供侧边栏面板 |
| `contextMenus` | 右键菜单入口 |
| `offscreen` | 在离屏文档中完成长图拼接（MV3 中 Service Worker 无法使用 Canvas） |

**可选权限**（运行时由用户在需要时授予）：`optional_host_permissions: ["*://*/*"]`，仅用于「回退下载模式」（FR-408，解决热链保护）与跨源 iframe 采集。未授予时功能降级并给出说明，不使用户困惑。

不得申请：`tabs`（全量标签页信息）、`webRequest`、`debugger`、`<all_urls>` 作为必需权限、`history`、`cookies`。

> 注：整页截图若改用 Chrome DevTools Protocol 的 `Page.captureScreenshot`（`captureBeyondViewport`）可得到更完美的结果，但需要 `debugger` 权限并会显示"正在调试此浏览器"横幅，与最小权限原则冲突，故不作为默认方案（见 §12）。

### 5.4 兼容性与可维护性（NFR-400）

- 目标浏览器：Chrome 120+、Edge 120+；不保证 Firefox（Firefox 的 MV3 对 `sidePanel`、`offscreen` 支持不同）。
- **零构建**：插件源码即发布产物，全部为原生 ES2022 + HTML + CSS，不引入打包器、框架或编译步骤。理由：满足"可直接加载"，便于审阅，也避免应用商店对压缩代码的额外审查。
- 模块组织：Service Worker / 面板 / 设置页使用 ES Module（`type: "module"`）；内容脚本受 MV3 限制不能用静态 `import`，采用 IIFE + 单一命名空间 `window.__ImageGrab` 的内部模块划分。
- 无第三方运行时依赖。`scripts/` 与 `tests/` 依赖 Node 内置模块，若必须引入打包库，需在 PLAN 中单独说明理由。

### 5.5 可访问性与国际化（NFR-500）

- 面板与官网的对比度符合 WCAG AA（正文 ≥ 4.5:1，大字 ≥ 3:1）。
- 所有交互控件可键盘操作，焦点可见；图标按钮必须有 `aria-label`。
- 缩略图网格使用列表语义（`role="list"` / `option`），并在切换时通过 `aria-live` 播报选中数量。
- 界面文案全部走 `chrome.i18n`（`_locales/zh_CN`、`_locales/en`），代码中不出现硬编码文案。
- 官方文档语言：中文为主，官网提供英文摘要页（P2）。

### 5.6 健壮性（NFR-600）

- 页面被导航、标签页被关闭、Service Worker 被回收时，进行中的任务必须被正确清理，不留下报错。
- 所有消息传递使用 `try/catch` 包裹，目标 frame 不存在时降级而不是抛出。
- 采集失败时给用户可见的原因（如"该页面禁止扩展注入"），不静默失败。

### 5.7 安全（NFR-700）

- 内容脚本向页面注入的样式使用 CSS 自定义属性与高特异性前缀（`imagegrab-`），不污染页面样式，结束后清理。
- 不执行从页面读取的任何字符串（不使用 `eval`、`new Function`、`innerHTML` 拼接 URL 文本）。面板渲染使用 `textContent` 与 `createElement`。
- 校验所有即将下载的 URL 协议，仅允许 `http:`、`https:`、`data:`（作为内联图）。拒绝 `javascript:`、`file:`、`chrome:`。
- ZIP 包中不得包含 `manifest` 之外的敏感文件；打包脚本需显式排除 `.env`、`*.key`、`node_modules`、临时目录。

---

## 6. 目录与文件结构（目标形态）

```
extension/
├─ manifest.json
├─ icons/                      16/32/48/128 四种尺寸 PNG
├─ background/
│  └─ service-worker.js        消息路由、下载调度、截图编排、权限申请
├─ offscreen/
│  └─ offscreen.html/.js       长图拼接（Canvas）
├─ content/
│  ├─ collector.js             DOM 与样式采集（核心）
│  ├─ scroll-driver.js         自动滚动触发懒加载
│  ├─ highlighter.js           元素高亮
│  └─ content-entry.js         内容脚本入口（IIFE，按需调用上述模块并注册消息监听）
├─ panel/
│  ├─ panel.html/.css/.js      侧边栏：筛选、网格、选择、下载
├─ options/
│  ├─ options.html/.css/.js    设置页
├─ preview/
│  └─ preview.html/.css/.js    大图预览
├─ lib/
│  ├─ url-utils.js             URL 规范化、文件名推导、模板渲染
│  ├─ image-model.js           ImageItem 结构定义与校验
│  ├─ filters.js               去重与筛选
│  ├─ downloader.js            并发下载与重试
│  ├─ capture.js               截图与拼接
│  ├─ storage.js               设置读写与默认值
│  └─ messaging.js             消息类型常量与发送封装
└─ _locales/
   ├─ zh_CN/messages.json
   └─ en/messages.json

docs/
├─ index.html
├─ privacy.html
├─ changelog.html
├─ 404.html
├─ assets/style.css
├─ assets/main.js              仅做版本号读取等轻交互
├─ .nojekyll
└─ downloads/
   ├─ imagegrab-v<版本>.zip
   ├─ SHA256SUMS.txt
   └─ manifest.json            版本 / 大小 / 校验值 / 发布时间

scripts/
├─ check.mjs                   校验清单（见 §7）
├─ package.mjs                 打包 extension/ → docs/downloads/
└─ serve.mjs                   本地预览 docs/

tests/
├─ README.md                   用例与执行说明
├─ local-server.mjs
├─ fixtures/*.html             场景页面
└─ fixtures/assets/*           测试图片
```

---

## 7. 校验脚本必须覆盖的检查项（FR-900）

`node scripts/check.mjs` 需逐项校验，任一失败以非 0 退出：

1. `extension/manifest.json` 可解析，`manifest_version === 3`，`version` 符合语义化版本。
2. `manifest.json` 中引用的每个 JS / HTML / 图标路径都真实存在。
3. `extension/` 下所有 `.json` 可解析（含 `_locales/*/messages.json`）。
4. `_locales` 中 `zh_CN` 与 `en` 的 key 集合一致，无缺失或多余。
5. 声明的权限都在允许清单内；出现 `tabs`、`debugger`、`webRequest`、`<all_urls>` 必需权限时报错。
6. 源码中不出现 `eval(`、`new Function(`、外部 `http(s)://` 上报地址（允许在注释与文档中说明）。
7. `docs/downloads/` 中最新 ZIP 的文件名版本号与 `manifest.json` 的 `version` 一致。
8. 每个 ZIP 都有对应的 SHA-256 记录，且重新计算结果与记录一致。
9. `docs/index.html` 中出现的下载链接指向存在的文件。
10. 打包内容不含 `.env`、`*.key`、`*.pem`、`node_modules/`、`tests/tmp/`。

---

## 8. 数据模型

### 8.1 ImageItem

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 稳定标识：规范化 URL + kind + frameId 的哈希 |
| `url` | string | 绝对 URL（可能为 data URL） |
| `normalizedUrl` | string | 去参数后的规范 URL，用于去重 |
| `kind` | enum | 来源类型（见 §3） |
| `naturalWidth` / `naturalHeight` | number | 原始像素尺寸，未知为 0 |
| `displayWidth` / `displayHeight` | number | 页面渲染尺寸 |
| `bytes` | number \| null | 文件大小，未探测为 null |
| `mime` | string \| null | 探测到的 MIME |
| `alt` | string | `alt` 文本，用于推导文件名 |
| `visible` | boolean | 是否可见 |
| `inViewport` | boolean | 采集时是否在视口内 |
| `selectorPath` | string | CSS 选择器路径，用于高亮 |
| `frameId` | number | 所属 frame，主文档为 0 |
| `pageUrl` | string | 来源页面地址 |
| `candidates` | array | `srcset` 的其他候选（url + 宽度描述符） |
| `collectedAt` | number | 采集时间戳 |

### 8.2 Settings（默认值）

```jsonc
{
  "downloadSubfolder": "ImageGrab/{domain}/{date}",
  "filenameTemplate": "{index}-{name}-{w}x{h}",
  "concurrency": 4,
  "minWidth": 0,
  "minHeight": 0,
  "formats": ["jpg", "jpeg", "png", "webp", "gif", "svg", "avif", "bmp"],
  "includeCssBackgrounds": true,
  "includeInlineSvg": false,
  "includeCanvas": false,
  "scrollToLazyLoad": true,
  "scrollStepPx": 800,
  "scrollDelayMs": 250,
  "scrollTimeoutMs": 15000,
  "thumbnailSize": 160,
  "theme": "system",
  "keepHistory": false
}
```

### 8.3 消息协议（面板 / 内容脚本 ↔ Service Worker）

| 消息 | 方向 | 载荷 |
| --- | --- | --- |
| `collect:start` | 面板 → SW | `{ tabId, settings }` |
| `collect:progress` | SW → 面板 | `{ jobId, phase, scanned, found }` |
| `collect:done` | SW → 面板 | `{ jobId, items, stats, warnings }` |
| `collect:abort` | 面板 → SW | `{ jobId }` |
| `highlight:show` / `highlight:clear` | 面板 → SW → 内容脚本 | `{ itemId }` |
| `download:start` | 面板 → SW | `{ items, settings }` |
| `download:progress` | SW → 面板 | `{ taskId, total, done, failed }` |
| `download:done` | SW → 面板 | `{ taskId, okIds, failed: [{ id, reason }] }` |
| `capture:visible` / `capture:fullpage` / `capture:element` | 面板 → SW | `{ tabId, options }` |
| `permissions:requestHost` | 面板 → SW | 请求可选主机权限，返回是否授予 |

---

## 9. 界面概要

侧边栏面板（默认宽 360px）：

```
┌──────────────────────────────────────────┐
│ 图提取   example.com       [重新采集 ⟳]   │
├──────────────────────────────────────────┤
│ 已发现 128 张 · 已选 12 张                │
│ [全选] [反选] [清除]  排序:面积 ▾         │
├──────────────────────────────────────────┤
│ 最小宽 [0]  最小高 [0]  格式 [全部 ▾]     │
│ ☑仅可见  ☑含背景图  □自动滚动加载         │
├──────────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐              │
│ │ ✓  │ │    │ │ ✓  │ │    │   ← 缩略图网格 │
│ └────┘ └────┘ └────┘ └────┘              │
│ 1200×800  webp  background               │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐              │
│ └────┘ └────┘ └────┘ └────┘              │
├──────────────────────────────────────────┤
│ 目录 ImageGrab/example.com/2026-10-15/   │
│ 文件名 {index}-{name}-{w}x{h}            │
│        [ 下载选中的 12 张 ]               │
└──────────────────────────────────────────┘
```

下载进度以面板底部条状区域呈现：`成功 9 / 失败 1 / 共 12`，失败项可展开并单独重试。

---

## 10. 验收标准与测试素材

`tests/fixtures/` 提供六个场景页，每个用例的预期结果写进 [tests/README.md](tests/README.md)，实际执行结果记入 [TESTING.md](TESTING.md)。

| 素材页 | 覆盖需求 | 关键预期 |
| --- | --- | --- |
| `fixture-basic.html` | FR-101 / 107 | 普通 img、og:image、favicon、video poster 全部采集 |
| `fixture-lazy.html` | FR-103 / 105 | 未滚动即可拿到全部地址；开启自动滚动后图片可正常下载 |
| `fixture-css-bg.html` | FR-104 | 多重背景与 `image-set()` 全部识别，标注为背景图 |
| `fixture-srcset-picture.html` | FR-102 | 当前生效项正确；候选列表列出全部尺寸 |
| `fixture-iframe.html` | FR-106 | 同源 iframe 被采集并标注 frame；跨源 iframe 记警告 |
| `fixture-edge.html` | FR-110 / 201 / 202 | 坏链接不中断；重复图去重；1x1 占位图被过滤 |
| `fixture-long-page.html` | FR-502 / 503 / 504 | 3 屏高度拼接无重复；固定页头只出现一次 |

首个可用版本的放行条件：上述用例在 [TESTING.md](TESTING.md) 中全部标记为通过，且无 P0 缺陷遗留。

---

## 11. 范围之外（明确不做）

- 视频、音频、HLS 流、PDF 内嵌图片的下载。
- 需要登录或付费才能看到的内容（不绕过任何访问控制）。
- DRM 保护内容、`file://` 本地文件、加密媒体扩展（EME）内容。
- 账号、云同步、远程图片托管、任何形式的数据上传。
- 图片编辑（裁剪、压缩、加水印）。
- Firefox / Safari 版本（架构决策见 §5.4）。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 热链保护导致批量下载大面积 403 | 核心功能不可用 | 提供可选主机权限下的 blob 回退下载（FR-408），并在失败清单中给出明确原因 |
| 懒加载触发被页面自身逻辑打断 | 采集不全 | 滚动驱动带超时与中止；采集结束后报告"滚动 X 次，触发 Y 张" |
| 超长页面整页截图内存溢出 | 浏览器卡死 | 高度与画布上限保护（FR-504）；可选改用 CDP 方案但需权衡权限（§5.3 注） |
| 万级图片导致面板卡顿 | 体验崩塌 | 网格虚拟化（FR-306）+ 采集分片（NFR-100） |
| 侧边栏在部分浏览器窗口形态下不可用 | 入口缺失 | 同时保留 popup 作为降级入口（P2） |
| 打包脚本误把凭据打进 ZIP | 安全事故 | 打包采用显式白名单 + `check.mjs` 第 10 项校验 |
| 官网 ZIP 与源码版本不一致 | 用户装到旧版 | `check.mjs` 校验版本号一致性（第 7 项），作为提交前必过项 |
| Chrome 应用商店审核对"批量下载"类插件敏感 | 无法上架 | 官网自托管为首发渠道；提交前准备权限用途说明与隐私政策页 |

---

## 13. 假设与待确认决策

以下条目当前按**假设**推进，需用户确认后可能影响实现：

1. **首发渠道**：假设先以官网 ZIP + 开发者模式安装为主，不立刻提交 Chrome 应用商店。若需上架，需额外准备商店素材与审核文案。
2. **界面入口**：假设以侧边栏（Side Panel）为主界面。若用户更希望是弹出窗口（popup），布局需重新设计。
3. **默认是否自动滚动**：假设默认开启（否则懒加载图会漏），代价是采集耗时增加。
4. **内联 SVG / canvas 采集**：假设默认关闭，作为高级开关，避免生成大量 data URL 撑爆内存。
5. **语言**：假设界面提供简体中文 + 英文；官网以中文为主，英文页为 P2。
6. **代码形态**：假设零构建、原生 JS（§5.4）。若希望使用 TypeScript，需要引入构建步骤，`extension/` 目录将变为构建产物，与"可直接加载"的诉求有冲突，需重新定义发布目录。
7. **许可证**：尚未选定，建议 MIT。
8. **仓库托管**：假设为 GitHub 公共仓库（GitHub Pages 免费版要求公共仓库）。
9. **ZIP 打包方式**：假设使用 Node 脚本生成；若要求零依赖，需要在 `scripts/package.mjs` 中自行实现 ZIP 写入（可行，但复杂度略升）。
