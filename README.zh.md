# Windows 飞书本地 Agent 桥接

把 Claude Code、Codex、Google Antigravity、DeepSeek Harness 和 Hermes 接入
飞书/Lark，可以各自作为独立机器人，也可以在一个话题里像团队一样协作。

[English README](./README.md)

## 该拉哪个分支

仓库负责提供 Hub、协作协议、bridge 适配器和 Windows 进程管理。按机器角色选分支：

| 分支 | 内容 | 用在哪种机器 |
| --- | --- | --- |
| `release/worker` | 已发布的无 Hub worker 部署：启动流程、适配器、进程管理、一个整机任务 | **跑 bot 但绝不启动 Hub 的机器** |
| `develop/worker` | Worker 侧开发。多了每 agent 一个的 supervisor 和任务、按 agent 分开的账本根目录，以及下面列出的 Windows 修复 | 想要这些能力的 worker 机器，或要回贡献代码的人 |
| `release/hub` | 稳定的 Hub 部署 | 运行 Hub 的机器（通常也跑 bot） |
| `develop/hub` | Hub 侧开发 | 只做 Hub 侧开发 |
| `codex/lan-collaboration` | 私网联通实验 | 仅作参考 |
| `archive/*` | 早期封装与里程碑 | 仅历史保留 |

无 Hub 的机器从这里开始：

```powershell
git clone --branch release/worker --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
```

同一份 checkout 可以构建所有 bridge runtime。每个机器人仍需要独立的飞书应用/
profile 和对应 Agent 登录。Hermes 保留原安装，通过可移除的项目 Hook 接入。

每个 Agent 的准确配置见 [Agent bridge 指南](./docs/AGENT_BRIDGES.zh-CN.md)。

## 支持的 Agent

| Agent | 当前分支中的 bridge 模式 | 本机前置条件 |
| --- | --- | --- |
| Claude Code | 原生 `claude` 适配器 | 已安装并登录 `claude` CLI |
| Codex | 原生 `codex` 适配器 | 已安装并登录 Codex CLI |
| Google Antigravity | `antigravity` 适配器的 `agy` 模式 | 已在交互终端登录 `agy` |
| DeepSeek Harness | 独立 `deepseek-harness` 适配器 | Node.js 22+，以及一个可被 import 的 Harness 入口 |
| Hermes | 隔离协作 Hook | 使用既有 Hermes，绝不重装 |

## 独立使用或协作使用

**独立 bridge** 就是一个飞书应用只接一个本地 Agent，有自己的 profile、会话、
工作区和凭据。

**协作群** 是多个机器人进同一个群，一个飞书话题就是一段对话，人和 Agent 在话题里
互相回复。消息只有在转交或请求工作时才带明确的工作语义：下一位 Agent 拿到任务、
已确认的结论和决策，但拿不到前一位 Agent 的私有推理或无关历史。文件会在 Hub 上
登记为 artifact，需要时按需取用；接收端自动下载还在
[路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)里。

共享任务状态，不共享脑内会话。真实飞书 `@` 是用户可见的唤醒信号，Hub 的注意力授权
（`dispatch`）授权这次运行，两者同时成立才会有一个 Agent 回应另一个 Agent，这样才
不会意外广播或互相唤醒。工作责任来自人的 `@`，只有 `handoff` 会转移它；`reply` 和
`ask` 都不改变负责人。

改协议前先读 [协作设计](./docs/DESIGN.zh-CN.md)和
[产品目标](./docs/PRODUCT_VISION.zh-CN.md)。

## 文档地图

| 问题 | 中文 | English |
| --- | --- | --- |
| Hub、Pilot、dispatch 到底是什么？ | [概念入门](./docs/COLLABORATION_CONCEPTS.zh-CN.md) | [Concepts](./docs/COLLABORATION_CONCEPTS.md) |
| 每个 Agent 的 bridge 怎么配置？ | [Agent 桥接](./docs/AGENT_BRIDGES.zh-CN.md) | [Agent bridges](./docs/AGENT_BRIDGES.md) |
| 项目必须守住什么用户体验？ | [产品目标](./docs/PRODUCT_VISION.zh-CN.md) | [Product vision](./docs/PRODUCT_VISION.md) |
| 上下文、路由、文件怎么工作？ | [设计原理](./docs/DESIGN.zh-CN.md) | [Design](./docs/DESIGN.md) |
| 协作群如何部署和运维？ | [Windows 运维](./docs/WINDOWS_OPERATIONS.zh-CN.md) | [Windows operations](./docs/WINDOWS_OPERATIONS.md) |
| 怎么加一台不跑 Hub 的 worker 机器？ | [Windows Worker 部署](./docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) | [Windows worker deployment](./docs/WINDOWS_WORKER_DEPLOYMENT.md) |
| Windows 上已经踩过哪些坑？ | [Worker 实战坑](./docs/WINDOWS_WORKER_PITFALLS.zh-CN.md) | [Worker pitfalls](./docs/WINDOWS_WORKER_PITFALLS.md) |
| 不同电脑怎么安全联网，Tailscale 是什么？ | [多电脑联网](./docs/NETWORKING.zh-CN.md) | [Networking](./docs/NETWORKING.md) |
| 两个 Bot 能否运行在不同电脑？ | [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) |
| Pilot 脚本有哪些常用命令？ | [Pilot 脚本速查](./scripts/collab-pilot/README.zh-CN.md) | [Pilot script summary](./scripts/collab-pilot/README.md) |

