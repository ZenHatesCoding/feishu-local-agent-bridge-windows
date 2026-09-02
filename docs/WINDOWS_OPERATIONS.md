# Windows Deployment And Operations

[Back to README](../README.md) | [中文](./WINDOWS_OPERATIONS.zh-CN.md) |
[Agent bridges](./AGENT_BRIDGES.md) | [Design](./DESIGN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Networking](./NETWORKING.md) |
[Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

## Responsibility Boundary

The project deploys the local Hub, ledger, visibility/routing protocol,
artifact store, maintained bridge adapters, Hermes Hook and background process
management. The user supplies Windows/Git/Node/pnpm, installed and logged-in
agents, one Feishu app/profile per bot, actual launch commands, workspaces and
model settings.

Pilot supports both one Windows computer running the Hub and all Bots, and
multiple computers connected to one Hub. Start with `role: "all"`: the main PC
is both the center and an execution node. Later workers add Bots without moving
the Bots already running on the main PC.

The project does not install, reinstall or upgrade agents and does not store
Feishu App Secrets in the pilot manifest.

## Clone And Build

```powershell
git clone --branch feature/feishu-multi-agent-hub --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
Set-Location C:\feishu-local-agent-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\collab-pilot\Setup-CollabPilot.ps1
```

Setup runs `pnpm install`, `pnpm build` and creates Git-ignored
`.runtime\pilot.local.json` from `config\collaboration-pilot.example.json`.
It preserves an existing manifest unless `-Force` is explicit.

```powershell
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
```

Validation does not connect Feishu, stop bridges or install Hermes.

## Manifest

Each enabled `agents[]` entry contains identity, aliases, launch executable,
arguments, working directory and environment. Optional `original.stop/start`
commands switch between collaboration and an existing independent bridge.
`ignoreExitCode` is useful only for an idempotent stop command. Only Hermes
uses `hermesHook`.

`hub.maxCausalDepth` limits one Agent-to-Agent causal chain, not the lifetime
number of turns in a topic. Legacy `maxHops` is read only for manifest
migration; new manifests should use `maxCausalDepth`.

Paths support `%USERPROFILE%`, `%PATH%`, `${REPO_ROOT}`, `${STATE_DIR}` and
`${LOCALAPPDATA}`. Escape Windows backslashes in JSON.

See [Agent bridges](./AGENT_BRIDGES.md) for exact Claude, Codex, Antigravity,
DeepSeek Harness and Hermes launch examples. A launch command alone is not
enough for an unknown agent: its bridge must request `collaboration_context`,
honor dispatch authorization, submit final actions and publish artifacts.

## Single-PC Compatibility And Node Roles

An existing manifest without `role` means `all`, preserving the original
single-PC startup behavior. `all` runs the Hub and local Bots, `hub` runs only
the Hub, and `worker` runs local Bots against `hub.publicUrl` without starting
another Hub. An enabled entry with `runOnThisNode: false` is registered by the
main Hub but is not launched there.

For a main PC that is also an execution node:

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

Use a Tailscale, WireGuard, or enterprise VPN address. The main node creates a
separate random credential for each registered Agent and derives agent identity
from that credential. Export a private starter manifest for a registered Agent:

```powershell
.\scripts\collab-pilot\Export-CollabWorkerConfig.ps1 `
  -Agent reviewer -HubUrl http://100.x.y.z:17321 `
  -OutputPath .\.runtime\worker-reviewer.local.json
```

The export contains one credential. Transfer it privately, never commit it,
and update node-specific launch/profile/workspace paths before using `-Config`.
`config\collaboration-worker.example.json` shows environment-based credentials.

## Collaboration Group Allowlist

Each Node bridge profile maintains its own Feishu group allowlist. Hub task
authorization does not bypass this message-entry access control, so every Node
bridge that people or other agents will mention in the same collaboration group
(for example Codex, Antigravity, and DeepSeek Harness) must allow that group.

For first-time setup, the owner or an admin of **each bot** should mention that
bot in the target group and send `/invite group`; repeat this for World,
Justice, Chariot, and any other Node bridge. Group profiles commonly require a
real bot mention, so a bare `/invite group` is intentionally ignored.

If a bot says that the group is not in its response list, that bot's own
profile has not allowed the group; it is not a Hub, dispatch, or agent-login
failure. Alternatively, add the current `chat_id` to
`profiles.<profile>.access.allowedChats` in that profile's `config.json`, then
restart only that agent:

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent justice
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent justice
```

Do not assume one bot's `allowedChats` applies to another profile: write and
verify each profile independently. Hermes uses its own native Feishu access
policy and does not use the `allowedChats` field; preserve its existing
configuration and validate its group-mention behavior separately.

The pilot prepends `scripts\collab-pilot\bin` to every agent's `PATH`. Its
`lark-cli.cmd` and `lark-cli.ps1` are identity-neutral entry points: they invoke
only the real `larkCliJs` configured by the local manifest and preserve the
current agent's `LARK_CHANNEL_*` and `LARKSUITE_CLI_CONFIG_DIR` environment.
This prevents a stale same-name shim in an external bridge directory from
sending as another bot. Never hard-code a profile path, App ID, `HOME`, or
`USERPROFILE` in these pilot-owned entry points. The prepend happens after
manifest environment overrides, so a manifest `PATH` cannot place an old shim
ahead of the Pilot command. Agent-specific routing variables are cleared before
the selected Agent environment is applied.

## Network Boundary

Use `commonEnvironment` and `unsetEnvironment` for the direct baseline, then
override only the child agent that needs a proxy. Do not route the Hub or every
bot through a proxy because one model CLI requires it. When Antigravity uses
`agy.exe`, the pilot can derive the current Windows user proxy for that agent
while `LARK_CHANNEL_DISABLE_PROXY=1` keeps Feishu direct and `NO_PROXY` keeps
localhost Hub calls local.

Network setup must not install, reset or migrate agent authentication data.
Diagnose Hub health, bridge connectivity, CLI availability, proxy listener and
model endpoint separately; an upstream EOF or timeout is not itself proof of
expired authentication.

## Start, Status And Logs

For durable operation, install the current-user Windows logon task. It runs a
long-lived supervisor independently of the PowerShell, Codex, or ChatGPT window
that installed it. Every 15 seconds the supervisor checks the Hub and local Bot
launcher processes and starts any exited component again:

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

`-StartNow` first stops a temporary Pilot and then starts the Windows task, so
the new process tree is owned by the background task. The task uses the current
user's interactive logon token, preserving that user's Agent sessions, profiles,
and proxy settings without storing another password. Remove the task and stop
the Pilot with:

```powershell
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

`Start-CollabPilot.ps1` remains the temporary development entry point. Its
hidden child processes are not the durable cross-terminal lifecycle contract.

```powershell
# all enabled agents
.\scripts\collab-pilot\Start-CollabPilot.ps1

# one agent; starts the Hub automatically
.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent planner

# status and logs
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent planner
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name planner -Tail 200
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name planner -Follow
```

## Stop And Roll Back

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

Rollback invokes only commands explicitly present in the local manifest. It
does not delete the ledger or shared artifacts. Hermes stop removes only
`feishu-collaboration-hub` under the configured hooks directory.

Normal Agent stop first asks the bridge registered in that Agent's isolated
`LARK_CHANNEL_HOME` to exit, then terminates the tracked launcher only as a
fallback. If Windows had to terminate the bridge externally, the runtime
removes only profile/app locks whose metadata still names that dead PID. This
makes an immediate Stop-to-Start cycle safe without waiting for lock expiry or
manually deleting lock files.

## Local Data

```text
.runtime\pilot.local.json       machine-specific launch configuration
.runtime\hub-token.txt          Hub administrative credential
.runtime\agent-tokens.json      one independent Hub credential per Agent
.runtime\tenant-key.txt         collaboration domain
.runtime\hub-config.json        generated Hub configuration
.runtime\collaboration.jsonl    append-only task ledger
.runtime\artifacts\             SHA-256 task snapshots
.runtime\logs\                 stdout and stderr
.runtime\pids.json              tracked launcher PIDs
```

Supervisor repair events are written to `.runtime\logs\supervisor.log`. The
Windows task stores only absolute paths to the supervisor and Git-ignored local
manifest; it does not embed tokens, App Secrets, or manifest contents.

A single-PC manifest can bind only to `127.0.0.1`. For workers, bind on the VPN
interface and use its private URL. Never commit tokens, worker exports, App
Secrets, profiles, or `pilot.local.json`.

## Acceptance Test

Start a new Feishu topic. Mention one agent to create and send a file, then
mention another agent to continue and modify it. The second should receive the
shared summary and read the stable snapshot under `.runtime\artifacts`; another
topic must not see that context.

Status should show Hub health and one real worker process per enabled agent.
Use the component log when a bot does not reply.

Artifact publishing is self-healing for the current Bot's isolated lark-cli
workspace: an exact “lark-channel not bound” result triggers one `bot-only`
rebind and one delivery retry. It never falls back to another profile or user
identity. A repeated failure is reported with the exact command error and local
file path for diagnosis.
