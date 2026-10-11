# 协作 Pilot 脚本

[项目 README](../../README.zh.md) | [English](./README.md) |
[Windows 运维](../../docs/WINDOWS_OPERATIONS.zh-CN.md) |
[Windows Worker 部署](../../docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
[概念入门](../../docs/COLLABORATION_CONCEPTS.zh-CN.md) |
[多电脑联网](../../docs/NETWORKING.zh-CN.md) |
[跨电脑路线图](../../docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)

这组脚本把任意数量的本地 Agent bridge 接到同一个飞书协作 Hub，并统一管理后台
进程、日志、上下文和文件交付。Agent 名称与路径不写死在仓库里，来自 Git 忽略的
`.runtime\pilot.local.json`。

默认 `role: "all"` 时，Hub 和本机 Agent 仍由这一台 Windows 电脑统一管理。
`worker` 角色连中央 Hub，`hub` 是纯中心角色；worker 不会另起一个 Hub。

## 从 Setup 到验证再到回退

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

Setup 把 `config\collaboration-pilot.example.json` 复制成清单，也可以顺带跑
`pnpm install`/`pnpm build`。校验是离线的：只检查路径和必需字段，不连飞书、不
停 bridge、不装 Hermes。清单不是默认的 `.runtime\pilot.local.json` 时，用
`-Config` 指定。

## 监督进程

`Install-CollabPilotStartup.ps1` 给当前 Windows 用户注册一个登录启动任务，Hub 和
Bot 因此不依赖 PowerShell、Codex 或 ChatGPT 窗口。两种形态互不替代：

- **整机模式**（默认）：运行 `Run-CollabPilotSupervisor.ps1`，每 15 秒
  （`-PollSeconds` 5–300）调一次 `Start-CollabPilot.ps1`，把 Hub 和本机全部
  Agent 一起拉回。
- **每 Agent 模式**（`-Agent <id>`）：运行
  `Run-CollabAgentSupervisor.ps1 -Agent <id>`，事件驱动：bridge 健康时它阻塞在
  等待上，只在 Hub 不可达、该 Agent 凭据缺失或启动器退出时才醒来。一台机器跑
  多个 Agent、以及每个 Agent 有独立清单/凭据/账本的 `worker` 节点，都该每
  Agent 一个任务。

```powershell
# 整机一个登录任务
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow

# 每个 Agent 一个事件驱动任务；不给 -TaskName 时任务名是 "Lark Collaboration Agent <id>"
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Agent sun -TaskName SunFeishuBridge -StartNow

# 状态与日志
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent sun
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name sun -Tail 200

# 回退
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

`Start-CollabPilot.ps1` 和 `Start-CollabAgent.ps1 -Agent <id>` 仍可用于临时运行和
开发调试，但它们启动的隐藏子进程不承担跨终端常驻保证。
`Uninstall-CollabPilotStartup.ps1` 默认只删整机任务名，所以每 Agent 任务必须用它
自己的 `-TaskName` 删除。

登录启动路径还会在启动 Hermes 脱离式网关之前装上具名协作 Hook。Hermes 的短命
启动器退出后，网关本身仍然是健康的，所以 Pilot 保留 Hook，把网关单独算作一个
状态，而不是把这个退出当成 Bot 启动失败。

每个 Agent 写自己的本地账本，一个 Agent 一个根目录，一个话题一个文件：

```text
.runtime\local-topic-ledger\<agent>\collaboration\topics\<chatId>\<threadId>.jsonl
.runtime\local-topic-ledger\<agent>\collaboration\topics\<chatId>\_chat.jsonl
```

所以同一台机器上的两个 Agent 等价于两台机器。
[Windows Worker 部署](../../docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) 里的每 Agent
配方给出了 worker 清单、凭据、每 Agent 任务和账本的完整步骤；
[Windows 运维](../../docs/WINDOWS_OPERATIONS.zh-CN.md) 记录了每个清单字段、状态
列和回退命令。

仓库负责 Hub 和运行编排；使用者负责装好并登录自己的 Agent、准备飞书应用与
profile，并填写实际启动命令。

Antigravity 用 `agy.exe` 时，启动器会读取 Windows 当前用户代理，并且只把它传给
Antigravity 进程，飞书连接仍由 `LARK_CHANNEL_DISABLE_PROXY=1` 保持直连。如果飞书
回复 `Authentication required` 而本地客户端已登录，先确认 Windows 代理在运行，
再单独重启该 Agent。