README 是给使用者的入口；编码 Agent 从 [AGENTS.md](./AGENTS.md) 进入。每份维护中的
文档都会链接回这里和另一语言版本。

## 一次构建

```powershell
Set-Location C:\feishu-local-agent-bridge
corepack enable
pnpm install
pnpm build
```

用独立 profile 启动 Claude、Codex 或 Antigravity：

```powershell
node .\dist\cli.js run --profile codex --agent codex --workspace C:\workspaces\codex
node .\dist\cli.js run --profile claude --agent claude --workspace C:\workspaces\claude
node .\dist\cli.js run --profile antigravity --agent antigravity --workspace C:\workspaces\antigravity
```

同一 checkout 中准备并绑定 DeepSeek Harness：

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

## 启动多 Agent 协作群

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

仓库负责部署 Hub、协议、bridge 代码和进程管理。你要准备的是每个 Agent 的安装和登录、
飞书应用/profile、启动命令、工作区和模型设置。改清单前先读
[Windows 运维](./docs/WINDOWS_OPERATIONS.zh-CN.md)。

## 不跑 Hub 也能跑 bot

第二台 Windows 机器用同一套 bridge 代码，以 `worker` 角色运行：通过私网连远端 Hub，
自己不启动 Hub，每个 agent 各有自己的 manifest、计划任务、凭据和"观察到的话题"账本。
一台机器跑两个 agent，行为等同于两台机器。

```powershell
# 1. manifest：.runtime\worker-<agent>.local.json（schemaVersion 2，role "worker"）
# 2. 凭据写到 User 作用域
[Environment]::SetEnvironmentVariable('LARK_COLLAB_<AGENT>_TOKEN', '<token>', 'User')
# 3. 每个 agent 一个事件驱动 supervisor 任务
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-<agent>.local.json -Agent <agent> -StartNow
```

第 3 步需要 `develop/worker`：`release/worker` 只能注册一个整机任务，账本也还是按机器
共用。完整步骤见 [Windows Worker 部署](./docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md)；
排查"bot 不吭声"之前先读 [Worker 实战坑](./docs/WINDOWS_WORKER_PITFALLS.zh-CN.md)。

## 运行时参考

每个 profile 都可以作为 per-profile service 后台运行。Windows 用计划任务加
`.cmd` launcher（任务名 `LarkChannelBridge.Bot.<profile>`）；macOS 用 launchd，
Linux 用 systemd user unit。常用命令：

```text
lark-channel-bridge start --profile <name>
lark-channel-bridge status --profile <name>
lark-channel-bridge stop --profile <name>
lark-channel-bridge restart --profile <name>
lark-channel-bridge unregister --profile <name>
lark-channel-bridge profile export <name>
lark-channel-bridge profile export <name> --include-secrets --yes
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
```

飞书里用 `/help` 看命令列表。最常用的是 `/new`、`/reset`、`/resume`、`/cd`、`/ws`、
`/status`、`/stop`、`/ps`、`/doctor`、`/reconnect`、`/account`、`/config` 和 `/exit`。
访问控制由 bot owner 或管理员在群内维护：`/invite user`、`/remove user`、
`/invite admin`、`/invite group`、`/remove group`、`/invite all group`。

云文档评论按文档权限生效。聊天访问默认私有。当前 profile 的 lark-cli 目录会隔离每个
机器人的授权；lark-cli 身份策略默认是 `bot-only`。

工作区使用 `workspaces.default`。标准权限配置是：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

旧版 `sandbox` 只用于迁移读取。

## 安全

- profile 和 App Secret 只保存在本机并被 Git 忽略。
- Hub 默认只监听 `127.0.0.1`。
- Pilot 保留一台电脑同时跑 Hub 和全部 Bot 的用法，也支持远端 worker 通过私网连同一个
  Hub、每 Agent 独立鉴权。文件自动下载的状态见
  [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。
- 协作可见性是协议隔离，不是操作系统强隔离。
- 不重装、不升级 Hermes，只增加或移除有明确名称的项目 Hook。
- `Stop-CollabPilot.ps1 -RestoreOriginals` 会恢复清单里的独立 bridge，不删除共享任务
  产物。

## 开发

```powershell
pnpm test
pnpm typecheck
pnpm build
```

本项目基于 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)，并沿用原 [MIT 许可证](./LICENSE)。
