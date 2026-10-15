# tests/ — 测试素材、用例与自动化验证

本目录是三件事的集合：

1. **可复现的素材页**（`fixtures/`）：一个模拟的商品详情页，把"图片来源"一类一类摆出来，使"采集是否完整"可以被逐条清点，而不是在真实网站上靠感觉判断。
2. **不依赖浏览器的测试**（`*.test.mjs`）：用 DOM 桩跑采集内核与工具函数，跑得快，用来挡住逻辑性错误。
3. **真实浏览器端到端验证**（`browser-e2e.mjs`）：自动拉起一个临时 Chrome、加载扩展、把整个流程跑一遍并断言。
4. **布局实拍工具**（`layout-shots.mjs`）：把长网格在内容区顶部 / 中间 / 底部各截一张图。断言管"几何上不重合"，它管"看着不像重合"，两者互补。

## 为什么需要自建素材页

真实网站会变，而且无法针对单一特性做隔离验证。素材页里每一节只考察一类来源（普通 img、srcset、懒加载、非 PNG 源图、CSS 背景图、坏链接、动态注入），并在页面上写明预期数量与实际行为。素材页调整内容时，必须同步修正本文件的用例表，否则测试失去意义。

## 目录结构

```
tests/
├─ README.md                    本文件
├─ local-server.mjs             本地静态服务器（默认 http://localhost:8787）
├─ browser-e2e.mjs              真实浏览器端到端验证（零依赖，用 CDP 驱动本机 Chrome）
├─ layout-shots.mjs             布局"实拍"工具：灌满图片后在各滚动位置截图，供人工核对是否"看着像重合"
├─ unit.test.mjs                工具函数、模块一致性与内容脚本加载测试
├─ collector.test.mjs           采集内核测试（DOM 桩）
├─ fixtures/
│  ├─ fixture-merchant-detail.html  模拟商品详情页（7 节图片来源 + 动态适配按钮）
│  ├─ fixture.css               素材页样式
│  ├─ fixture.js                素材页交互：2 秒后注入新图、删除浮层、SPA 改地址
│  └─ assets/                   测试图片（全部为真实编码，不是改后缀的假文件）
│     ├─ sample.png   96×96    普通图片
│     ├─ sample.bmp   96×96    BMP 源图（验证真转 PNG）
│     ├─ sample.jpg   96×96    JPEG 源图（验证真转 PNG）
│     ├─ sample.webp  96×96    WebP 源图（验证真转 PNG）
│     ├─ wide.png    240×90    非正方形，验证尺寸展示
│     ├─ tiny.png      8×8     验证最小尺寸筛选
│     └─ lazy.png    120×120   只被 data-src 引用，验证"未加载"提示
└─ tmp/                         临时产物（已被 .gitignore 忽略）
   ├─ e2e-downloads/            端到端脚本下载下来的文件，供人工复核
   └─ layout-probe-<时间戳>/      layout-shots.mjs 的三张截图（顶部 / 中间 / 底部）
```

## 素材图片是怎么来的

| 脚本 | 生成 | 是否需要浏览器 |
| --- | --- | --- |
| `node scripts/make-test-assets.mjs` | `sample.png`、`sample.bmp`、`wide.png`、`tiny.png`、`lazy.png` | 不需要（脚本自带 PNG/BMP 编码器与头部自检） |
| `node scripts/make-image-assets.mjs` | `sample.jpg`、`sample.webp` | 需要本机 Chrome（借用它的 JPEG / WebP 编码器，生成后做头部自检） |

两个脚本都会在写完后读回文件头校验，所以 `assets/` 里不存在"把 SVG 改名成 PNG"这类假素材 —— 这一点是"真转 PNG"测试的前提。

## 启动测试环境

```bash
node tests/local-server.mjs        # → http://localhost:8787/fixture-merchant-detail.html
```

不要用 `file://` 打开素材页：扩展的 `content_scripts` 只匹配 http(s)，且 `fetch` 在 `file://` 下受限，会得到与真实使用不符的结果。

## 三种跑法

```powershell
node --test "tests/*.test.mjs"     # 逻辑测试，秒级，不需要浏览器
node scripts/check.mjs             # 静态校验，不需要浏览器
node tests/browser-e2e.mjs         # 真实浏览器全流程，需要本机 Chrome/Edge
```

