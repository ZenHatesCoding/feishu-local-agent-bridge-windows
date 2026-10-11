# Windows Deployment And Operations

[Back to README](../README.md) | [中文](./WINDOWS_OPERATIONS.zh-CN.md) |
[Agent bridges](./AGENT_BRIDGES.md) | [Design](./DESIGN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Networking](./NETWORKING.md) |
[Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

## Responsibility Boundary

The central Hub computer runs `release/hub`, including the single-PC
`role: "all"` case. A second computer that must not start a Hub should clone
`release/worker` and follow
[Windows Worker Deployment](./WINDOWS_WORKER_DEPLOYMENT.md) instead.

The project deploys the local Hub, the task ledger, the visibility and routing
protocol, the artifact store, the maintained bridge adapters, the Hermes Hook
and background process management. That includes the collaboration environment
variables an Agent run needs and the `collab-artifact.cmd` delivery command. The
user supplies Windows/Git/Node/pnpm, the installed and logged-in agents, one
Feishu app/profile per bot, the actual launch commands, workspaces and model
settings.

Pilot supports both one Windows computer running the Hub and all Bots, and
multiple computers connected to one Hub. Start with `role: "all"`: the main PC
is both the center and an execution node. Later workers add Bots without moving
the Bots already running on the main PC.

The project does not install, reinstall or upgrade agents and does not store
Feishu App Secrets in the pilot manifest.

## Clone And Build

Run this in PowerShell. `<repo>` below is the checkout directory; the examples
use `C:\feishu-local-agent-bridge`, which is also the default state path.

```powershell
git clone --branch release/hub --single-branch `
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

The manifest is one JSON file (`schemaVersion: 2`) whose default path is
`.runtime\pilot.local.json`. The operator-facing scripts (`Setup-CollabPilot`,
`Test-CollabPilotConfig`, `Start-CollabPilot`, `Start-CollabAgent`,
`Stop-CollabPilot`, `Stop-CollabAgent`, `Status-CollabPilot`,
`Get-CollabPilotLog`, `Install-CollabPilotStartup`,
`Uninstall-CollabPilotStartup`, `Export-CollabWorkerConfig`) take `-Config` to
point at another copy. `run-agent.ps1` and `run-hub.ps1` take no parameters and
inherit `LARK_COLLAB_PILOT_CONFIG` from whoever launched them.

Two things are structurally required: `schemaVersion` and an `agents[]` list
with at least one enabled entry. Everything else has a default, so older
manifests keep working without edits.

Top-level fields:

| Field | Default when omitted | Meaning |
| --- | --- | --- |
| `role` | `"all"` | `all`, `hub` or `worker`; any other value is rejected |
| `nodeId` | the machine name | identifies this node to the Hub |
| `hub` | — | bind address, public URL, port, tenant key and limits |
| `larkCliJs` | empty, then auto-resolved | real `@larksuite/cli` JavaScript entry |
| `commonEnvironment` | — | environment for every local agent |
| `unsetEnvironment` | — | variables the pilot removes before it applies the manifest |
| `agents` | required | one entry per bot, enabled or not |

Each `agents[]` entry contains identity, aliases, launch executable, arguments,
working directory and environment. The fields that change behavior:

- `enabled` omitted means enabled; `enabled: false` keeps a bot registered in
  the manifest without registering or starting it.
- `runOnThisNode: false` registers the Agent with the Hub but does not launch it
  on this machine, which is how the main PC pre-registers a remote worker. When
  omitted, the Agent runs here.
- `credentialEnv` names the environment variable holding the Agent's Hub
  credential; `credential` is the literal fallback. On a Hub or `all` node the
  credential comes from `.runtime\agent-tokens.json` unless one of the two is set.
- Optional `original.stop/start` commands switch between collaboration and an
  existing independent bridge. `ignoreExitCode` on the stop command is useful
  when "the original bridge was not running" is not an error; do not ignore
  failures on the restore command.
- Only Hermes uses `hermesHook`, which copies this project's Hook into the
  configured Hermes home and removes only that Hook again.
- `hub.maxCausalDepth` limits one Agent-to-Agent causal chain, not the lifetime
  number of turns in a topic. Legacy `maxHops` is read only for manifest
  migration; new manifests should use `maxCausalDepth`. `hub.leaseMinutes`
  defaults to `30` and `hub.maxConversationTurns` to `32`.
- `hub.bindHost` wins over the older `hub.host`; the listen port defaults to
  `17321`.

Paths are expanded before use: the tokens `${REPO_ROOT}`, `${STATE_DIR}`,
`${USERPROFILE}` and `${LOCALAPPDATA}` are replaced first, then ordinary `%VAR%`
Windows variables such as `%USERPROFILE%` or `%PATH%` are expanded. Escape
Windows backslashes in JSON.

See [Agent bridges](./AGENT_BRIDGES.md) for exact Claude, Codex, Antigravity,
DeepSeek Harness and Hermes launch examples. A launch command alone is not
enough for an unknown agent: its bridge must request `collaboration_context`,
honor dispatch authorization, submit final actions and publish artifacts.

## Single-PC Compatibility And Node Roles

An existing manifest without `role` means `all`, preserving the original
single-PC startup behavior.

| Role | Runs the Hub | Starts local Agents | Use it for |
| --- | --- | --- | --- |
| `all` | yes | yes | One machine that is both the center and an execution node; the default |
| `hub` | yes | no | A machine that only coordinates |
| `worker` | no | yes | A second machine that connects to `hub.publicUrl` |

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
  },
  "agents": [
    {
      "id": "world",
      "displayName": "World",
      "aliases": ["codex"],
      "enabled": true,
      "launch": {
        "filePath": "node.exe",
        "arguments": ["C:\\feishu-local-agent-bridge\\dist\\cli.js", "run", "--profile", "world"],
        "workingDirectory": "C:\\workspaces\\world"
      }
    }
  ]
}
```

`id` is the Hub-side identity and the value `-Agent` takes, `displayName` and
`aliases` are what the Hub matches when resolving a delegation target, and
`launch` has to start a bridge that already speaks the Hub protocol. See
[Agent bridges](./AGENT_BRIDGES.md) for one manifest per engine.

Use a Tailscale, WireGuard, or enterprise VPN address. `bindHost` decides which
interfaces the Hub listens on, and `publicUrl` is the address the local bots use
to reach it. Each Agent gets its own 256-bit random credential, the main node
keeps them in `.runtime\agent-tokens.json`, and the Hub derives the caller's
identity from the credential, so an Agent cannot impersonate another by editing a
request body. See [Networking](./NETWORKING.md) for the transport, the security
boundary and the troubleshooting order.

Export a private starter manifest for a registered Agent:

```powershell
.\scripts\collab-pilot\Export-CollabWorkerConfig.ps1 `
  -Agent reviewer -HubUrl http://100.x.y.z:17321 `
  -OutputPath .\.runtime\worker-reviewer.local.json
