# Windows 部署与运维

[返回中文 README](../README.zh.md) | [English](./WINDOWS_OPERATIONS.md) |
[Agent 桥接](./AGENT_BRIDGES.zh-CN.md) | [协作设计](./DESIGN.zh-CN.md) |
[概念入门](./COLLABORATION_CONCEPTS.zh-CN.md) | [多电脑联网](./NETWORKING.zh-CN.md) |
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)

## 责任边界

中心 Hub 电脑（也包括单机 `role: "all"`）克隆 `release/hub`。第二台只运行
Worker、绝不启动 Hub 的电脑克隆 `release/worker`，并使用
[Windows Worker 部署指南](./WINDOWS_WORKER_DEPLOYMENT.zh-CN.md)。

本项目可以部署和管理：

- 本机 Collaboration Hub、任务账本、上下文权限和文件产物库；
- 已集成的 Node bridge，以及供 Hermes 使用的可撤销 Hook；
- 任意数量、任意名字 Agent 的后台启动、PID、日志、健康检查和原桥回退；
- Agent 运行时需要的协作环境变量和 `collab-artifact.cmd` 文件交付命令。

使用者需要自行准备：

- Windows、Node.js 20.12+、pnpm 和 Git；
- 已安装并完成登录的本地 Agent；
- 每个机器人各自的飞书 PersonalAgent 应用、权限、事件订阅和 bridge profile；
- 每个 Agent 的实际启动命令、工作区、profile 目录和必要环境变量；
- 不在本项目适配范围内的 Agent bridge。它必须接入 Hub 协议，不能仅仅启动原生 CLI。

项目不会安装、重装或升级用户的 Agent，也不会把飞书 App Secret 写入部署清单。飞书凭据继续留在各 bridge 的 profile 目录中。

Pilot 既支持一台 Windows 电脑运行 Hub 和全部 Bot，也支持多台电脑连接同一个 Hub。
推荐从 `role: "all"` 开始：主电脑既是中心，也是现有 Bot 的执行节点；以后再增加
`worker`，不需要拆走主电脑上的 Bot。安全边界和后续计划见
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。

## 从 GitHub 部署

在 PowerShell 中执行下面的命令。下文用 `<repo>` 表示检出目录，示例使用
`C:\feishu-local-agent-bridge`，它同时也是默认的 `.runtime` 状态目录所在位置。

```powershell
git clone --branch release/hub --single-branch https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git C:\feishu-local-agent-bridge
Set-Location C:\feishu-local-agent-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\collab-pilot\Setup-CollabPilot.ps1
```

Setup 会执行 `pnpm install` 和 `pnpm build`，并从 `config\collaboration-pilot.example.json` 生成不受 Git 跟踪的 `.runtime\pilot.local.json`。已有本地配置默认不会被覆盖；只有明确传 `-Force` 才会重建。

编辑本地清单后进行只读预检：

```powershell
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
```

预检不连接飞书，不停止现有 bridge，也不安装 Hermes。

## 清单结构

清单是一个 `schemaVersion: 2` 的 JSON 文件，默认路径为
`.runtime\pilot.local.json`。面向操作者的脚本（`Setup-CollabPilot`、
`Test-CollabPilotConfig`、`Start-CollabPilot`、`Start-CollabAgent`、
`Stop-CollabPilot`、`Stop-CollabAgent`、`Status-CollabPilot`、
`Get-CollabPilotLog`、`Install-CollabPilotStartup`、
`Uninstall-CollabPilotStartup`、`Export-CollabWorkerConfig`）都支持 `-Config`
指向其他副本；`run-agent.ps1` 和 `run-hub.ps1` 不带参数，它们从启动方继承
`LARK_COLLAB_PILOT_CONFIG`。

结构上只有两样是必需的：`schemaVersion`，以及至少有一个 `enabled` 条目的
`agents[]`。其余字段都有默认值，因此旧清单无需修改即可继续使用。

顶层字段：

