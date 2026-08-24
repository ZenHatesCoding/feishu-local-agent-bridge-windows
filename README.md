# Feishu Local Agent Bridge for Windows

Connect Claude Code, Codex, Google Antigravity, DeepSeek Harness and Hermes to
Feishu/Lark, either as independent bots or as a team collaborating in one topic.

[中文说明](./README.zh.md)

## One Recommended Branch

For a new installation, clone **`feature/feishu-multi-agent-hub`**. It now
contains all maintained bridge adapters, DeepSeek Harness setup scripts, the
collaboration Hub, shared-file support and Windows process management.

```powershell
git clone --branch feature/feishu-multi-agent-hub --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
```

Older branches remain useful as rollback/history, but are not required for a
fresh deployment:

| Branch | Historical scope | New-install recommendation |
| --- | --- | --- |
| `main` | Claude Code, Codex and Antigravity independent bridges | Use the latest feature branch instead |
| `antigravity` | Earlier Antigravity-only packaging | History only |
| `deepseek-harness` | Earlier DeepSeek-only packaging | History only |
| `feature/feishu-multi-agent-hub` | Unified adapters plus collaboration | **Use this branch** |

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
| DeepSeek Harness | The same adapter in explicit Harness mode | Node.js 22+ and built Harness CLI |
| Hermes | Isolated collaboration Hook | Existing Hermes installation; never reinstalled |

## Independent Or Collaborative

**Independent bridge:** one Feishu app talks to one local agent and keeps its
own profile, sessions, workspaces and credentials.

**Collaborative group:** several bots join one group. One Feishu topic is one
task. Mention one agent to plan, then mention another in the same topic to take
over. The next agent receives authorized conclusions and durable shared files
without receiving private reasoning or unrelated history.

The design soul is **share task state, not model mind-state**. A real Feishu `@`
is the visible wake-up signal; a Hub `dispatch` is the work authorization. Both
must exist for agent-to-agent work, preventing accidental fanout and wake-up
loops.

Read [collaboration design](./docs/DESIGN.md) and the
[product north star](./docs/PRODUCT_VISION.md) before changing this protocol.

## Documentation

| Question | English | 中文 |
| --- | --- | --- |
| How do I configure each agent bridge? | [Agent bridges](./docs/AGENT_BRIDGES.md) | [Agent 桥接](./docs/AGENT_BRIDGES.zh-CN.md) |
| What experience must the project preserve? | [Product vision](./docs/PRODUCT_VISION.md) | [产品目标](./docs/PRODUCT_VISION.zh-CN.md) |
| How do context, routing and files work? | [Design](./docs/DESIGN.md) | [设计原理](./docs/DESIGN.zh-CN.md) |
| How do I deploy and operate the group? | [Windows operations](./docs/WINDOWS_OPERATIONS.md) | [Windows 运维](./docs/WINDOWS_OPERATIONS.zh-CN.md) |

This README is the canonical entry point. Every detailed document links back
here and to its language counterpart.

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
