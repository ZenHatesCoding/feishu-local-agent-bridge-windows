# Collaboration Pilot Scripts

[Project README](../../README.md) | [中文](./README.zh-CN.md) |
[Windows operations](../../docs/WINDOWS_OPERATIONS.md) |
[Windows worker deployment](../../docs/WINDOWS_WORKER_DEPLOYMENT.md) |
[Concepts](../../docs/COLLABORATION_CONCEPTS.md) |
[Networking](../../docs/NETWORKING.md) |
[Distributed roadmap](../../docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

These scripts connect any configured number of local agent bridges to one
Feishu collaboration Hub, and manage background processes, logs, context and
artifact delivery. Agent names and paths come from the Git-ignored
`.runtime\pilot.local.json`, not repository hard-coding.

With the default `role: "all"`, one Windows computer still manages the Hub and
its local Agents. A `worker` role connects to the central Hub and a `hub` role
is center-only; a worker never starts another Hub.

## Setup To Rollback

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

Setup copies `config\collaboration-pilot.example.json` to the manifest, and can
also run `pnpm install`/`pnpm build`. Validation is offline: it checks paths and
required fields, and does not connect Feishu, stop bridges or install Hermes.
Pass `-Config` to point a script at a manifest other than the default
`.runtime\pilot.local.json`.

## Supervisors

`Install-CollabPilotStartup.ps1` registers a current-user logon task, so the Hub
and Bots do not depend on a PowerShell, Codex, or ChatGPT window. There are two
shapes, and they are not interchangeable:

- **Whole pilot** (the default): runs `Run-CollabPilotSupervisor.ps1`, which
  calls `Start-CollabPilot.ps1` every 15 seconds (`-PollSeconds` 5–300) and
  brings the Hub and every local agent back together.
- **Per agent** (`-Agent <id>`): runs
  `Run-CollabAgentSupervisor.ps1 -Agent <id>`, which is event-driven. It blocks
  while the bridge is healthy, and wakes only for the Hub, for that agent's
  credential, or for its launcher to exit. Use one per-agent task per Bot on a
  machine that runs several agents, and on `worker` nodes, where each agent has
  its own manifest, credential and journal.

```powershell
# one logon task for the whole pilot
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow

# one event-driven task per agent; without -TaskName it is "Lark Collaboration Agent <id>"
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Agent sun -TaskName SunFeishuBridge -StartNow

# status and logs
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Status-CollabPilot.ps1 -Agent sun
.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name sun -Tail 200

# rollback
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun
.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun -RestoreOriginal
.\scripts\collab-pilot\Stop-CollabPilot.ps1 -RestoreOriginals
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

`Start-CollabPilot.ps1` and `Start-CollabAgent.ps1 -Agent <id>` remain useful
for temporary runs and development, but their hidden child processes are not the
durable cross-terminal lifecycle contract. `Uninstall-CollabPilotStartup.ps1`
defaults to the whole-pilot task name, so a per-agent task must be removed with
its own `-TaskName`.

The logon startup path also installs the named Hermes collaboration Hook before
starting its detached gateway. A detached Hermes gateway is healthy even though
its short-lived launcher has exited, so Pilot keeps the Hook in place and
reports the gateway separately instead of treating that exit as a failed Bot
start.

Each agent writes its own local journal, one root per agent and one file per
topic:

```text
.runtime\local-topic-ledger\<agent>\collaboration\topics\<chatId>\<threadId>.jsonl
.runtime\local-topic-ledger\<agent>\collaboration\topics\<chatId>\_chat.jsonl
```

Two agents on one machine therefore behave exactly like two machines. The
per-agent worker recipe in
[Windows worker deployment](../../docs/WINDOWS_WORKER_DEPLOYMENT.md) covers the
worker manifest, credential, per-agent task and journal in full.
[Windows operations](../../docs/WINDOWS_OPERATIONS.md) documents every manifest
field, status column and rollback command.

The repository supplies the Hub and orchestration. Users supply installed and
logged-in agents, Feishu apps/profiles and real launch commands.

When Antigravity uses `agy.exe`, the launcher reads the current Windows user
proxy and passes it only to Antigravity. The Feishu connection remains direct
through `LARK_CHANNEL_DISABLE_PROXY=1`. If Feishu reports `Authentication
required` while the desktop client is already logged in, verify that the
Windows proxy is running and restart only that agent.
