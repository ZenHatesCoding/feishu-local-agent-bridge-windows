# 协作 Pilot 脚本

[项目 README](../../README.zh.md) | [English](./README.md) |
[Windows 运维](../../docs/WINDOWS_OPERATIONS.zh-CN.md)

这组脚本把任意数量的本地 Agent bridge 接到同一个飞书协作 Hub，并统一管理后台进程、日志、上下文和文件交付。Agent 名称与路径不写死在仓库中，而是来自 Git 忽略的 `.runtime\pilot.local.json`。

首次部署：

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

仓库负责 Hub 和运行编排；使用者负责安装并登录自己的 Agent、准备飞书应用与 profile，并填写实际启动命令。完整说明见 [`docs/WINDOWS_OPERATIONS.zh-CN.md`](../../docs/WINDOWS_OPERATIONS.zh-CN.md)。

Antigravity 使用 `agy.exe` 时，启动器会自动读取 Windows 当前用户代理，并只把它传给 Antigravity 进程；飞书连接仍由 `LARK_CHANNEL_DISABLE_PROXY=1` 保持直连。如果飞书回复 `Authentication required` 而本地客户端已登录，请先确认 Windows 代理正在运行，再单独重启该 Agent。

常用命令：

```powershell
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent <id>
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name <id> -Tail 200
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```