| 字段 | 省略时的默认值 | 含义 |
| --- | --- | --- |
| `role` | `"all"` | `all`、`hub` 或 `worker`；其他取值会被直接拒绝 |
| `nodeId` | 机器名 | 本节点在 Hub 中的标识 |
| `hub` | — | 监听地址、对外 URL、端口、协作域和各项上限 |
| `larkCliJs` | 留空后自动解析 | 真实 `@larksuite/cli` 的 JavaScript 入口 |
| `commonEnvironment` | — | 所有本机 Agent 共用的环境变量 |
| `unsetEnvironment` | — | 应用清单环境之前先清除的变量 |
| `agents` | 必需 | 每个机器人一项，可启用也可禁用 |

每个 `agents[]` 元素定义一个机器人身份和一个实际进程。会改变行为的字段：

```json
{
  "id": "planner",
  "displayName": "Planner",
  "aliases": ["codex"],
  "enabled": true,
  "launch": {
    "filePath": "node.exe",
    "arguments": ["C:\\bridge\\dist\\cli.js", "run", "--profile", "planner"],
    "workingDirectory": "C:\\workspaces\\planner",
    "environment": {
      "LARK_CHANNEL_HOME": "C:\\profiles\\planner",
      "LARK_CHANNEL_CODEX_BIN": "C:\\tools\\codex.cmd"
    }
  }
}
```

- `id` 是 Hub 内稳定身份，也是命令行 `-Agent` 的值；不要随意改动。
- `displayName` 和 `aliases` 用于解析 Agent 之间的委派目标。
- `launch` 必须启动已经接入本项目 Hub 协议的 bridge。
- `enabled` 省略即启用；`enabled: false` 只保留清单里的定义，既不登记到 Hub 也不启动。
- `runOnThisNode: false` 表示 Agent 会登记到中央 Hub，但不在这台机器启动，适合预先
  登记另一台电脑上的 Bot；省略时保持原有行为，在本机启动。
- `credentialEnv` 指向存放该 Agent Hub 凭据的环境变量，`credential` 是明文兜底。
  Hub 或 `all` 节点两者都未配置时，凭据取自 `.runtime\agent-tokens.json`。
- `original.stop/start` 可选。配置后，切换到协作 bridge 前会停止旧监听器；回退时可恢复旧监听器，避免同一个飞书 App 同时被两份进程消费。
- 停止命令在“原 bridge 本来就没运行”时可能返回非零，可对 `original.stop` 设置 `"ignoreExitCode": true`；恢复命令不建议忽略失败。
- `hermesHook` 仅用于 Hermes。启用后只复制本项目 Hook 到指定 Hermes Home，停止时只删除该 Hook，不修改源码、venv、配置、记忆或技能。
- `hub.maxCausalDepth` 限制单条 Agent 委派因果链的深度，不限制一个话题的累计工作轮数。旧 `maxHops` 仅用于读取旧清单；新配置应使用 `maxCausalDepth`。`hub.leaseMinutes` 默认 `30`，`hub.maxConversationTurns` 默认 `32`。
- `hub.bindHost` 优先于旧的 `hub.host`；监听端口默认 `17321`。

路径在使用前会先做展开：先替换 `${REPO_ROOT}`、`${STATE_DIR}`、`${USERPROFILE}`、
`${LOCALAPPDATA}`，再用 Windows 的 `%VAR%` 规则展开 `%USERPROFILE%`、`%PATH%` 这类
变量。JSON 中 Windows 反斜杠需要写成 `\\`。

`larkCliJs` 指向真实飞书 CLI 的 JavaScript 入口，Agent 靠它发送共享文件。若所用 bridge 自己实现了文件发送，可以留空；否则应填写本机实际路径。

## 单机兼容与多机角色

旧清单不写 `role` 时等同于 `all`。三种角色为：

| role | 本机运行 Hub | 本机运行 Bot | 用途 |
| --- | --- | --- | --- |
| `all` | 是 | 是 | 默认；一台电脑完整运行，或主电脑兼任中心和执行节点 |
| `hub` | 是 | 否 | 只做中央服务 |
| `worker` | 否 | 是 | 额外电脑连接已有中央 Hub |

