# TubeLiu fork 的 MiMo 与飞书

简体中文 | [English](mimo-feishu.md)

本 fork 在完整 Qwen Audio Agent 源码上增加功能。悬浮球、对话面板、任务、记忆、
资料库、MCP、后台 Agent 选择和其他语音供应商保留原有实现。MiMo 是新增的原生
语音供应商，飞书是附加工具源，不替换你选择的后台 Agent。

## 桌面设置

打开 **设置 → 语音前台 → MiMo**，分别配置文字、识别和播报：

| 服务 | 默认模型 | 默认地址 |
| --- | --- | --- |
| 文字 | `mimo-v2.6-flash` | `https://token-plan-cn.xiaomimimo.com/v1` |
| 识别 | `mimo-v2.5-asr` | `https://token-plan-cn.xiaomimimo.com/v1` |
| 播报 | `mimo-v2.5-tts` | `https://token-plan-cn.xiaomimimo.com/v1` |

默认音色为 `mimo_default`。三套服务分别保存地址和密钥，保留你填写的地址，不自动
改换服务。保存设置后，嵌入式 Gateway 会使用新配置重启。

MiMo 目前采用本地语音活动检测、ASR、文字模型和流式 TTS 的管线，支持开关麦克风、
插话打断和结果播报。它不提供图像/视频输入，也不宣称模型支持端到端全双工。
原有供应商仍提供各自支持的能力。

打开 **设置 → 飞书 → 连接飞书**。应用会复用本机官方 CLI 已验证的授权；未授权时
会打开飞书授权页，完成后点击 **授权完成**。桌面成品包含对应平台的官方原生 CLI。
凭据保留在 CLI 的本机凭据存储中，不会装进安装包。

## 使用飞书

可以要求读取/搜索文档、查找聊天、发送消息、查询/创建/修改/删除日程、创建多维
表格及任务记录，以及查询/创建/完成待办。读取操作直接执行，信息不足时会询问补充。
飞书任务沿用原任务列表、进度、取消和结果播报。

写入前，对话面板会显示完整预览。阅读内容，勾选阅读确认，再点击本次操作按钮。
每次批准只消费一次，五分钟后过期。口头允许、`always` 或普通 Agent 权限按钮
不能批准新增飞书工具的写入。这一策略适用于本 fork 的飞书工具源；其他后台 Agent
保留自己的工具和权限策略。

飞书规划默认使用 MiMo 文字接口。需要单独的兼容 OpenAI 规划接口时，可在
`config.env` 填写 `FEISHU_BASE_URL`、`FEISHU_API_KEY` 和 `FEISHU_CHAT_MODEL`；
不同主机需要独立密钥。`FEISHU_ENABLED=false` 可关闭飞书工具，
`FEISHU_CLI_PATH` 可指定另行安装的原生 CLI。

## 开发与构建

```sh
npm ci
node scripts/prepare-feishu-cli.mjs
npm run build
npm run desktop
npm run desktop:build:win       # Windows x64 NSIS 安装包
npm run desktop:build:local     # 在 macOS 上构建未签名本地 DMG
```

打包钩子下载官方飞书 CLI `1.0.97`，核验固定 SHA-256 后，将可执行文件放在 ASAR
之外。Mac Universal 成品包含两种 CPU 架构的 CLI。正式签名和公证分发仍使用上游
的 macOS 签名构建命令。

fork 使用独立应用 ID、`qwaudio-tubeliu` 配对协议、更新仓库和默认配置目录：
`~/.config/qwaudio-tubeliu`（或 `$XDG_CONFIG_HOME/qwaudio-tubeliu`）。显式
`QWAUDIO_CONFIG_DIR` 及原运行路径覆盖继续有效，可以和官方桌面应用共存。

从之前的本地飞书助手导入接口配置：

```sh
node scripts/import-feishu-assistant-config.mjs --source /path/to/previous/.env
```

导入工具将已有服务地址与独立密钥写入原生私有设置，保留原文件；已有 MiMo 配置时
会拒绝覆盖。默认 Gateway 端口为 18900，便于和旧服务共存。它不导入对话数据，
也不会将凭据装进安装包。

交付前运行 `npm run lint`、`npm test`、`npm run build`、`npm run release:check`
和 `npm run test:desktop-package`。macOS 成品需要 macOS runner；Windows 验证
不能替代 macOS 设备验证。
