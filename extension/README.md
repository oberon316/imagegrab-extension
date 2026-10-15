# extension/ — 插件源码

本目录是**发布产物本身**：不经过任何构建步骤，Chrome 直接"加载已解压的扩展程序"指向这里即可运行。因此请遵守两条约束：

1. 不引入打包器、转译器、框架。源码即运行代码。
2. 不提交任何生成产物（压缩、混淆后的文件）。

## 文件清单与作用

```
extension/
├─ manifest.json                MV3 清单
├─ icons/                       icon16 / icon32 / icon48 / icon128（真实 PNG）
├─ background/
│  └─ service-worker.js         后台：消息路由、注入、会话存储、开图库、角标、右键菜单
├─ content/
│  ├─ url-tools.js              内容脚本侧工具：URL 补全、规范化、srcset 解析、详情页识别
│  ├─ collector.js              采集内核：遍历 DOM 与计算样式，产出纯数据
│  ├─ ui.js                     页面内浮层（Shadow DOM）：右下角"获取图片"按钮与提示
│  └─ content.js                内容脚本入口：串联以上三者，监听消息、定时自检
├─ gallery/
│  ├─ gallery.html              图库页面结构
│  ├─ gallery.css               图库样式（奶油白 + 深松石绿 + 焦糖棕 + 雾金）
│  └─ gallery.js                图库逻辑：筛选、选择、转换、下载、错误清单
└─ lib/
   ├─ messaging.js              消息类型常量与收发封装（后台/扩展页面）
   ├─ session.js                采集结果的会话存储（chrome.storage.session）
   ├─ settings.js               用户设置读写与默认值
   ├─ url-utils.js              URL 与文件名工具（扩展页面侧）
   ├─ image-processor.js        取图 + 真正的 PNG 转换（只能跑在有 DOM 的扩展页面）
   ├─ downloader.js             下载调度：并发、超时、进度事件、逐项错误
   └─ theme.js                  品牌配色常量（供后台注入角标色等）
```

### manifest.json

MV3 清单。要点：

- `permissions`：`activeTab`、`scripting`、`storage`、`downloads`、`contextMenus`。
- `host_permissions`：只列四大平台及其图片 CDN（`alicdn.com`、`tbcdn.cn`、`360buyimg.com`、`pddpic.com` 等）与本机测试地址。图片的跨域请求就是在这些权限下由扩展页面发起的。
- `background.service_worker`：`background/service-worker.js`，`"type": "module"`。
- `content_scripts`：只匹配四大平台域名与本机测试地址，`run_at: document_idle`，注入顺序为 `url-tools.js` → `collector.js` → `ui.js` → `content.js`（后三个都依赖第一个挂载的命名空间）。
- 没有 `default_popup`：点工具栏图标直接触发采集（`chrome.action.onClicked`），没有中间面板。

### content/ —— 注入页面

四个文件都是**经典脚本**（IIFE + `window.__ImageGrab` 命名空间），因为 MV3 的内容脚本不支持静态 `import`。这样安排带来两份刻意重复的实现（`content/url-tools.js` 与 `lib/url-utils.js`、`lib/messaging.js`、`lib/theme.js`），一致性由 `scripts/check.mjs` 与 `tests/unit.test.mjs` 强制校验。

| 文件 | 作用 |
| --- | --- |
| `url-tools.js` | `toAbsoluteUrl`（含协议相对 `//host/x.png` 与 `url("...")`）、`normalizeUrl`（去 hash、保留查询串）、`parseSrcset`（支持 `1x`/`2x`/`w`，兼容逗号后无空格）、`matchSite`（详情页识别规则） |
| `collector.js` | 采集 `<img>`/`currentSrc`/`srcset`/`picture`、懒加载属性（`data-src`、`data-original`、`data-lazy-src`、`data-ks-lazyload` 等 12 种）、CSS 背景图（多重背景、`image-set()`、与渐变混写）、`<video poster>`、`og:image`、favicon。按规范化 URL 去重并合并来源，标记 `pending`（尚未加载），分片让出主线程 |
| `ui.js` | 右下角浮层。Shadow DOM + `adoptedStyleSheets` 隔离样式（不插 `<style>`，不受页面 CSP 影响）；`sync()` 由 `content.js` 定时调用，决定按钮该显示、隐藏还是补挂 |
| `content.js` | 入口。防重复注入（`NS.__booted`）、读取设置、执行采集、把结果交给后台、把"未加载图片"提示给用户；每 1.5 秒自检一次，适配 SPA 改地址与页面框架删除浮层 |