主电脑可使用以下网络配置。`bindHost` 决定 Hub 监听哪些网卡，`publicUrl` 是本机 Bot
连接 Hub 的地址；额外 worker 在自己的清单中填写它能访问的同一地址：

```json
{
  "role": "all",
  "nodeId": "main-pc",
  "hub": {
    "bindHost": "100.x.y.z",
    "publicUrl": "http://100.x.y.z:17321",
    "port": 17321,
    "tenantKey": "one-private-shared-domain"
  }
}
```

`100.x.y.z` 用 Tailscale、WireGuard 或企业 VPN 私网地址。每个 Agent 使用
独立的 256 位随机凭据；主节点保存在 `.runtime\agent-tokens.json`，Hub 从凭据推导
调用者身份，Agent 不能靠修改请求体冒充另一个 Agent。
联网原理、安全边界和排查顺序见[多电脑联网](./NETWORKING.zh-CN.md)。

为已经登记在主节点清单中的 Agent 生成 worker 清单：

```powershell
.\scripts\collab-pilot\Export-CollabWorkerConfig.ps1 `
  -Agent reviewer `
  -HubUrl http://100.x.y.z:17321 `
  -OutputPath .\.runtime\worker-reviewer.local.json
```

导出文件含该 Agent 的一把凭据，会强制把 `enabled` 和 `runOnThisNode` 置为 true，
并把 `nodeId` 换成占位值，因此目标电脑必须填写自己的节点名。导出文件只能私下传到
目标电脑，不能提交 Git。目标电脑调整 `nodeId`、启动路径、profile 和工作区后运行
预检，再用 `-Config` 启动。手工配置时可用 `config\collaboration-worker.example.json`，
并通过 `credentialEnv` 注入凭据。导出只能在承担 Hub 角色的节点上执行。

## 适配不同 Agent

Codex、Claude、Antigravity 或 DeepSeek Harness 应使用本仓库相应适配器构建出的 bridge，再把构建产物和 Agent 可执行文件写入 `launch`。Agent 本身的模型、推理强度、速度和登录状态仍由各 Agent 自己管理。

新的第三方 Agent 需要一个适配器完成四件事：

1. 接收飞书消息时向 Hub 请求 `collaboration_context`；
2. 只在 Hub 授权且消息真实 `@` 到自己时运行；
3. 把最终摘要、委派和完成状态回写 Hub；
4. 通过产物协议登记和发送文件。

只有启动命令、但没有这四项协议实现的 Agent，不能获得正确的共享与隔离语义。参照 `src/collab`、`src/agent` 和 `adapters/hermes` 编写适配器后，部署脚本无需再改，只需在本地清单增加一个 Agent。

## 协作群白名单

每个 Agent 的 bridge profile 都独立维护飞书群白名单；Hub 的任务授权不会绕过这层
消息入口访问控制。因此，所有会在同一协作群中被人或其他 Agent `@` 的 agent bridge
（例如 Codex、Antigravity、DeepSeek Harness）都必须分别允许该群。

首次配置时，由**每个 bot 的 owner 或管理员**在目标群中逐一真实 `@` 对应 bot
并发送 `/invite group`，World、Justice、Chariot 和其他 agent bridge 都要各做
一次。群内通常启用了“必须 @bot”策略，单独发送裸的 `/invite group` 会被静默忽略。

如果 bot 回复“当前群尚未加入响应列表”，说明当前 bot 自己的 profile 尚未加入该群，
不是 Hub、dispatch 或 Agent 登录失效。也可在该 profile 根目录 `config.json`（即
`<lark-channel-home>\config.json`）的 `profiles.<profile>.access.allowedChats` 数组里
加入当前 `chat_id`，然后仅重启对应 Agent：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent justice
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent justice
```

