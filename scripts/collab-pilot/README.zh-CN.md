# 本机协作试验部署

这组脚本用于本机四个既有飞书机器人：World、Justice、Chariot 和 Fool。
它们共享一个仅监听 `127.0.0.1` 的 Hub，并把一个飞书话题视为一个任务。

## 数据边界

- 原有 App 凭据和会话目录继续复用，不复制、不打印密钥。
- World、Justice、Chariot 使用独立代码工作树运行协作适配。
- Fool 使用 Hermes 原 venv 和数据目录，但从隔离源码副本导入 gateway。
- Hermes 原源码、venv、配置、会话、记忆和技能不改动。
- 唯一写入 Hermes Home 的内容是 `hooks\\feishu-collaboration-hub`，停止脚本只删除这一项。
- Hub token、PID、日志和事务账本位于仓库忽略的 `.runtime`。

完整设计说明：[`docs/DESIGN.zh-CN.md`](../../docs/DESIGN.zh-CN.md)

完整 Windows 操作手册：
[`docs/WINDOWS_OPERATIONS.zh-CN.md`](../../docs/WINDOWS_OPERATIONS.zh-CN.md)

## 快速启停

```powershell
.\\scripts\\collab-pilot\\Start-CollabPilot.ps1
.\\scripts\\collab-pilot\\Status-CollabPilot.ps1
.\\scripts\\collab-pilot\\Stop-CollabPilot.ps1
```

单独后台启动一个 Agent，Hub 会自动启动：

```powershell
.\\scripts\\collab-pilot\\Start-CollabAgent.ps1 -Agent world
.\\scripts\\collab-pilot\\Start-CollabAgent.ps1 -Agent justice
.\\scripts\\collab-pilot\\Start-CollabAgent.ps1 -Agent chariot
.\\scripts\\collab-pilot\\Start-CollabAgent.ps1 -Agent fool
```

完全回到原来的四套后台连接：

```powershell
.\\scripts\\collab-pilot\\Stop-CollabPilot.ps1 -RestoreOriginals
```

## Hermes 隔离副本

`adapters\\hermes\\gateway-run.patch` 只应用于 Hermes 源码副本。它让 Hook
能够读取完整输入、取消未经 Hub 授权的机器人唤醒，并记录完整最终回复。
不要把这个补丁应用到原 Hermes 安装。

## 体验方式

在同一个飞书话题中先 `@World` 交付任务，收到结果后再 `@Chariot` 要求接手。
Chariot 会获得该话题的共享结论和产物路径。普通群消息以及不同话题不会混用
任务上下文。
