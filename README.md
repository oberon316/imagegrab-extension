# ImageGrab / 图提取

一个 Manifest V3 的 Chrome 扩展：在淘宝、天猫、京东、拼多多商家版**商品详情页**右下角显示"获取图片"按钮，一键采集页面里的图片，在扩展自己的图库页面里挑选，然后把选中的图片**真正转换为 PNG 编码**后批量下载为 `商品图_001.png` 形式。

> **当前状态：核心功能已实现，并已在真实 Chrome 中跑通端到端验证。**
> 验证方式与逐项结果见 [TESTING.md](TESTING.md)；未在浏览器中验证的部分也在那里逐条列出。
> 需求见 [REQUIREMENTS.md](REQUIREMENTS.md)，实施计划与交付状态见 [PLAN.md](PLAN.md)。

## 它能做什么

| 需求 | 实现方式 |
| --- | --- |
| 详情页右下角出现"获取图片"按钮 | 内容脚本按平台规则识别详情页，用 Shadow DOM 挂一个浮层（`content/ui.js`）。SPA 改地址、页面框架删除浮层都会自适应，且不会重复注入 |
| 采集各种来源的图片 | `<img>`、`currentSrc`、`srcset`、`data-src`、`data-lazy-src` 等 12 种懒加载属性、CSS 背景图（含多重背景与 `image-set()`）、`<video poster>`、`og:image`、favicon。相对地址补全为绝对地址，按规范化 URL 去重并合并来源，支持最小尺寸筛选 |
| 尚未加载的图片给出提示 | 采集时区分"已加载"与"未加载"，在页面浮层和图库提示条上告诉用户向下滚动后再点"重新扫描本页" |
| 图库页面挑选图片 | 点击按钮打开扩展自己的 `gallery.html`：缩略图、原图尺寸、原格式标签、复选框、已选数量统计，支持全选 / 反选 / 取消选择 |
| 转成真正的 PNG | JPG / WebP / BMP / GIF 会被浏览器解码后画进 `<canvas>`，再由 `canvas.toBlob('image/png')` 重新编码，并校验 PNG 文件头。只改后缀的文件在这里不可能通过（`lib/image-processor.js`） |
| 批量下载 | `chrome.downloads` 驱动，区分"下载开始 / 下载完成 / 下载失败"，显示进度与逐项状态，单张失败不中断整批，失败清单可一键重试（`lib/downloader.js`、`gallery/gallery.js`） |
| 界面配色 | 奶油白 `#F7F3E9` + 深松石绿 `#0E5C55` + 焦糖棕 `#A9682F` + 雾金 `#C9A96A`，浮层、图库、失败清单三处一致 |

## 目录结构

```
imagegrab-extension/
├─ extension/              # 插件本体（零构建，源码即运行代码）
│  ├─ manifest.json
│  ├─ icons/               # 16 / 32 / 48 / 128 真实 PNG 图标
│  ├─ content/             # 注入商品详情页：采集、浮层、入口
│  ├─ background/          # Service Worker：消息路由、会话存储、开图库
│  ├─ gallery/             # 扩展自己的图库页面：筛选、选择、转 PNG、下载
│  ├─ lib/                 # 共享模块：消息、会话、设置、URL、图片处理、下载
│  └─ README.md            # 逐文件作用说明（推荐先读这个）
├─ docs/                   # 纯静态官网（GitHub Pages 发布目录）
│  └─ downloads/           # 安装包 ZIP、SHA-256 校验值、发布信息
├─ scripts/                # 校验、打包、本地服务器、素材与浏览器验证脚本
├─ tests/                  # 单元测试、采集内核测试、素材页、浏览器 E2E
├─ README.md               # 本文件
├─ TESTING.md              # 实际执行过的测试记录（含未验证项）
├─ REQUIREMENTS.md         # 需求说明书
├─ PLAN.md                 # 实施计划与当前交付状态
└─ .gitignore
```

## 安装

### 方式一：从源码目录加载（开发用）

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 改动源码后，在扩展卡片上点「重新加载」；内容脚本改动还需要刷新目标网页

### 方式二：从官网 ZIP 加载