验证"解压出来的安装包"（而不只是源码目录）——发布产物才是用户真正加载的东西，
值得用同一套断言再跑一遍：

```powershell
Expand-Archive docs/downloads/imagegrab-v1.0.0.zip -DestinationPath tests/tmp/zip-install -Force
$env:EXTENSION_DIR = "tests/tmp/zip-install"
$env:IG_RUN_LABEL  = "zip"        # 让本次运行的下载产物单独存放，便于分别复核
node tests/browser-e2e.mjs
Remove-Item Env:EXTENSION_DIR, Env:IG_RUN_LABEL
```

`browser-e2e.mjs` 的环境变量：

| 变量 | 作用 |
| --- | --- |
| `HEADFUL=1` | 显示浏览器窗口（默认无头），便于肉眼观察 |
| `CHROME_PATH` | 指定 Chrome/Edge 可执行文件（默认自动查找常见安装路径） |
| `FIXTURE_PORT` | 素材页端口（默认 8787） |
| `EXTENSION_DIR` | 改验证哪个扩展目录（默认源码 `extension/`） |
| `IG_RUN_LABEL` | 给临时 profile 与下载目录加后缀，避免多次运行互相覆盖产物 |

脚本会自动：建临时 profile 与下载目录 → 起素材页服务器 → 启动 Chrome → 加载扩展 → 逐个用例断言 → 打印结果 → 清理临时 profile（下载产物保留在 `tests/tmp/e2e-downloads*/`）。退出码非 0 表示有用例失败。

> 本机 Chrome 155 已不再接受 `--load-extension` 配合调试端口（Chrome 137 起的安全变更），
> 脚本改用 CDP 的 `Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging` 加载扩展。
> 这与手动"加载已解压的扩展程序"等价。

---

## 素材页各节的预期结果

| 节 | 内容 | 预期行为 |
| --- | --- | --- |
| 1 | 同一张 `sample.png` 被两个 `<img>` 引用 | 图库中只出现 **1 条**，来源合并为"图片标签" |
| 2 | `srcset`（1x/2x）与 `<picture>` + `<source>` | 记录当前生效项，候选列表保留其余尺寸 |
| 3 | 懒加载：`data-src` / `data-original` / `data-lazy-src` | `assets/lazy.png` 只被 `data-src` 引用，页面上没有已加载的同地址图片，因此保持 **未加载** 标签，并触发"滚动后重新扫描"提示；另外三条指向已加载地址，合并后不再标未加载（同一地址只要有一处加载成功就算已加载） |
| 4 | `sample.bmp` / `sample.jpg` / `sample.webp` | 下载后都是**真正的 PNG 编码**（文件头 `89 50 4E 47`），不是改后缀 |
| 5 | CSS 背景图：单张、多重、渐变混写、`image-set` | 逐张记录；渐变不产生无效条目；`image-set` 的两个候选都被采集 |
| 6 | `video poster`、1×1 内联 GIF、坏链接、隐藏的 8×8 小图 | poster 被采集；内联 GIF 默认跳过并计数；坏链接显示"无法预览"且下载时报 404、不中断整批；隐藏小图可被最小尺寸筛掉 |
| 7 | 2 秒后动态追加的 `wide.png?dynamic=1` | 首次采集若发生在 2 秒内则不含它；点"重新扫描本页"后一定出现 |
| 控制区 | 删除浮层 / SPA 改地址 / 回到详情页 | 浮层 1.5 秒内补挂、非详情页地址自动隐藏、回到详情页地址自动恢复 |

素材页也会展示同一份人工核对清单，便于一边看页面一边对照结果。

---

## 自动化用例一览

### 逻辑测试（`node --test`）

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `collector.test.mjs` | 11 | 采集内核：`currentSrc` 优先、真实像素尺寸、合并与去重规则、懒加载属性、`srcset` 候选、多重背景、内联 `data:`、协议拒绝、`og:image`/favicon/poster、结果不含 DOM 引用 |
| `unit.test.mjs` | 14 | URL 工具、`srcset` 解析、文件名生成 `商品图_001.png`、消息常量与配色一致性、设置键自洽、详情页识别规则、四脚本加载顺序与重复注入幂等 |

### 浏览器端到端（`browser-e2e.mjs`）