```

The export contains one credential, forces `enabled` and `runOnThisNode` to
true, and replaces `nodeId` with a placeholder, so the target machine must set
its own node id. Transfer it privately, never commit it, and update
node-specific launch/profile/workspace paths before using `-Config`.
`config\collaboration-worker.example.json` shows environment-based credentials.
Exporting can only be done from a node whose role runs the Hub.

## Adapting Different Agents

Codex, Claude, Antigravity and DeepSeek Harness should run a bridge built from
the matching adapter in this repository, with the build output and the agent
executable written into `launch`. Each agent keeps its own model, reasoning
effort, speed and login state.

A new third-party agent needs an adapter that does four things:

1. ask the Hub for `collaboration_context` when a Feishu message arrives;
2. run only when the Hub authorizes the work and the message really
   @-mentions it;
3. write the final summary, delegations and completion state back to the Hub;
4. register and send files through the artifact protocol.

A launch command alone, with none of those four protocol pieces implemented,
does not give an agent correct sharing or isolation. Write the adapter against
`src/collab`, `src/agent` and `adapters/hermes`; after that the deployment
scripts need no changes and you only add one agent to the local manifest.

## Collaboration Group Allowlist

Each Agent's bridge profile maintains its own Feishu group allowlist. Hub task
authorization does not bypass this message-entry access control, so every agent
bridge that people or other agents will mention in the same collaboration group
(for example Codex, Antigravity, and DeepSeek Harness) must allow that group.

For first-time setup, the owner or an admin of **each bot** should mention that
bot in the target group and send `/invite group`; repeat this for World,
Justice, Chariot, and any other agent bridge. Group profiles commonly require a
real bot mention, so a bare `/invite group` is ignored.

If a bot says that the group is not in its response list, that bot's own
profile has not allowed the group; it is not a Hub, dispatch, or agent-login
failure. Alternatively, add the current `chat_id` to the `access.allowedChats`
array of that profile inside `profiles.<profile>` in the root `config.json`
(`<lark-channel-home>\config.json`), then restart only that agent:

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

## Agent Self-Delegation

Inside a collaboration task an Agent cannot delegate with a text `@` in its
reply. To ask a specialist for help or hand work over, the current owner uses
the command the pilot injects:

```powershell
collab-delegate.cmd ask --target justice --content "review the risks in this visual design"
collab-delegate.cmd handoff --target chariot --content "take over and finish the evidence package"
```

The command takes the task and the topic reply target from the current runtime
environment, writes an idempotent `ask` or `handoff` to the Hub first, then
sends a topic reply with a real Feishu mention as the current bot. The target
bridge consumes only the dispatch addressed to it. Every bridge registers its
own Feishu `open_id` with the Hub when it connects, so an Agent should use the
stable Hub Agent ID (`world`, `justice`, `chariot`) and nothing else: no
group-member lookups, no guessed open_ids, and no delegation through a bare
`lark-cli`.

## Network Boundary

Use `commonEnvironment` and `unsetEnvironment` for the direct baseline, then
override only the child agent that needs a proxy. Do not route the Hub or every
bot through a proxy because one model CLI requires it. When Antigravity uses
`agy.exe`, the pilot can derive the current Windows user proxy for that agent
while `LARK_CHANNEL_DISABLE_PROXY=1` keeps Feishu direct and `NO_PROXY` keeps
localhost Hub calls local. An explicit proxy already in the environment wins;
the pilot does not overwrite it.

Network setup must not install, reset or migrate agent authentication data.
Diagnose Hub health, bridge connectivity, CLI availability, proxy listener and
model endpoint separately; an upstream EOF or timeout is not itself proof of
expired authentication.

## Start, Status And Logs

For durable operation, install the current-user Windows logon task. It runs a
long-lived supervisor independently of the PowerShell, Codex, or ChatGPT window
that installed it. Without `-Agent`, one polling supervisor keeps the whole
pilot up:

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

That task runs `Run-CollabPilotSupervisor.ps1`, which calls
`Start-CollabPilot.ps1` every 15 seconds (`-PollSeconds`, 5–300) and starts any
component that exited, so the Hub and every local Bot come back together. It
holds a named mutex per repository-and-manifest pair, so a second copy exits
instead of competing. Pass `-Config` to either form to register the task against
a manifest other than `.runtime\pilot.local.json`.

With `-Agent <id>` the same command registers one event-driven task per agent:

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Agent sun -StartNow
```