不要把一个 bot 的 `allowedChats` 复制后就假定其他 bot 也已生效：每个 profile 都需要
单独写入和验证。Hermes 使用自己的原生飞书访问策略，不适用 `allowedChats` 字段；保持
其现有配置，并按 Hermes 的接入方式单独验证群内 @ 响应。

Pilot 还会把 `scripts\collab-pilot\bin` 放在每个 Agent 的 `PATH` 最前面。目录内的
`lark-cli.cmd` / `lark-cli.ps1` 是不绑定身份的统一入口：它们只调用清单中配置的真实
`larkCliJs`，并保留当前 Agent 的 `LARK_CHANNEL_*` 和 `LARKSUITE_CLI_CONFIG_DIR`。因此即使
某个外部 bridge 目录残留了写死其他 bot profile 的同名脚本，也不能劫持当前 bot 的发送
身份。不要在这些统一入口中写死 profile 路径、App ID、`HOME` 或 `USERPROFILE`。统一
命令目录会在清单环境覆盖全部完成后才最终放到 `PATH` 最前，因此清单里的 `PATH` 也不能
让旧 shim 抢到前面。应用所选 Agent 环境前，Pilot 会先清除其他 Agent 遗留的路由变量。

## Agent 自主委派

协作任务中，Agent 不能只在回复里写一个文本 `@`。要让当前负责人请求专家协助或正式
交接，使用 pilot 注入的命令：

```powershell
collab-delegate.cmd ask --target justice --content "审查这份视觉方案的风险"
collab-delegate.cmd handoff --target chariot --content "接手并完成证据整理"
```

该命令从当前运行环境取得任务和话题回复目标，先向 Hub 写入幂等 `ask` 或 `handoff`，再
以当前 bot 身份发送带真实飞书 mention 的话题回复。目标 bridge 只会消费对应 dispatch。
各 bridge 连接后会自动把自己的飞书 `open_id` 注册到 Hub，因此 Agent 应只使用稳定的
Hub Agent ID（如 `world`、`justice`、`chariot`），不应自行查询群成员、猜测 open_id，或用
裸 `lark-cli` 发送委派。

## 网络环境边界

`commonEnvironment` 和 `unsetEnvironment` 用于建立默认直连环境；某个 Agent 的
`launch.environment` 只覆盖自己的子进程。不要为了一个模型 CLI 修改 Hub 或所有
机器人的全局代理。Antigravity 使用 `agy.exe` 时，如果环境里没有显式代理，pilot 会
读取 Windows 当前用户代理并只传给该 Agent；`LARK_CHANNEL_DISABLE_PROXY=1` 仍让
飞书连接直连，`NO_PROXY` 则保证本机 Hub 地址不经过代理。环境里已经存在的显式代理
优先级更高，pilot 不会覆盖。

认证文件属于 Agent 自己，网络配置不应安装、重置或迁移认证数据。排查时分别检查
Hub health、bridge 是否连接、Agent CLI 是否可执行、代理端口和模型端点，不能把模型
端点的 EOF 或超时直接归类成登录失效。

## 后台启停

正式常驻使用 Windows 登录启动任务。它属于当前用户，不要求把 GitHub、Agent 或飞书
认证改成机器级凭据；登录后会运行长期监督进程，独立于启动它的 PowerShell、Codex 或
ChatGPT 窗口。不加 `-Agent` 时，由一个轮询监督进程维持整个 pilot：

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

该任务运行 `Run-CollabPilotSupervisor.ps1`，每 15 秒（`-PollSeconds`，取值 5–300）
调用一次 `Start-CollabPilot.ps1`，把退出的组件重新拉起，因此 Hub 和所有本机 Bot 一起
恢复。它按“仓库根 + 清单路径”持有命名互斥量，第二份进程会直接退出，不会互相抢占。
两种形式都可以加 `-Config`，让任务使用 `.runtime\pilot.local.json` 以外的清单。