用例 ID 为 `E2E-01` ~ `E2E-18`，覆盖内容脚本注入与动态适配、图库渲染与计数、未加载提示、选择交互、最小尺寸筛选、BMP/JPEG/WebP 真转 PNG、批量下载落盘与命名、失败隔离与失败清单、未授权域名的可读失败原因、Blob URL 释放时机、重新扫描、会话存储抗 Service Worker 回收、底部下载条与网格内容区不重合、顶栏 / 工具条 / 网格互不重合。

E2E-16 需要素材页之外的第二个"域名"：脚本用 `--host-resolver-rules` 把刻意不在 `host_permissions` 里的 `ig-unpermitted.test` 指到本机素材服务器，用来复现"图片来自未授权 CDN"的真实情形。

E2E-17 把视口压到 900×520 后检查底部：整页不许滚动（`document` 的 `scrollHeight` 等于视口高）、下载条与内容区的 `position` 都必须是 `static`、内容区 `overflow-y: auto`；在内容区顶部 / 中间 / 底部三个滚动位置上，内容区与下载条都不重叠、且始终留出 ≥ 8px 的页面底色缝隙（裁掉的卡片不贴住下载条），三段横带（顶栏 / 工具条 / 下载条）内逐点命中测试累计 0 个卡片像素；滚到内容区底部时最后一张卡片完整落在下载条上方。素材页只有不到 10 张卡片，不压视口就触发不了这个场景。

E2E-18 在同一个小视口里检查顶部：滚动的只能是内容区（整页可滚动时，`sticky` 的工具条会钉在视口顶端、压住顶栏）、外壳四段的 `position` 必须全是 `static`、工具条在三个滚动位置上移动的距离必须为 0px（会移动就说明它还是浮动的 `sticky` 元素，滚动时就会压住卡片）、内容区上边缘与工具条下边缘之间留 ≥ 8px 的缝隙、三条横带内逐点命中测试不能命中任何卡片、滚动到顶部时第一张卡片位于工具条下方。它和 E2E-17 是同一条设计约束的两端：四段式外壳（顶栏 / 工具条 / 滚动内容区 / 底部下载条）里，任何一段都不许浮到另一段上面。

断言只能证明"矩形不重合、横带里没有卡片像素"，证明不了"看上去不像重合"（例如滚动到一半时被裁掉的卡片正好贴住下载条，几何上没重合、观感上仍然像）。要看实拍效果用：

```powershell
node tests/layout-shots.mjs                                  # 默认 1010×640
$env:PROBE_W="1520"; $env:PROBE_H="940"; node tests/layout-shots.mjs   # 换成和用户窗口相近的尺寸
```

它会往素材页里灌 120 张图（素材页本身只有不到 10 张，撑不出长网格），再在内容区的顶部 / 中间 / 底部各截一张图，连同各段矩形、内容区上下缝隙一起打到 stdout；截图留在 `tests/tmp/layout-probe-<时间戳>/`。纯人工核对用，不在 `scripts/check.mjs` 的检查范围里。

`EXTENSION_DIR` 指向解压出的安装包时，同一套 18 条断言会再跑一遍，验证发布产物与源码等价。

逐条实际结果与证据见 [TESTING.md](../TESTING.md) 第二节。

---

## 官网（`docs/`）怎么验

官网是纯静态页面，没有可断言的行为，能自动化的只有"结构与是否过期"这两类：

| 层面 | 手段 | 覆盖 |
| --- | --- | --- |
| 本地预览 | `node scripts/serve.mjs docs` → `http://127.0.0.1:8080` | 人工看排版。下载链接与 `fetch('downloads/manifest.json')` 都需要 HTTP 环境，不要用 `file://` |
| 静态校验 | `node scripts/check.mjs` | 官网页面上必须出现当前发布包的版本号、体积、SHA-256，且下载按钮指向当前 ZIP；出现根路径下载链接会报错 |
| 链接与发布信息审计 | 本地 HTTP 服务器逐条请求页面内链，再比对下载按钮、`docs/downloads/manifest.json`、`SHA256SUMS.txt` 与 ZIP 实测值 | 断链、空响应、对不上的锚点、多余的 ZIP、版本或校验值不一致 |

链接审计的机器执行版本是一次性脚本（跑完即删，不进仓库）；**长期保留的是 `check.mjs` 里的那一条**，它拦的是最容易出事的"改了版本号忘了改官网"。
手工要确认的是排版与交互，见下表。

