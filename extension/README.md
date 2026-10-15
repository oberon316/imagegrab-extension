# extension/ — 插件源码

**状态：尚未生成代码。** 本目录的占位说明保证空目录被 Git 跟踪，代码在 [PLAN.md](../PLAN.md) 的 M1 之后逐步加入。

本目录是**发布产物本身**：不经过任何构建步骤，Chrome 直接"加载已解压的扩展程序"指向这里即可运行。因此请遵守两条约束：

1. 不引入打包器、转译器、框架。源码即运行代码。
2. 不提交任何生成产物（压缩、混淆后的文件）。

## 计划中的结构

```
extension/
├─ manifest.json               MV3 清单；权限最小化，见 REQUIREMENTS §5.3
├─ icons/                      16 / 32 / 48 / 128 PNG
├─ background/service-worker.js  消息路由、下载调度、截图编排
├─ offscreen/                  离屏文档，用 Canvas 拼接长图（MV3 的 SW 没有 Canvas）
├─ content/                    注入页面的脚本：采集、滚动、高亮
├─ panel/                      侧边栏主界面（筛选、网格、选择、下载）
├─ options/                    设置页
├─ preview/                    大图预览
├─ lib/                        纯函数工具：URL、筛选、下载器、存储、消息协议
└─ _locales/                   界面文案 zh_CN / en
```

## 两条实现约定

- **模块形式**：Service Worker、面板、设置页使用 ES Module（`"type": "module"`）。内容脚本在 MV3 中不支持静态 `import`，因此用 IIFE 加一个命名空间（`window.__ImageGrab`）划分内部模块。
- **消息协议**：面板与 Service Worker 之间的消息类型集中定义在 `lib/messaging.js`，字段约定见 [REQUIREMENTS.md](../REQUIREMENTS.md) §8.3。所有跨上下文消息带 `jobId` / `taskId`，避免并发任务串台。