加上 `-Agent <id>` 后，同一条命令为每个 Agent 注册一个事件驱动任务：

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Agent sun -StartNow
```

该任务运行 `Run-CollabAgentSupervisor.ps1 -Agent sun`，任务名默认为
`Lark Collaboration Agent sun`，`-StartNow` 在启动任务前只停止这一个 Agent。

| | 整体监督进程 | 单 Agent 监督进程 |
| --- | --- | --- |
| 作用范围 | Hub 和全部本机 Agent | 恰好一个 Agent |
| 唤醒方式 | 每 15 秒轮询（`-PollSeconds`） | 只在有活可干时醒来 |
| 等待方式 | 固定轮询间隔 | bridge 存活期间阻塞在 `Wait-Process` |
| 每次启动前 | 只清理 `Start-CollabAgent` 自己清理的内容 | 还会清理该 Agent 两侧的登记 |
| 单实例 | 命名互斥量 | 任务的 `-MultipleInstances IgnoreNew` |
| 日志文件 | `.runtime\logs\supervisor.log` | `.runtime\logs\<agent>-supervisor.log` |

单 Agent 监督进程不会轮询 bridge，只在四种情况下睡眠：Hub 不可达（先 10 秒，再
20、40、60 秒翻倍，探测成功后回到 10 秒）、Agent 凭据缺失（`-CredentialRetrySeconds`，
默认 60 秒）、启动器已经退出（`-RestartSeconds`，默认 5 秒），以及该 Agent 是脱离了
启动器的 Hermes 网关。脱离的网关在 `pids.json` 里没有启动器 PID，只能按定时器查它的
存活：`-GatewayCheckSeconds`（10 到 600，默认 60）。其他引擎完全事件驱动。每次启动前，
它会先从 `pids.json` 清理该 Agent 的受管启动器，再通过该 Agent 的 `LARK_CHANNEL_HOME`
清理 bridge 自己的登记，因此被强杀的 bridge 不会留下阻止下次启动的陈旧登记。

单机 `all` 节点上 Hub 和 Agent 共享同一生命周期，用整体任务即可。一台机器运行多个
Agent，或使用 `worker` 角色时，应为每个 Bot 注册一个单 Agent 任务：每个 Agent 有自己
的清单、凭据和账本，不能因为兄弟 Agent 失败而被重启。同一台机器可以运行一个整体
任务，也可以运行任意多个单 Agent 任务，但同一个 Agent 不要两种都装。

任务采用当前用户交互登录令牌，因此仍能读取该用户自己的 Agent 登录态、profile 和代理
设置。它不保存额外密码，也不包含 token、App Secret 或清单内容，只保存监督脚本与
Git 忽略配置文件的绝对路径。卸载常驻任务并停止 Pilot：

```powershell
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

卸载默认只处理整体任务名。单 Agent 任务需要用它自己的名字卸载，例如
`Uninstall-CollabPilotStartup.ps1 -TaskName 'Lark Collaboration Agent sun'`。注册时也
可以传 `-TaskName`，把每个 Agent 的任务命名成便于识别的名字。

下面的 `Start-CollabPilot.ps1` 是临时运行和调试入口；它使用隐藏子进程，但不承诺在
启动它的终端宿主被回收后继续存活。

一行启动全部启用的 Agent：

```powershell
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

一个一个启动，Hub 会自动启动：

```powershell
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent planner
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent reviewer
```

查看全部或单个状态和日志：

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent planner
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name planner -Tail 200
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name planner -Follow
```

状态输出先打印 `Hub health: True` 或 `Hub health: False`，再为每个组件输出一条含
`Name`、`PID`、`Running`、`Worker`、`LastError` 的记录。受管启动器仍存活，或 Hermes
gateway 在自己的启动器退出后仍然健康时，`Running` 为 true（此时 `Worker` 显示
`hermes-gateway (detached)`）；其余情况下 `Worker` 列出子进程名。`LastError` 是该组件
`.err.log` 的最后几行。日志命令接受 `hub` 或任一已启用的 Agent id，读取
`.runtime\logs\<name>.out.log` 和 `<name>.err.log`。机器使用非默认清单时，给上述命令
加上 `-Config`。

