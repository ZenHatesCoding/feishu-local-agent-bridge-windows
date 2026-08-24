# Windows PowerShell 启停手册

本文说明如何在 Windows 上后台运行 Collaboration Hub，以及 World、Justice、
Chariot、Fool 四个飞书桥接。架构原理见
[DESIGN.zh-CN.md](./DESIGN.zh-CN.md)。

以下命令针对当前本机试验工作树：

```text
C:\feishu-multi-agent-hub
```

所有封装脚本都使用隐藏 PowerShell 子进程后台运行，不需要保持终端窗口打开。

## 组件对应关系

| 启动名 | 飞书机器人 | 本地 Agent | 现有凭据目录 |
| --- | --- | --- | --- |
| `world` | World | Codex | `%USERPROFILE%\.lark-channel` |
| `justice` | Justice | Antigravity | `C:\antigravity-bridge\.lark-channel` |
| `chariot` | Chariot | DeepSeek Harness | `C:\deepseek-bridge\.lark-channel` |
| `fool` | Fool | Hermes | `%LOCALAPPDATA%\hermes` |

Hub 只监听 `127.0.0.1:17321`。token、PID、日志和任务账本位于
`C:\feishu-multi-agent-hub\.runtime`，该目录不会提交 Git。

## 第一次使用前检查

打开 PowerShell：

```powershell
Set-Location C:\feishu-multi-agent-hub
node --version
pnpm --version
pnpm install
pnpm build
```

本机 pilot 还依赖已经准备好的隔离运行时：

```text
C:\collab-runtime\codex
C:\collab-runtime\deepseek
C:\collab-runtime\hermes
```

其中 Hermes 隔离副本使用原 Hermes venv 和数据目录，只从副本导入 gateway。
不要对原 Hermes 执行重装、更新或应用 `adapters\hermes\gateway-run.patch`。

PowerShell 执行策略若阻止脚本，只对当前窗口临时放行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

不要修改机器级执行策略。

## 一行启动全部

```powershell
Set-Location C:\feishu-multi-agent-hub
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

这条命令会：

1. 初始化本地 Hub token、配置、日志目录和账本。
2. 后台启动 Hub。
3. 分别停止四个机器人原来的独立监听器，避免同一 App 重复连接。
4. 后台启动 World、Justice、Chariot 和 Fool 的协作 bridge。
5. 输出整组状态。

重复执行是安全的。已经由 pilot 运行的组件会显示 `already running`，不会再开一份。

## 一个一个启动

单独启动时会自动确保 Hub 已启动，并只切换指定机器人的监听器。

```powershell
Set-Location C:\feishu-multi-agent-hub

.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent world
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent justice
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent chariot
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent fool
```

也可以用一行 PowerShell 循环依次启动四个：

```powershell
'world','justice','chariot','fool' | ForEach-Object { .\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent $_ -SkipStatus }
```

只启动 Hub，不启动任何 Agent：

```powershell
.\scripts\collab-pilot\Start-CollabHub.ps1
```

## 查看状态

查看 Hub 和四个 Agent：

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1
```

只看一个组件：

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent world
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent fool
```

状态中的含义：

- `Hub health: True`：Hub HTTP 健康检查通过；
- `Running: True`：后台 PowerShell 启动器仍在；
- `Worker: node.exe` 或 `python.exe`：真正的 bridge 子进程存在；
- `LastError`：错误日志最后三行，可能包含已经恢复的历史告警，应结合最新日志判断。

## 查看日志

每个组件同时有 stdout 和 stderr 日志：

```powershell
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name hub
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name world -Tail 200
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name justice -Tail 200
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name chariot -Tail 200
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name fool -Tail 200
```

持续跟踪标准输出，按 `Ctrl+C` 退出跟踪，不会停止后台 bridge：

```powershell
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name world -Tail 50 -Follow
```

日志文件也可直接读取：

```powershell
Get-Content .\.runtime\logs\world.out.log -Tail 100
Get-Content .\.runtime\logs\world.err.log -Tail 100
```

## 单独停止或切回原桥接

只停止一个协作 bridge：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent world
```

停止该协作 bridge，并立刻恢复它原来的独立 bridge：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent world -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent justice -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent chariot -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent fool -RestoreOriginal
```

`fool` 停止时只删除本项目安装的
`%LOCALAPPDATA%\hermes\hooks\feishu-collaboration-hub`，不会删除其他 Hook，也不会
修改 Hermes 源码、venv、配置、会话或记忆。

## 一行停止全部

停止整个协作 pilot，但不启动旧监听器：

```powershell
.\scripts\collab-pilot\Stop-CollabPilot.ps1
```

停止 pilot 并恢复原来的四套独立桥接：

```powershell
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

这是完整回退命令。Hub 账本不被原桥接依赖，保留 `.runtime` 不会影响原来的使用。

## 底层手动启动方式

通常应使用上面的封装，因为它会处理 PID、日志、Hub、原监听器冲突和 Hermes Hook。
理解底层行为时，可以看两个前台入口：

```powershell
# 前台运行 Hub，当前窗口不能关闭
.\scripts\collab-pilot\run-hub.ps1

# 前台运行一个 Agent bridge，当前窗口不能关闭
.\scripts\collab-pilot\run-agent.ps1 -Agent world
```

封装的后台启动本质上等价于：

```powershell
Start-Process -WindowStyle Hidden -FilePath powershell.exe `
  -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',`
    'C:\feishu-multi-agent-hub\scripts\collab-pilot\run-agent.ps1','-Agent','world' `
  -RedirectStandardOutput 'C:\feishu-multi-agent-hub\.runtime\logs\world.out.log' `
  -RedirectStandardError 'C:\feishu-multi-agent-hub\.runtime\logs\world.err.log'
```

不要直接执行这段底层命令去启动第二份相同机器人。相同飞书 App 的两个监听器会争抢
事件，而且裸 `Start-Process` 不会登记到 pilot PID 文件。

## 重启一个组件

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent chariot
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent chariot
```

重启整组：

```powershell
.\scripts\collab-pilot\Stop-CollabPilot.ps1
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

## 飞书端验收

必须在话题群中新建一个话题：

1. `@World` 要求先分析并给出结论、产物和下一步。
2. 等 World 回复后，在同一话题 `@Chariot` 要求接手并先复述前序结论。
3. 可继续 `@Justice` 做审查，或 `@Fool` 接手需要 Hermes 能力的部分。

第二个 Agent 能准确复用第一个 Agent 的结论和产物，且不同话题不串线，才算核心
链路通过。

## 常见故障

### Hub health 为 False

```powershell
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name hub -Tail 200
Get-NetTCPConnection -LocalPort 17321 -ErrorAction SilentlyContinue
```

若端口被一个不在 `.runtime\pids.json` 中的 Hub 占用，启动脚本会拒绝覆盖它。

### Running 为 True，但飞书没有回复

先确认 `Worker` 存在，再看对应日志是否出现“已连接”或 Hermes WebSocket connected：

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent world
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name world -Tail 200
```

### 机器人在普通群里能用，但没有共享上下文

当前协作边界是飞书话题。确认两次 `@` 位于同一个话题，消息具有同一个
`threadId`。私聊和普通群消息故意保留原桥接行为。

### 需要立即回退

```powershell
Set-Location C:\feishu-multi-agent-hub
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```
