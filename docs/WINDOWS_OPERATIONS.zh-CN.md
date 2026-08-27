# Windows 部署与运维

[返回中文 README](../README.zh.md) | [English](./WINDOWS_OPERATIONS.md) |
[Agent 桥接](./AGENT_BRIDGES.zh-CN.md) | [协作设计](./DESIGN.zh-CN.md) |
[概念入门](./COLLABORATION_CONCEPTS.zh-CN.md) | [跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)

本文面向从 GitHub 克隆项目的新电脑。新部署统一使用
`feature/feishu-multi-agent-hub`，不再需要为不同 Agent 拉多份分支。

本文命令管理的是**同一台 Windows 电脑上的 Pilot**。跨电脑的正确运维入口将使用
远程 worker、每 Agent 身份和安全传输，状态与目标配置见
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。

## 责任边界

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

## 从 GitHub 部署

```powershell
git clone -b feature/feishu-multi-agent-hub https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git C:\feishu-multi-agent-hub
Set-Location C:\feishu-multi-agent-hub
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

每个 `agents[]` 元素定义一个机器人身份和一个实际进程：

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
- `original.stop/start` 可选。配置后，切换到协作 bridge 前会停止旧监听器；回退时可恢复旧监听器，避免同一个飞书 App 同时被两份进程消费。
- 停止命令在“原 bridge 本来就没运行”时可能返回非零，可对 `original.stop` 设置 `"ignoreExitCode": true`；恢复命令不建议忽略失败。
- `hermesHook` 仅用于 Hermes。启用后只复制本项目 Hook 到指定 Hermes Home，停止时只删除该 Hook，不修改源码、venv、配置、记忆或技能。
- `enabled: false` 可保留尚未准备好的 Agent，不会加入 Hub 或被启动。
- `hub.maxCausalDepth` 限制单条 Agent 委派因果链的深度，不限制一个话题的累计工作轮数。旧 `maxHops` 仅用于读取旧清单；新配置应使用 `maxCausalDepth`。

路径支持 `%USERPROFILE%`、`%PATH%`、`${REPO_ROOT}`、`${STATE_DIR}`、`${LOCALAPPDATA}`。JSON 中 Windows 反斜杠需要写成 `\\`。

`larkCliJs` 是真实飞书 CLI 的 JavaScript 入口，用于让 Agent 发送共享文件。若所用 bridge 自己实现了文件发送，可以留空；否则应填写本机实际路径。

## 适配不同 Agent

Codex、Claude、Antigravity 或 DeepSeek Harness 应使用本仓库相应适配器构建出的 bridge，再把构建产物和 Agent 可执行文件写入 `launch`。Agent 本身的模型、推理强度、速度和登录状态仍由各 Agent 自己管理。

新的第三方 Agent 需要一个适配器完成四件事：

1. 接收飞书消息时向 Hub 请求 `collaboration_context`；
2. 只在 Hub 授权且消息真实 `@` 到自己时运行；
3. 把最终摘要、委派和完成状态回写 Hub；
4. 通过产物协议登记和发送文件。

只有启动命令、但没有这四项协议实现的 Agent，不能获得正确的共享与隔离语义。参照 `src/collab`、`src/agent` 和 `adapters/hermes` 编写适配器后，部署脚本无需再改，只需在本地清单增加一个 Agent。

## 协作群白名单

每个 Node bridge profile 都独立维护飞书群白名单；Hub 的任务授权不会绕过这层
消息入口访问控制。因此，所有会在同一协作群中被人或其他 Agent `@` 的 Node
bridge（例如 Codex、Antigravity、DeepSeek Harness）都必须分别允许该群。

最稳妥的首次配置方式是由**每个 bot 的 owner 或管理员**在目标群中，逐一真实
`@` 对应 bot 并发送 `/invite group`。例如分别对 World、Justice、Chariot 操作一次。
群内通常启用了“必须 @bot”策略，单独发送裸的 `/invite group` 会被静默忽略。

如果 bot 回复“当前群尚未加入响应列表”，说明当前 bot 自己的 profile 尚未加入该群，
不是 Hub、dispatch 或 Agent 登录失效。也可在该 profile 的 `config.json` 中把当前
`chat_id` 添加到 `profiles.<profile>.access.allowedChats`，然后仅重启对应 Agent：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent justice
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent justice
```

不要把一个 bot 的 `allowedChats` 复制后就假定其他 bot 也已生效：每个 profile 都需要
单独写入和验证。Hermes 使用自己的原生飞书访问策略，不适用 `allowedChats` 字段；保持
其现有配置，并按 Hermes 的接入方式单独验证群内 @ 响应。

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

Pilot 还会把 `scripts\collab-pilot\bin` 放在每个 Agent 的 `PATH` 最前面。目录内的
`lark-cli.cmd` / `lark-cli.ps1` 是不绑定身份的统一入口：它们只调用清单中配置的真实
`larkCliJs`，并保留当前 Agent 的 `LARK_CHANNEL_*` 和 `LARKSUITE_CLI_CONFIG_DIR`。因此即使
某个外部 bridge 目录残留了写死其他 bot profile 的同名脚本，也不能劫持当前 bot 的发送
身份。不要在这些统一入口中写死 profile 路径、App ID、`HOME` 或 `USERPROFILE`。

## 网络环境边界

`commonEnvironment` 和 `unsetEnvironment` 用于建立默认直连环境；某个 Agent 的
`launch.environment` 只覆盖自己的子进程。不要为了一个模型 CLI 修改 Hub 或所有
机器人的全局代理。Antigravity 使用 `agy.exe` 时，pilot 会在未显式配置代理的前提下
读取 Windows 当前用户代理，并只传给该 Agent；`LARK_CHANNEL_DISABLE_PROXY=1` 仍让
飞书连接直连，`NO_PROXY` 则保证本机 Hub 地址不经过代理。

认证文件属于 Agent 自己，网络配置不应安装、重置或迁移认证数据。排查时分别检查
Hub health、bridge 是否连接、Agent CLI 是否可执行、代理端口和模型端点，不能把模型
端点的 EOF 或超时直接归类成登录失效。

## 后台启停

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

停止协作 bridge，或停止后恢复该 Agent 的原 bridge：

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

也可让多个克隆或多套环境使用独立清单：

```powershell
.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config C:\private\team-a.json
```

## 数据和安全

默认运行数据都在 `.runtime`，不会提交 Git：

```text
.runtime\pilot.local.json       本机路径与启动配置
.runtime\hub-token.txt          Hub bearer token
.runtime\tenant-key.txt         本机协作域
.runtime\hub-config.json        从本地清单生成的 Hub 配置
.runtime\collaboration.jsonl    任务账本
.runtime\artifacts\             SHA-256 文件快照
.runtime\logs\                 stdout/stderr
.runtime\pids.json              后台启动器 PID
```

Hub 默认只监听 `127.0.0.1`。不要把 token、飞书 App Secret、profile 目录或 `pilot.local.json` 提交到仓库。任务产物可能含敏感内容，备份与清理策略由电脑所有者决定，普通停止和回退不会删除产物。

## 验收与回退

启动后先看 `Hub health: True` 和各 Agent 的 `Running: True`、`Worker`。然后在同一飞书话题先 `@planner` 产出文件，再 `@reviewer` 接手修改。后者应看到共享摘要，并能读取 `.runtime\artifacts` 中前者的稳定快照；不同话题不能串线。

需要立即退出试验时：

```powershell
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

该命令只使用清单中明确配置的恢复命令。没有配置 `original.start` 的 Agent 会保持停止，需由使用者按自己的原方式启动。