也可让多个克隆或多套环境使用独立清单：

```powershell
.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config C:\private\team-a.json
```

## 停止与回退

停止协作 bridge，或停止后恢复该 Agent 的原 bridge：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

回退只使用清单中明确配置的命令，不会删除账本或共享产物。没有配置 `original.start`
的 Agent 会保持停止，需由使用者按自己的原方式启动。Hermes 停止时只删除配置的 hooks
目录下的 `feishu-collaboration-hub`。

正常停止 Agent 时，Pilot 会先通过该 Agent 隔离的 `LARK_CHANNEL_HOME` 请求已登记的
协作 bridge 退出，再以终止受管启动器作为兜底。如果 Windows 已从外部终止 bridge，
运行时只会清理元数据仍指向该死亡 PID 的 profile/app 锁。因此停止后可以立即重启，
无需等待锁超时，也不需要手工删除锁文件。

## 数据和安全

默认运行数据都在 `.runtime`，不会提交 Git：

```text
.runtime\pilot.local.json       本机路径与启动配置
.runtime\hub-token.txt          Hub 中央管理凭据
.runtime\agent-tokens.json      每 Agent 独立 Hub 凭据
.runtime\tenant-key.txt         本机协作域
.runtime\hub-config.json        从本地清单生成的 Hub 配置
.runtime\collaboration.jsonl    任务账本
.runtime\artifacts\             SHA-256 文件快照
.runtime\local-topic-ledger\    每 Agent 的本地话题账本
.runtime\logs\                 stdout/stderr
.runtime\pids.json              后台启动器 PID
```

Hub 侧文件只出现在承担 Hub 角色的节点；`worker` 节点只保留自己的清单、日志和 PID。
本地话题账本按 Agent、按话题分开，每个 Agent 一个根目录：

```text
.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

新话题会写入新文件，不属于任何话题的群消息写入 `_chat.jsonl`，同一台机器上的两个
Agent 永远不会写同一个文件。这份账本只记录该 bridge 自己观察到的事件，不会复制到
Hub，因此其中的路径只在当前节点有意义。

监督进程的修复记录写入 `.runtime\logs\supervisor.log`；每个单 Agent 监督进程追加写入
`.runtime\logs\<agent>-supervisor.log`。Windows 任务本身不包含 token、App Secret 或
本机清单内容，只保存监督脚本与 Git 忽略配置文件的绝对路径。

单机清单可以让 Hub 只监听 `127.0.0.1`；需要额外 worker 时使用 VPN 私网地址和
VPN 网卡监听；只有确实需要多个私网接口时才使用 `0.0.0.0`。不要把 token、飞书
App Secret、profile 目录、导出的 worker 清单或
`pilot.local.json` 提交到仓库。任务产物可能含敏感内容，普通停止和回退不会删除产物。

## 验收

新建一个飞书话题。先 @ 一个 Agent 创建并发送一个文件，再 @ 另一个 Agent 继续修改它。
第二个 Agent 通过自己的 dispatch 拿到目标，并按需取用那个共享产物；另一个话题不应看到
这段上下文。

启动后先看 `Hub health: True` 和各本机 Agent 的 `Running: True`、`Worker`。Bot 不回复时
看组件日志。单机模式先验证本机 Bot 之间照常交接。多机模式再让 worker Bot 接手：它应取得
同一 taskId、自己的 dispatch 和经过权限筛选的上下文；使用另一 Agent 的凭据读取时必须被
拒绝。Git 交付件可用 `collab-artifact.cmd register-git` 登记 commit locator；飞书文件会在
拿到 `messageId + fileKey` 时登记飞书 locator。本地路径始终只表示当前节点缓存。

文件发布会自愈当前 Bot 的隔离 lark-cli 工作区：仅当准确收到“lark-channel 未绑定”
错误时，自动按 `bot-only` 重绑一次并重试一次发送；绝不回退到其他 profile 或用户
身份。重试仍失败时才保留准确命令错误和本机文件路径用于诊断。
