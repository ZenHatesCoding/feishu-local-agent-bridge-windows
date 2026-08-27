# Windows Deployment And Operations

[Back to README](../README.md) | [中文](./WINDOWS_OPERATIONS.zh-CN.md) |
[Agent bridges](./AGENT_BRIDGES.md) | [Design](./DESIGN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

## Responsibility Boundary

The project deploys the local Hub, ledger, visibility/routing protocol,
artifact store, maintained bridge adapters, Hermes Hook and background process
management. The user supplies Windows/Git/Node/pnpm, installed and logged-in
agents, one Feishu app/profile per bot, actual launch commands, workspaces and
model settings.

The commands in this document operate a Pilot on **one Windows computer**. Do
not use them to expose the current Hub directly to the Internet. See the
[distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) for remote-worker
status, gaps and the target configuration.

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
`USERPROFILE` in these pilot-owned entry points.

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

## Local Data

```text
.runtime\pilot.local.json       machine-specific launch configuration
.runtime\hub-token.txt          Hub bearer token
.runtime\tenant-key.txt         collaboration domain
.runtime\hub-config.json        generated Hub configuration
.runtime\collaboration.jsonl    append-only task ledger
.runtime\artifacts\             SHA-256 task snapshots
.runtime\logs\                 stdout and stderr
.runtime\pids.json              tracked launcher PIDs
```

The Hub binds to `127.0.0.1` by default. Never commit tokens, App Secrets,
profiles or `pilot.local.json`. Artifacts can contain sensitive user data and
are not removed by ordinary stop/rollback.

## Acceptance Test

Start a new Feishu topic. Mention one agent to create and send a file, then
mention another agent to continue and modify it. The second should receive the
shared summary and read the stable snapshot under `.runtime\artifacts`; another
topic must not see that context.

Status should show Hub health and one real worker process per enabled agent.
Use the component log when a bot does not reply.