### gallery/ —— 图库页面

整个扩展里**唯一具备完整 DOM 的执行环境**，因此只有它做两件必须有 DOM 的事：Canvas 转 PNG 与 `chrome.downloads` + Blob URL 下载。

| 文件 | 作用 |
| --- | --- |
| `gallery.html` | 结构：顶栏（来源页、采集时间）、筛选与选择工具条、提示条 + 缩略图网格 + 失败清单（三者在一个独立的滚动容器 `.scroller` 里）、底部下载条。顶栏、工具条、内容区、下载条是外壳的四段，工具条与下载条都在滚动容器**之外** |
| `gallery.css` | 样式：品牌配色、卡片网格、选中态、进度条、失败清单、响应式；仅用系统字体。整页是"固定高度的四段式外壳"（顶栏 / 工具条 / 可滚动内容区 / 底部下载条），四段的 `position` **全是 `static`**——不存在任何 `sticky`/`fixed` 的浮动元素，**只有内容区滚动**且会裁掉自己的溢出内容，所以卡片的像素不可能跑到工具条或下载条上面；内容区上下各留 `--ig-gap: 12px` 的页面底色缝，滚动到一半时被裁掉的卡片只会碰到内容区边缘、不会贴在工具条或下载条上（见 TESTS 里的 E2E-17、E2E-18） |
| `gallery.js` | 读取会话存储里的采集结果并渲染；最小宽高筛选；全选/反选/取消/点缩略图切换；下载编排；进度与逐项状态；失败清单与"重试失败项"；"重新扫描本页"；监听 `chrome.storage.onChanged` 自动刷新 |

### lib/ —— 共享模块（ES Module）

Service Worker 与扩展页面共用。`background/service-worker.js` **只** import `messaging.js`、`session.js` 与 `theme.js`；`image-processor.js` 与 `downloader.js` 只能在图库页面里被 import —— 因为它们用了 `document`、`HTMLCanvasElement`、`createImageBitmap`、`URL.createObjectURL`，MV3 的 Service Worker 里全都没有。这条边界由 `scripts/check.mjs` 顺着 import 链强制校验，不靠自觉。

| 文件 | 作用 |
| --- | --- |
| `messaging.js` | `MSG` 常量与 `sendToBackground` / `sendToTab`（永不抛异常，失败返回 `{ok:false, error}`） |
| `session.js` | 采集结果写入 `chrome.storage.session`（`ig:scan:<tabId>`、`ig:active`、`ig:gallery-tab`），配额不足时裁剪并提示，只保留最近 3 个标签页的结果 |
| `settings.js` | `ig:settings` 的读写与默认值合并（并发数、超时、筛选默认值、是否含内联图） |
| `url-utils.js` | 与内容脚本同名的 URL 工具 + `buildPngFilename`（`商品图_001.png`，超 999 张自动加宽） |
| `image-processor.js` | `fetchImageBlob`（带 host_permissions 的跨域取图、超时、识别 200+HTML 错误页；域名未授权或网络不通时给出"不在扩展的访问权限内"这类可读原因）、`convertToPng`（解码后画进 canvas 再 `toBlob('image/png')`，并校验 PNG magic number）、`processImage`（取图 → 转 PNG 的完整流程） |
| `downloader.js` | 并发信号量、`chrome.downloads.download` + `onChanged` 判定完成、逐项错误翻译成中文、结束或失败都释放 Blob URL |
| `theme.js` | 配色常量，供后台设置角标颜色等使用 |

## 两条实现约定

- **模块形式**：Service Worker 与图库页面使用 ES Module（`"type": "module"`）。内容脚本在 MV3 中不支持静态 `import`，因此用 IIFE 加一个命名空间（`window.__ImageGrab`）划分内部模块。
- **消息协议**：跨上下文的消息类型集中定义在 `lib/messaging.js`，内容脚本侧在 `content/url-tools.js` 有一份等价副本，字段一致性由 `check.mjs` 校验。

## 关于"真正的 PNG"

`lib/image-processor.js` 的 `convertToPng` 会：解码源图 → 画进 `<canvas>` → `canvas.toBlob('image/png')` → 校验结果前 8 字节是不是 `89 50 4E 47 0D 0A 1A 0A`。校验不过就抛错并阻止下载，因此不可能产出"只改了后缀的假 PNG"。源文件本身已是 PNG 且未超尺寸限制时直接沿用原始字节（内容确实是 PNG，同时避免重编码损失）；BMP/JPEG/WebP/GIF/SVG 一律重新编码。
