# Feishu Local Agent Bridge for Windows

Connect Claude Code, Codex, Google Antigravity, DeepSeek Harness and Hermes to
Feishu/Lark, either as independent bots or as a team collaborating in one topic.

[中文说明](./README.zh.md)

## Which Branch To Clone

The repository ships the Hub, the collaboration protocol, the bridge adapters and
the Windows process management. Pick the branch that matches the machine:

| Branch | Contains | Clone it on |
| --- | --- | --- |
| `release/worker` | Hub-less worker deployment as released: worker bootstrap, adapters, process management, one whole-pilot task | **A machine that runs bots but must never start a Hub** |
| `develop/worker` | Worker-side development. Adds the per-agent supervisor and task, the per-agent journal root, and the Windows fixes listed below | A worker machine that wants those, or contributes back |
| `release/hub` | Stable Hub deployment | The machine that runs the Hub (usually also bots) |
| `develop/hub` | Hub-side development | Hub-side work only |
| `codex/lan-collaboration` | Private-network experiments | Reference only |
| `archive/*` | Earlier packages and milestones | History only |

A Hub-less machine starts here:

```powershell
git clone --branch release/worker --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
```

The same checkout can build every bridge runtime. Each bot still needs its own
Feishu app/profile and its own local agent login. Hermes stays in its existing
install and connects through the removable project Hook.

Exact setup for each agent: [Agent bridge guide](./docs/AGENT_BRIDGES.md).

## Supported Agents

| Agent | Bridge mode in this branch | Local prerequisite |
| --- | --- | --- |
| Claude Code | Native `claude` adapter | Installed and logged-in `claude` CLI |
| Codex | Native `codex` adapter | Installed and logged-in Codex CLI |
| Google Antigravity | `antigravity` adapter in `agy` mode | Interactive `agy` login |
| DeepSeek Harness | Independent `deepseek-harness` adapter | Node.js 22+ and an importable Harness entry |
| Hermes | Isolated collaboration Hook | Existing Hermes installation; never reinstalled |

## Independent Or Collaborative

An **independent bridge** is one Feishu app talking to one local agent, with its
own profile, sessions, workspaces and credentials.

A **collaborative group** puts several bots in one group. One Feishu topic is one
conversation, and agents and people reply to each other inside it. When a message
transfers or requests work, it carries explicit work semantics: the next agent
gets the task, the accepted conclusions and the decisions, but not the previous
agent's private reasoning or unrelated history. Files are registered as artifacts
on the Hub and fetched on demand; automatic download on the receiving side is
still on the [roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md).

Share task state, not model mind-state. A real Feishu `@` is the visible wake-up
signal and a Hub attention grant (`dispatch`) authorizes the run; both are needed
before one agent answers another, which is what stops accidental fanout and
wake-up loops. Ownership comes from a human mention and moves only on `handoff`.
`reply` and `ask` never change it.

Read [collaboration design](./docs/DESIGN.md) and the
[product north star](./docs/PRODUCT_VISION.md) before changing this protocol.

## Documentation

