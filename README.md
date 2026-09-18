# Feishu Local Agent Bridge for Windows

Connect Claude Code, Codex, Google Antigravity, DeepSeek Harness and Hermes to
Feishu/Lark, either as independent bots or as a team collaborating in one topic.

[中文说明](./README.zh.md)

## Worker Deployment Branch

For a second Windows machine that runs a Worker but never starts a Hub, clone
**`release/worker`**. It contains the tested Worker bootstrap, bridge adapters
and Windows process management.

```powershell
git clone --branch release/worker --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
```

`develop/worker` is the matching development branch. All `archive/*` branches
are rollback/history only:

| Branch | Historical scope | New-install recommendation |
| --- | --- | --- |
| `release/worker` | Stable second-PC Worker deployment | **Use for a new Worker machine** |
| `develop/worker` | Worker bootstrap development | Merge after real second-PC acceptance |
| `release/hub` / `develop/hub` | Central Hub deployment and development | Use on the Hub machine, not this Worker |
| `archive/*` | Earlier packages and milestones | History only |

The same checkout can build all bridge runtimes. Each bot still needs its own
Feishu app/profile and local agent login. Hermes stays in its existing install
and connects through the removable project Hook.

Exact setup for each agent: [Agent bridge guide](./docs/AGENT_BRIDGES.md).

## Supported Agents

| Agent | Bridge mode in this branch | Local prerequisite |
| --- | --- | --- |
| Claude Code | Native `claude` adapter | Installed and logged-in `claude` CLI |
| Codex | Native `codex` adapter | Installed and logged-in Codex CLI |
| Google Antigravity | `antigravity` adapter in `agy` mode | Interactive `agy` login |
| DeepSeek Harness | Independent `deepseek-harness` adapter | Node.js 22+ and built Harness CLI |
| Hermes | Isolated collaboration Hook | Existing Hermes installation; never reinstalled |

## Independent Or Collaborative

**Independent bridge:** one Feishu app talks to one local agent and keeps its
own profile, sessions, workspaces and credentials.

**Collaborative group:** several bots join one group. One Feishu topic is one
conversation. Agents and people can reply to one another in that topic; when a
message transfers or requests work, it carries explicit work semantics. The
next agent receives authorized conclusions and durable shared files without
receiving private reasoning or unrelated history.

The design soul is **share task state, not model mind-state**. A real Feishu `@`
is the visible wake-up signal; a Hub attention grant (`dispatch`) authorizes
the corresponding run. Both must exist for an agent-to-agent reply, preventing
accidental fanout and wake-up loops. Ownership changes only for explicit work
actions such as `handoff` and `ask`.

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
| How do computers connect securely, and what is Tailscale? | [Networking](./docs/NETWORKING.md) | [多电脑联网](./docs/NETWORKING.zh-CN.md) |
| Can Bots run on different computers? | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) | [跨电脑路线图](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
| What are the common Pilot commands? | [Pilot script summary](./scripts/collab-pilot/README.md) | [Pilot 脚本速查](./scripts/collab-pilot/README.zh-CN.md) |

This README is the human entry point; coding agents start at
[AGENTS.md](./AGENTS.md). Every maintained detailed document links back here
and to its language counterpart.

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

The repository deploys the Hub, protocol, bridge code and process management.
You provide each agent installation/login, Feishu app/profile, launch command,
workspace and model settings. See [Windows operations](./docs/WINDOWS_OPERATIONS.md)
before editing the manifest.

## Runtime Reference

Each profile can run as a per-profile service. Windows uses Task Scheduler and
a `.cmd` launcher. Useful commands:

```text
lark-channel-bridge start --profile <name>
lark-channel-bridge status --profile <name>
lark-channel-bridge stop --profile <name>
lark-channel-bridge profile export <name>
lark-channel-bridge profile export <name> --include-secrets --yes
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
```

Feishu commands include `/status`, `/config`, `/cd`, `/ws`, `/resume`, `/stop`,
`/doctor`, `/invite user`, `/remove user`, `/invite group`, `/remove group` and
`/invite all group`.

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
- Hermes is not reinstalled or upgraded; only the named Hook is added/removed.
- `Stop-CollabPilot.ps1 -RestoreOriginals` restores configured independent
  bridge launchers without deleting shared task artifacts.

## Development

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Based on [`zarazhangrui/lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge)
and distributed under the original [MIT license](./LICENSE).