---

## 需要人工执行的用例

这些场景无法（或不适合）自动化，必须在真实浏览器里手工跑一遍并记录到 [TESTING.md](../TESTING.md)。除已改为自动化的 TC-ZIP-01、已明确不适用的 TC-LAZY-02 与 TC-WEB-UI-02 之外，其余状态均为"未执行"。

| 用例 ID | 步骤 | 预期结果 |
| --- | --- | --- |
| TC-ENTRY-01 | 在详情页点工具栏的扩展图标 | 开始采集、角标显示图片数量，随后打开图库 |
| TC-ENTRY-02 | 在页面任意位置右键 → 提取本页图片 | 与点图标行为一致 |
| TC-ENTRY-03 | 采集完成后看工具栏图标角标 | 显示图片数量，切换标签页后切换；页面重新加载后清空 |
| TC-SITE-01/02/03 | 分别在淘宝/天猫、京东、拼多多商家版商品详情页采集 | 浮层出现在右下角；详情长图基本完整；无控制台报错 |
| TC-SITE-04 | 在真实详情页向下滚动加载更多图，再点"重新扫描本页" | 新加载的图片进入图库 |
| TC-FRAME-01 | 打开包含同源 iframe 的页面采集 | 若已支持则采集到；未支持时应给出一致的行为说明 |
| TC-FRAME-02 | 打开包含跨源 iframe 的页面采集 | 主文档采集正常完成，不因 iframe 报错 |
| TC-LAZY-01 | 在含懒加载图的页面上采集，观察右下角浮层 toast | 提示"N 张图片尚未加载，请向下滚动后重新采集" |
| TC-DL-01 | 下载一张受防盗链保护的图片 | 失败清单给出 HTTP 状态；其余图片正常完成 |
| TC-DL-02 | 下载过程中断开网络 | 失败清单给出网络类原因的中文提示，不中断整批 |
| TC-DL-03 | 对极慢的图片执行下载 | 超过 `timeoutMs` 后该条失败，其余不受影响 |
| TC-UI-01 | 图库窗口窄至 360px、切换系统深色模式 | 无横向滚动条，配色与对比度正常 |
| TC-UI-02 | 全程只用键盘操作图库 | Tab 能到达所有按钮与复选框，焦点环可见，已选数量可被读屏软件播报 |
| TC-UI-03 | 对含 3000 张图片的页面打开图库 | 滚动流畅，不卡死 |
| TC-WEB-UI-01 | 官网首页 / 隐私 / 404 三个页面在 360px 窄屏下阅读 | 无横向滚动条、无内容溢出，下载按钮仍可点 |
| TC-WEB-UI-02 | 官网跟随系统深色模式 | **当前未实现**（样式表里没有 `prefers-color-scheme`，见 TESTING.md 的 LIM-10），系统切深色后官网仍为浅色 |
| TC-WEB-UI-03 | 官网全程只用键盘操作：移动端导航展开、FAQ 折叠、灯箱打开与关闭、复制校验值 | Tab 能到达所有可点元素，焦点环可见，Esc 能关闭导航与灯箱，复制后有 toast 反馈 |
| TC-WEB-LIVE-01 | 线上 GitHub Pages 打开首页、点下载、解压后加载 | 站点可访问、`.nojekyll` 生效；子路径部署下 3 个下载按钮仍指向正确的 ZIP，解压后能被"加载已解压的扩展程序"识别。**当前尚未开启 Pages**（PLAN.md M5-9），线上这一层还没有被验证过 |
| TC-ZIP-01 | 解压 `docs/downloads/imagegrab-v1.0.0.zip` 后加载扩展 | **已改为自动化**：用 `EXTENSION_DIR` 指向解压目录跑 `browser-e2e.mjs`，18 条断言全部通过，见 [TESTING.md](../TESTING.md) |

---

## 产物与忽略规则

- `tests/tmp/`（含端到端脚本的临时 profile 与下载目录）已被 `.gitignore` 忽略，不会进仓库。
- 端到端脚本的下载产物会保留在 `tests/tmp/e2e-downloads/`，便于用看图工具或十六进制编辑器人工确认文件头。
- 素材图片（`fixtures/assets/*.png|bmp|jpg|webp`）**要提交**：它们是测试的输入，且体积很小（合计约 37 KB）。