1. 下载 [`docs/downloads/imagegrab-v1.0.0.zip`](docs/downloads/imagegrab-v1.0.0.zip)（或从官网页面下载）
2. 解压到任意**固定目录**（该目录被删除后扩展会失效）
3. `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择解压出的目录

浏览器不允许直接双击安装 `.crx`，ZIP 必须解压后加载。校验下载完整性：

```powershell
certutil -hashfile imagegrab-v1.0.0.zip SHA256   # 与 SHA256SUMS.txt 对比
```

### 怎么用

1. 打开淘宝 / 天猫 / 京东 / 拼多多的商品详情页
2. 点右下角浮层的「获取图片」（也可以点工具栏的扩展图标，或右键菜单「提取本页图片」）
3. 图库里用最小宽高筛选，勾选需要的图片（点缩略图即可勾选）
4. 点「下载选中的图片」，等待进度走完

若提示有图片"未加载"，先向下滚动商品页让图加载出来，再点图库右上角的「重新扫描本页」。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `node scripts/check.mjs` | 提交前静态校验：manifest、图标真实性、被引用文件、权限、内容脚本注入顺序、配色与消息常量一致性、Service Worker 未使用 DOM API、ZIP 可解压且校验值匹配、官网页面与当前发布包一致 |
| `node scripts/package.mjs` | 把 `extension/` 打成 `docs/downloads/imagegrab-v<版本>.zip`，更新 `SHA256SUMS.txt` 与 `manifest.json` |
| `node tests/local-server.mjs` | 起本地素材页服务器（默认 `http://localhost:8787`） |
| `node --test "tests/*.test.mjs"` | 单元测试与采集内核逻辑测试（DOM 桩，不启动浏览器） |
| `node tests/browser-e2e.mjs` | **真实浏览器端到端验证**：自动加载扩展、跑完整个流程并断言 |
| `node scripts/make-test-assets.mjs` | 生成 PNG / BMP 测试素材 |
| `node scripts/make-image-assets.mjs` | 用本机 Chrome 的编码器生成 JPEG / WebP 测试素材 |

`browser-e2e.mjs` 的开关：`$env:HEADFUL="1"` 显示浏览器窗口；`$env:CHROME_PATH="..."` 指定其它 Chrome/Edge；`$env:FIXTURE_PORT` 改素材页端口；`$env:EXTENSION_DIR="..."` 改验证哪个扩展目录（配合 `$env:IG_RUN_LABEL` 让产物分开放）。

想把**解压出来的安装包**也跑一遍（发布产物才是用户真正加载的东西）：

```powershell
Expand-Archive docs/downloads/imagegrab-v1.0.0.zip -DestinationPath tests/tmp/zip-install -Force
$env:EXTENSION_DIR = "tests/tmp/zip-install"; $env:IG_RUN_LABEL = "zip"
node tests/browser-e2e.mjs
```

## 测试

| 层级 | 手段 | 覆盖内容 |
| --- | --- | --- |
| 逻辑 | `node --test "tests/*.test.mjs"` | 去重规则、`srcset` 解析、懒加载属性、背景图、最小尺寸、文件名生成、两份重复实现的一致性 |
| 静态 | `node scripts/check.mjs` | 清单与源码的自洽性、权限、CSP、模块边界 |
| 端到端 | `node tests/browser-e2e.mjs` | 注入、动态适配、图库渲染、选择、真 PNG 转换、下载落盘、失败隔离、未授权域名的失败提示、Blob URL 释放时机、会话存储抗 Service Worker 回收 |

端到端脚本会自动拉起一个临时的 Chrome（独立 profile）并加载扩展，跑完输出每条用例的结论，产物留在 `tests/tmp/e2e-downloads/` 供人工复核。
用 `EXTENSION_DIR` 指向解压出的 `docs/downloads/imagegrab-v1.0.0.zip`，同一套断言会再跑一遍，用来确认"下载安装包 → 解压 → 加载"这条路径与源码目录等价。

未在浏览器中验证的部分（例如工具栏图标点击、右键菜单入口、真实店铺页面、跨源 iframe）在 [TESTING.md](TESTING.md) 中单独列出，不标为通过。

## 发布流程

1. 改 `extension/manifest.json` 里的 `version`
2. `node scripts/check.mjs` 与 `node --test "tests/*.test.mjs"` 通过
3. `node tests/browser-e2e.mjs` 通过（验证源码目录）
4. `node scripts/package.mjs` 生成新的 ZIP 与校验值
5. 再跑一遍端到端，但改为验证刚打出的安装包（避免"源码能跑、包里不是这份代码"）：
   ```powershell
   Expand-Archive docs/downloads/imagegrab-v1.0.0.zip -DestinationPath tests/tmp/zip-install -Force
   $env:EXTENSION_DIR = "tests/tmp/zip-install"; $env:IG_RUN_LABEL = "zip"; node tests/browser-e2e.mjs
   ```
6. 更新 `docs/index.html` 上手工写死的发布信息：版本号与体积（各 2 处 `data-release` 标记）、SHA-256（1 处），以及 3 个下载按钮的 `href` 与 `download` 文件名。`docs/downloads/manifest.json` 与 `SHA256SUMS.txt` 由上一步自动写好，`privacy.html` 和 `404.html` 不含发布信息，无需改动
7. 再跑一次 `node scripts/check.mjs`：它会拿官网上的版本号 / 体积 / SHA-256 / 下载按钮和当前发布包逐项比对，第 6 步漏改任何一处都会以非 0 退出码报出来
8. 提交并推送，GitHub Pages 自动发布 `docs/`

## 隐私

扩展只在用户主动点击时读取当前标签页的 DOM 与图片地址，不采集页面文本，不向任何服务器发送数据。采集结果存放在 `chrome.storage.session`（浏览器会话内有效，重启浏览器即清空），设置存放在 `chrome.storage.local`。官网为纯静态页面，无统计脚本、无第三方字体或 CDN 请求。

## 许可证

待确定（计划在首个可用版本前选定，例如 MIT）。
