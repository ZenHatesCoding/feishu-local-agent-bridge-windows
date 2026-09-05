# Windows 飞书本地 Agent 桥接

把 Claude Code、Codex、Google Antigravity、DeepSeek Harness 和 Hermes 接入
飞书/Lark，可以各自作为独立机器人，也可以在一个话题里像团队一样协作。

[English README](./README.md)

## 一个推荐分支

新电脑统一拉 **`feature/feishu-multi-agent-hub`**。它现在同时包含所有维护中的
Agent 适配器、DeepSeek Harness 部署脚本、协作 Hub、共享文件和 Windows 后台管理。

```powershell
git clone --branch feature/feishu-multi-agent-hub --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
```

旧分支保留历史和回退价值，但新部署不再需要分别拉取：

| 分支 | 历史用途 | 新电脑建议 |
| --- | --- | --- |
| `main` | Claude Code、Codex、Antigravity 独立桥 | 改用最新功能分支 |
| `antigravity` | 较早的 Antigravity 专用封装 | 仅历史保留 |
| `deepseek-harness` | 较早的 DeepSeek 专用封装 | 仅历史保留 |
| `feature/feishu-multi-agent-hub` | 统一适配器与多 Agent 协作 | **统一使用** |

同一份 checkout 可以构建所有 bridge runtime。每个机器人仍需要独立的飞书应用/
profile 和对应 Agent 登录。Hermes 保留原安装，通过可移除的项目 Hook 接入。

每个 Agent 的准确配置见 [Agent bridge 指南](./docs/AGENT_BRIDGES.zh-CN.md)。

## 支持的 Agent

| Agent | 当前分支中的 bridge 模式 | 本机前置条件 |
| --- | --- | --- |
| Claude Code | 原生 `claude` 适配器 | 已安装并登录 `claude` CLI |
| Codex | 原生 `codex` 适配器 | 已安装并登录 Codex CLI |
| Google Antigravity | `antigravity` 适配器的 `agy` 模式 | 已在交互终端登录 `agy` |
| DeepSeek Harness | 独立 `deepseek-harness` 适配器 | Node.js 22+，Harness CLI 已构建 |
| Hermes | 隔离协作 Hook | 使用既有 Hermes，绝不重装 |

## 独立使用或协作使用

**独立 bridge：** 一个飞书应用只连接一个本地 Agent，拥有自己的 profile、会话、
工作区和凭据。

**多 Agent 协作群：** 多个机器人加入同一个群。一个飞书话题就是一个任务。先
`@` 一个 Agent 制定方案，再在同一话题 `@` 另一个 Agent 接手。接手者获得经过
授权的结论和持久共享文件，不会获得前一个 Agent 的私有思维链或无关历史。

设计的灵魂是：**共享任务状态，不共享脑内会话**。真实飞书 `@` 是用户可见的
唤醒信号，Hub `dispatch` 是工作授权。Agent 之间工作时两者必须同时存在，避免
意外广播和机器人互相唤醒循环。

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
| 不同电脑怎么安全联网，Tailscale 是什么？ | [多电脑联网](./docs/NETWORKING.zh-CN.md) | [Networking](./docs/NETWORKING.md) |
| 两个 Bot 能否运行在不同电脑？ | [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) |
| Pilot 脚本有哪些常用命令？ | [Pilot 脚本速查](./scripts/collab-pilot/README.zh-CN.md) | [Pilot script summary](./scripts/collab-pilot/README.md) |

README 是给使用者的统一入口；编码 Agent 从 [AGENTS.md](./AGENTS.md) 进入。每份维护中
的详细文档都会链接回这里和另一语言版本。

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

仓库部署 Hub、协议、bridge 代码和进程管理。使用者负责每个 Agent 的安装/登录、
飞书应用/profile、启动命令、工作区和模型设置。修改清单前阅读
[Windows 运维](./docs/WINDOWS_OPERATIONS.zh-CN.md)。

## 运行时参考

每个 profile 都可以作为 per-profile service 后台运行。Windows 使用计划任务和
`.cmd` launcher。常用命令：

```text
lark-channel-bridge start --profile <name>
lark-channel-bridge status --profile <name>
lark-channel-bridge stop --profile <name>
lark-channel-bridge profile export <name>
lark-channel-bridge profile export <name> --include-secrets --yes
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
```

飞书内常用 `/status`、`/config`、`/cd`、`/ws`、`/resume`、`/stop`、
`/doctor`、`/invite user`、`/remove user`、`/invite group`、`/remove group` 和
`/invite all group`。

云文档评论按文档权限生效。聊天访问默认私有。当前 profile 的 lark-cli 目录会
隔离每个机器人的授权；lark-cli 身份策略默认是 `bot-only`。

工作区使用 `workspaces.default`。标准权限配置是：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

旧版 `sandbox` 字段只用于迁移读取。

## 安全

- profile 和 App Secret 只保存在本机并被 Git 忽略。
- Hub 默认只监听 `127.0.0.1`。
- Pilot 默认继续支持一台 Windows 电脑运行 Hub 和全部 Bot，也已支持额外 worker 通过
  私网连接同一个 Hub 和每 Agent 独立鉴权；文件自动下载状态见
  [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。
- 协作可见性是协议隔离，不是操作系统强隔离。
- 不重装、不升级 Hermes，只增加/移除有明确名称的项目 Hook。
- `Stop-CollabPilot.ps1 -RestoreOriginals` 可以恢复清单中的独立 bridge，不删除
  共享任务产物。

## 开发

```powershell
pnpm test
pnpm typecheck
pnpm build
```

本项目基于 [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)，并沿用原 [MIT 许可证](./LICENSE)。