That task runs `Run-CollabAgentSupervisor.ps1 -Agent sun`, the task name
defaults to `Lark Collaboration Agent sun`, and `-StartNow` stops only that
agent before the task starts it.

| | Whole-pilot supervisor | Per-agent supervisor |
| --- | --- | --- |
| Scope | Hub plus all local agents | exactly one agent |
| Wakes up | every 15 s (`-PollSeconds`) | only when it has something to do |
| Waits | fixed poll interval | blocks in `Wait-Process` while the bridge is alive |
| Before each start | clears only what `Start-CollabAgent` clears | also clears both of that agent's registrations |
| Single instance | named mutex | task's `-MultipleInstances IgnoreNew` |
| Log file | `.runtime\logs\supervisor.log` | `.runtime\logs\<agent>-supervisor.log` |

The per-agent supervisor never polls the bridge. It sleeps in four situations:
the Hub is unreachable (backoff starts at 10 s, then 20, 40 and 60 s, and resets
on the first successful probe), the Agent's credential is missing
(`-CredentialRetrySeconds`, default 60), the launcher exited (`-RestartSeconds`,
default 5), or the Agent is a Hermes gateway that detached from its launcher. A
detached gateway has no launcher PID left in `pids.json`, so its health is the
only thing that can be checked on a timer: `-GatewayCheckSeconds` (10 to 600,
default 60). Every other engine is fully event-driven. Before every start the
supervisor clears that agent's tracked launcher from `pids.json` and the bridge's
own registration under that agent's `LARK_CHANNEL_HOME`, so a hard-killed bridge
cannot leave a stale registration that blocks the next start.