| Question | English | 中文 |
| --- | --- | --- |
| What are Hub, Pilot and dispatch? | [Concepts](./docs/COLLABORATION_CONCEPTS.md) | [概念入门](./docs/COLLABORATION_CONCEPTS.zh-CN.md) |
| How do I configure each agent bridge? | [Agent bridges](./docs/AGENT_BRIDGES.md) | [Agent 桥接](./docs/AGENT_BRIDGES.zh-CN.md) |
| What experience must the project preserve? | [Product vision](./docs/PRODUCT_VISION.md) | [产品目标](./docs/PRODUCT_VISION.zh-CN.md) |
| How do context, routing and files work? | [Design](./docs/DESIGN.md) | [设计原理](./docs/DESIGN.zh-CN.md) |
| How do I deploy and operate the group? | [Windows operations](./docs/WINDOWS_OPERATIONS.md) | [Windows 运维](./docs/WINDOWS_OPERATIONS.zh-CN.md) |
| How do I add a Worker machine without a Hub? | [Windows worker deployment](./docs/WINDOWS_WORKER_DEPLOYMENT.md) | [Windows Worker 部署](./docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
| What already bit people on Windows? | [Worker pitfalls](./docs/WINDOWS_WORKER_PITFALLS.md) | [Worker 实战坑](./docs/WINDOWS_WORKER_PITFALLS.zh-CN.md) |
| How do computers connect securely, and what is Tailscale? | [Networking](./docs/NETWORKING.md) | [多电脑联网](./docs/NETWORKING.zh-CN.md) |
| Can Bots run on different computers? | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) | [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
| What are the common Pilot commands? | [Pilot script summary](./scripts/collab-pilot/README.md) | [Pilot 脚本速查](./scripts/collab-pilot/README.zh-CN.md) |

This README is the human entry point; coding agents start at
[AGENTS.md](./AGENTS.md). Every maintained document links back here and to its
language counterpart.

## Build Once

```powershell
Set-Location C:\feishu-local-agent-bridge
corepack enable
pnpm install
pnpm build
```

Start one independent Claude, Codex or Antigravity bridge with a dedicated
profile:

```powershell
node .\dist\cli.js run --profile codex --agent codex --workspace C:\workspaces\codex
node .\dist\cli.js run --profile claude --agent claude --workspace C:\workspaces\claude
node .\dist\cli.js run --profile antigravity --agent antigravity --workspace C:\workspaces\antigravity
```

Prepare and bind DeepSeek Harness from the same checkout:

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

## Start A Collaborative Group

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

The repository deploys the Hub, the protocol, the bridge code and the process
management. You supply each agent installation and login, the Feishu
app/profile, the launch command, the workspace and the model settings. Read
[Windows operations](./docs/WINDOWS_OPERATIONS.md) before editing the manifest.

## Run Bots Without A Hub

A second Windows machine runs the same bridge code in the `worker` role. It talks
to a Hub over a private network, starts no Hub of its own, and gives every agent
its own manifest, scheduled task, credential and observed-topic journal. Two
agents on one machine behave like two machines.

```powershell
# 1. manifest: .runtime\worker-<agent>.local.json  (schemaVersion 2, role "worker")
# 2. credential at User scope
[Environment]::SetEnvironmentVariable('LARK_COLLAB_<AGENT>_TOKEN', '<token>', 'User')
# 3. one event-driven supervisor task per agent
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-<agent>.local.json -Agent <agent> -StartNow
```

Step 3 needs `develop/worker`: `release/worker` registers one whole-pilot task
instead, and its journal is still per machine. Follow
[Windows worker deployment](./docs/WINDOWS_WORKER_DEPLOYMENT.md) for the full
recipe, and read [worker pitfalls](./docs/WINDOWS_WORKER_PITFALLS.md) before
debugging a bot that stays silent.

## Runtime Reference

Each profile can run as a per-profile service. Windows uses Task Scheduler and a
`.cmd` launcher (task `LarkChannelBridge.Bot.<profile>`); macOS uses launchd and
Linux a systemd user unit. Useful commands:

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

In Feishu, `/help` lists the commands. The ones people use most are `/new`,
`/reset`, `/resume`, `/cd`, `/ws`, `/status`, `/stop`, `/ps`, `/doctor`,
`/reconnect`, `/account`, `/config` and `/exit`. The bot owner or an admin manages
access from the chat: `/invite user`, `/remove user`, `/invite admin`,
`/invite group`, `/remove group` and `/invite all group`.

Cloud-doc comments are document-scoped and follow document permissions. Chat
access is private by default. The profile-local lark-cli directory keeps each
bot's authorization separate; the lark-cli identity policy defaults to
`bot-only`.

Workspaces use `workspaces.default`. Canonical permission configuration is:

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

The legacy `sandbox` setting is read for migration only.

## Safety

- Profile state and App Secrets remain local and Git-ignored.
- The Hub listens on `127.0.0.1` by default.
- Pilot preserves one-PC Hub-plus-all-Bots operation and also supports remote
  workers with per-Agent authentication over a private network. Automatic
  artifact retrieval is tracked in the
  [distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md).
- Collaboration visibility is protocol isolation, not OS isolation.
- Hermes is not reinstalled or upgraded; only the named Hook is added or removed.
- `Stop-CollabPilot.ps1 -RestoreOriginals` restores the configured independent
  bridge launchers without deleting shared task artifacts.

## Development

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Based on [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)
and distributed under the original [MIT license](./LICENSE).