Use the whole-pilot task on a single-PC `all` node, where the Hub and the agents
share one lifecycle. Use one per-agent task per Bot on a machine that runs
several agents, and on `worker` nodes, where each agent has its own manifest,
credential and journal and must not be restarted because a sibling failed. The
same machine can run one whole-pilot task or any number of per-agent tasks, but
not both for the same agent.

Each task uses the current user's interactive logon token, preserving that
user's Agent sessions, profiles, and proxy settings without storing another
password. It stores only absolute paths to the supervisor script and the
Git-ignored local manifest; it does not embed tokens, App Secrets, or manifest
contents. Remove the task and stop the Pilot with:

```powershell
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

Removal defaults to the whole-pilot task name. A per-agent task must be removed
by its own name, for example
`Uninstall-CollabPilotStartup.ps1 -TaskName 'Lark Collaboration Agent sun'`.
Installation accepts `-TaskName` as well, so you can register every agent's task
with a name you can recognize.

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

Status always prints `Hub health: True` or `Hub health: False` first, then one
record per component with `Name`, `PID`, `Running`, `Worker` and `LastError`.
`Running` is true when the tracked launcher is alive, or when a Hermes gateway
reports healthy after its own launcher exited (`Worker` then reads
`hermes-gateway (detached)`); otherwise `Worker` lists the child process names.
`LastError` shows the last lines of that component's `.err.log`. The log command
accepts `hub` or any enabled agent id and reads
`.runtime\logs\<name>.out.log` and `<name>.err.log`. Add `-Config` to any of
these commands when the machine uses a manifest other than
`.runtime\pilot.local.json`. Several clones or environments can keep separate
manifests that way:

```powershell
.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config C:\private\team-a.json
```

## Stop And Roll Back

```powershell
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent planner -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
```

Rollback invokes only commands explicitly present in the local manifest. It does
not delete the ledger or shared artifacts: a normal stop and rollback keep the
task artifacts, which may contain sensitive material. An Agent with no
`original.start` stays stopped and has to be started the way its owner normally
starts it. Hermes stop removes only `feishu-collaboration-hub` under the
configured hooks directory.

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
.runtime\local-topic-ledger\    per-Agent observed-topic journal
.runtime\logs\                  stdout and stderr
.runtime\pids.json              tracked launcher PIDs
```

The Hub-side files appear on a node whose role runs the Hub; a `worker` node
keeps its own manifest, logs and PIDs only. The observed-topic journal is
per-Agent and per-topic, one directory per agent:

```text
.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

A new topic starts a new file, a chat message outside any topic lands in
`_chat.jsonl`, and two agents on one machine never append to the same file. This
journal stays on the node that wrote it: it records what that bridge observed and
is not replicated to the Hub.

Supervisor repair events are written to `.runtime\logs\supervisor.log`, and each
per-agent supervisor appends to `.runtime\logs\<agent>-supervisor.log`.

A single-PC manifest can bind only to `127.0.0.1`. For workers, bind on the VPN
interface and use its private URL; use `0.0.0.0` only when several private
interfaces genuinely need to serve the Hub. Never commit tokens, worker exports,
App Secrets, profiles, or `pilot.local.json`.

## Acceptance Test

Start a new Feishu topic. Mention one agent to create and send a file, then
mention another agent to continue and modify it. The second agent receives the
objective through its own dispatch and can resolve the shared artifact on demand;
another topic must not see that context.

Status should show Hub health and one real worker process per enabled agent.
Use the component log when a bot does not reply. On a multi-machine deployment,
also check that a worker Bot picks up the same `taskId` and its own dispatch, that
reading with another Agent's credential is refused, that a Git artifact registers
a commit locator through `collab-artifact.cmd register-git`, and that a Feishu
file registers a Feishu locator once both `messageId` and `fileKey` are known. A
local path always means a cache on that one node.

Artifact publishing is self-healing for the current Bot's isolated lark-cli
workspace: an exact “lark-channel not bound” result triggers one `bot-only`
rebind and one delivery retry. It never falls back to another profile or user
identity. A repeated failure is reported with the exact command error and local
file path for diagnosis.
