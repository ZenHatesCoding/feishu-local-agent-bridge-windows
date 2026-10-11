# Windows Worker Deployment Recipe

[Back to README](../README.md) | [Back to WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.md) |
[中文](./WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
[Pitfalls](./WINDOWS_WORKER_PITFALLS.md)

Every command below is meant to be copied as it stands. Worked example: agent
`sun`, machine `my-worker-pc`, Hub at `http://100.x.y.z:17321`.

> Assumes the Hub already runs and you've been given:
> `HUB_URL`, `TENANT_KEY`, `AGENT_ID`, `AGENT_TOKEN`.
>
> Assumes the machine has **node**, **pnpm**, **git** on PATH (or in their
> install locations) and **network reachability to the Hub** (Tailscale or
> equivalent).

Below, `100.x.y.z` stands for the Hub's address, `<you>` for your Windows user
name, and `sun` / `moon` for agent ids. Substitute your own values; nothing else
in the commands changes.

---

## Phase 0 — Decide machine identity

Pick two values you will use everywhere below:

| Name         | Example       | Used for                                                   |
| ------------ | ------------- | ---------------------------------------------------------- |
| `NODE_ID`    | `my-worker-pc` | `nodeId` in manifest, `LARK_COLLAB_NODE_ID` env, Hub logs. |
| `AGENT_ID`   | `sun`         | `agents[].id`, `credentialEnv` suffix, task name suffix.   |

The `AGENT_ID` is **per agent** (each agent on a multi-agent machine gets a
distinct one). The `NODE_ID` is **per machine** (same value across all agents
on the box). A missing `nodeId` falls back to `[Environment]::MachineName`, so
set it explicitly whenever the machine name is not what you want to see in the
Hub's client list.

---

## Phase 1 — Clone + build

```powershell
git clone --branch release/worker --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
Set-Location C:\feishu-local-agent-bridge
pnpm install        # also runs the build (tsup)
```

If `pnpm` isn't on PATH yet, install once:

```powershell
# Optional — skip if pnpm already on PATH
npm install -g pnpm@10.33.0
```

---

## Phase 2 — Node on PATH for PowerShell

If Node is not at the default install location (`C:\Program Files\nodejs\…`),
write the absolute path into the worker config later. The `pnpm install` step
above already triggered `tsup`, so `dist/cli.js` exists.

---

## Phase 3 — Bring up the Feishu app + profile (one-time)

If this agent does **not** yet have a Feishu app / profile on this machine,
follow the standard `profile create` flow on the *main* PC (the Hub) and
copy the resulting `~/.lark-channel/` over to this worker box. Then:

```powershell
# Sanity-check that the profile bootstrapped correctly
Test-Path C:\Users\<you>\.lark-channel\profiles\<profile>\secrets.enc   # True
Get-Content C:\Users\<you>\.lark-channel\active-profile                 # <profile name>
```

If `secrets.enc` is missing, the profile is not usable here. Re-do the QR /
app-secret bind on this box.

---

## Phase 4 — Worker manifest

Create `.runtime\worker-<AGENT_ID>.local.json`. The repo already ignores
`.runtime/`, so this file stays local, and it is **per agent** (one manifest per
agent, never copied between machines). In the normal flow you do not hand-write
it. On the Hub, `Export-CollabWorkerConfig.ps1 -Agent <id> -HubUrl <url>` writes
a ready-made one with your agent's id, display name, aliases and launch command,
a placeholder `nodeId`, the Hub's `publicUrl`/`tenantKey`, and the credential
inline as `credential`. Copy that file to this machine and edit it here.

```json
{
  "schemaVersion": 2,
  "role": "worker",
  "nodeId": "my-worker-pc",
  "hub": {
    "publicUrl": "http://100.x.y.z:17321",
    "tenantKey": "<TENANT_KEY>"
  },
  "larkCliJs": "",
  "commonEnvironment": {
    "LARK_CHANNEL_DISABLE_PROXY": "1"
  },
  "unsetEnvironment": [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY"
  ],
  "agents": [
    {
      "id": "sun",
      "displayName": "Sun",
      "aliases": ["cc", "claude"],
      "enabled": true,
      "credentialEnv": "LARK_COLLAB_SUN_TOKEN",
      "launch": {
        "filePath": "C:\\node-v22.10.0-win-x64\\node.exe",
        "arguments": [
          "C:\\feishu-local-agent-bridge\\dist\\cli.js",
          "run",
          "--profile",
          "claude",
          "--agent",
          "claude",
          "--workspace",
          "C:/workspaces/claude"
        ],
        "workingDirectory": "C:/workspaces/claude",
        "environment": {
          "LARK_CHANNEL_HOME": "C:\\Users\\<you>\\.lark-channel"
        }
      }
    }
  ]
}
```

Things to change:

- `nodeId` / `agents[].id` / `agents[].launch.filePath` / `--workspace` /
  `LARK_CHANNEL_HOME`: match your machine.
- `hub.publicUrl` / `hub.tenantKey`: given to you by whoever runs the Hub.
- `agents[].credentialEnv`: must end with your agent id; pick a name that
  matches `LARK_COLLAB_<AGENT_ID>_TOKEN`.
- `larkCliJs`: leave `""` unless you need to pin a specific install. The
  worker launcher auto-resolves the real `@larksuite/cli` JavaScript entry
  (next to the launcher's `node.exe`, then the npm global root, then
  `%APPDATA%\npm`) and exports it as `LARK_COLLAB_REAL_LARK_CLI_JS`. That keeps
  the pilot `bin` `lark-cli` shims working and prevents a false "lark-cli is
  not installed" result from the bridge pre-flight, which otherwise blocks
  Feishu delivery (collaboration handoffs, artifact publish).

### Manifest fields

`schemaVersion` must be `2`; any other value refuses to load. The table below is
the real field set of a manifest: the top level, the `hub` block and one
`agents[]` entry.

| Field                  | Required                | Behaviour, and what happens when omitted                                                    |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `schemaVersion`        | yes                     | Must be `2`, otherwise `Unsupported pilot config schemaVersion.`                             |
| `role`                 | no                      | `all` (default), `hub` or `worker`. Omitted → `all`, which runs a local Hub *and* agents.     |
| `nodeId`               | no                      | This node's name. Omitted → `[Environment]::MachineName`.                                     |
| `larkCliJs`            | no                      | Explicit real lark-cli JS entry. Omitted or `""` → auto-resolve (see above).                  |
| `commonEnvironment`    | no                      | Name→value map applied to every agent process before the agent's own `launch.environment`.    |
| `unsetEnvironment`     | no                      | Array of variable names removed from the agent environment before that map is applied.       |
| `agents`               | yes (≥1 enabled)        | The roster. At least one enabled agent must exist.                                            |
| `hub.publicUrl`        | yes on a worker         | Hub base URL; trailing `/` is trimmed. Without it a worker refuses to start.                  |
| `hub.tenantKey`        | yes on a worker         | Shared tenant key. Falls back to `.runtime\tenant-key.txt`; otherwise the start fails.        |
| `hub.bindHost` / `hub.host` / `hub.port` | hub/`all` only | Where a *local* Hub listens (default `127.0.0.1:17321`). Ignored on a worker.                  |
| `hub.leaseMinutes` / `hub.maxCausalDepth` / `hub.maxConversationTurns` | hub/`all` only | Hub-side limits copied into the generated `hub-config.json`. Not read on a worker. |
| `agents[].id`          | yes                     | The agent id used by the Hub, task names, log stems and the journal directory.                |
| `agents[].displayName` | yes                     | Human name registered with the Hub.                                                           |
| `agents[].aliases`     | no                      | Extra names the Hub accepts when resolving an @-mention. Omitted → none.                      |
| `agents[].enabled`     | no                      | Omitted → enabled. `false` keeps the agent out of every start, stop and validation path.      |
| `agents[].runOnThisNode` | no                    | Omitted → runs here. `false` suppresses the local launch. On a node that runs a Hub it also keeps the agent in the generated `hub-config.json`; on a worker there is no local Hub state, so the field only means "do not start it here". |
| `agents[].credentialEnv` | recommended           | Name of the environment variable holding this agent's Hub credential.                          |
| `agents[].credential`  | no                      | Inline plaintext credential, used when `credentialEnv` is absent from the manifest. If `credentialEnv` *is* named but the variable is empty, the start fails with `Credential environment variable is not set: <name>`; there is no fallback to `credential` or `agent-tokens.json`. |
| `agents[].launch.filePath` | yes                 | Executable to run (for example `node.exe`). Must exist, or resolve on PATH.                    |
| `agents[].launch.arguments` | no                  | Argument array; `${REPO_ROOT}`, `${STATE_DIR}`, `${USERPROFILE}`, `${LOCALAPPDATA}` and `%VAR%` tokens are expanded. |
| `agents[].launch.workingDirectory` | no             | Defaults to the repository root. Must exist when set.                                          |
| `agents[].launch.environment` | no                | Per-agent environment; applied after `commonEnvironment` and wins over it.                     |
| `agents[].launch.unsetEnvironment` | no            | Per-agent removals, applied last.                                                              |
| `agents[].original.stop` / `original.start` | no      | Commands run before the pilot takes over and when it hands the profile back.                   |
| `agents[].hermesHook.enabled` / `hermesHook.home` | no | Hermes gateway integration; `home` is required when `enabled` is true.                       |

On this node only two fields are about the Hub rather than the machine:
`hub.publicUrl` and `hub.tenantKey`. Everything else is worker-side.

The four value tokens above are substituted in `filePath`, `arguments`,
`workingDirectory` and every environment value. On a worker, the environment is
otherwise *cleared* before launch: the launcher removes a fixed list of inherited
routing and profile variables (`LARK_CHANNEL`, `LARK_CHANNEL_UNATTENDED`,
`LARK_CHANNEL_HOME`, `LARK_CHANNEL_PROFILE`, `LARK_CHANNEL_CONFIG`,
`LARKSUITE_CLI_CONFIG_DIR`, `LARK_CHANNEL_CODEX_BIN`, `LARK_CHANNEL_NODE_BIN`,
`LARK_CHANNEL_ANTIGRAVITY_BIN`, `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`,
`LARK_CHANNEL_ANTIGRAVITY_BRIDGE`, `LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE`,
`DSH_CWD`), then applies `unsetEnvironment`, `commonEnvironment` and finally
`launch.environment`. Variables outside that list survive, so a worker does not
inherit another agent's profile even though settings such as
`LARK_CHANNEL_DISABLE_PROXY` and `LARK_CHANNEL_LOG_DAYS` are left alone.

### Where the credential comes from

The launcher resolves one credential per agent, in this order:

1. `credentialEnv`, read at **Process** scope;
2. an inline `credential`;
3. this node's `.runtime\agent-tokens.json`, if it exists (Hub-side state).

Both entry points that start an agent, `Start-CollabAgent.ps1` and
`Run-CollabAgentSupervisor.ps1`, first lift the value from **User** scope into
Process scope when the variable is set at User level and empty in the current
process, so an interactive start behaves exactly like a Task Scheduler start.
Machine scope is never read. That is what Phase 5 is for: keep the token
at User scope, point `credentialEnv` at it, and never leave a plaintext
`credential` in the manifest.

### Validate

```powershell
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1 `
  -Config .\.runtime\worker-sun.local.json
```

It checks:

- at least one enabled agent exists, else `No enabled agents are configured.`;
- `dist\cli.js` exists (only when this node also runs a Hub);
- a worker has `hub.publicUrl`, else `Worker role requires hub.publicUrl.`;
- for every local agent: `id` and `displayName` are set, `launch.filePath` is
  set and the resolved executable exists (or is on PATH),
  `launch.workingDirectory` exists when present, and `hermesHook.home` exists
  when the hook is enabled.

On success it prints four lines:

```
Config OK: <absolute path to your manifest>
Role: worker
Enabled agents: sun
Hub: http://100.x.y.z:17321
```

On any problem it prints each error through `Write-Error` and exits with code 1.

---

## Phase 5 — Persist the Hub token at User level

```powershell
[Environment]::SetEnvironmentVariable(
  'LARK_COLLAB_SUN_TOKEN',
  '<paste your AGENT_TOKEN here>',
  'User'
)
# Confirm
[Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User').Length
# Should print a positive number
```

User-level env vars **persist across reboots** and are inherited by both Task
Scheduler tasks and interactive PowerShell sessions. A new value is only visible
to processes started afterwards, so open a fresh PowerShell before smoke-testing.

If the worker manifest you were handed still carries an inline `credential`,
delete that line once the User-scope variable is in place; the environment
variable takes precedence, and the plaintext copy is a second place to leak
from. See [`WINDOWS_WORKER_PITFALLS.md`](./WINDOWS_WORKER_PITFALLS.md) §5 for
the Process-vs-User trap in detail.

---

## Phase 6 — Manual start (smoke test)

```powershell
.\scripts\collab-pilot\Start-CollabAgent.ps1 `
  -Agent sun `
  -Config .\.runtime\worker-sun.local.json
```

Expected:

```
sun started in background (PID …).
Hub health: True
…
```

`started in background` is printed only by an actual start. An already-running
agent gives `sun is already running (PID …).` instead. Either way you get the
same status block afterwards, because `Start-CollabAgent.ps1` ends by calling
the status script for that one agent:

```
Hub health: True
Name  PID   Running Worker   LastError
----  ---   ------- ------   ---------
sun   12345     True node.exe
```

`Running = True` means the tracked launcher process is alive (or, for a Hermes
agent, that its detached gateway answers).

From any machine with Hub reachability, verify Sun is registered with the
correct `nodeId`:

```powershell
$token = [Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User')
$h = [System.Net.Http.HttpClientHandler]::new(); $h.UseProxy = $false
$c = [System.Net.Http.HttpClient]::new($h); $c.Timeout = [TimeSpan]::FromSeconds(5)
$c.DefaultRequestHeaders.Add('Authorization', "Bearer $token")
($c.GetAsync('http://100.x.y.z:17321/v1/agents').GetAwaiter().GetResult()
  .Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).agents |
  Where-Object id -eq 'sun' |
  Format-List id,nodeId,instanceId,lastSeenAt
```

---

## Phase 7 — Smoke test in Feishu

Three things must line up before a group message reaches this agent:

1. The Feishu app must hold the group-message scope
   `im:message.group_msg`. Without it the platform only pushes messages that
   @-mention the bot, and non-@ traffic never arrives at all.
2. Keeping `requireMentionInGroup: true` (the default) is a *second, independent*
   switch: the app sees all group traffic, and the bridge still answers only
   messages that @-mention it. Non-@ messages are journaled, not answered.
3. The group must be in **this agent's** `access.allowedChats`. The app owner or
   an admin opens it from inside the group with `/invite group` (or
   `/invite all group`), or you add the `chat_id` to that profile's
   `access.allowedChats` and restart that one agent.

Then, in the **Hub owner's** group, open a topic (long-press a message → "Reply
in topic") and `@Sun ping`. Sun should reply.

If it does not reply, do not duplicate the diagnosis here: see
[`WINDOWS_WORKER_PITFALLS.md`](./WINDOWS_WORKER_PITFALLS.md) §7–§8 for the
credential profile check and the topic-root rule, §15 for the scope, and §16 for
the `denied-chat` log line that means the *chat* is not on this agent's list.

---

## Phase 8 — Auto-start at logon

The two shapes are not interchangeable.

**Whole-pilot task** (a single agent, or you want one task that repairs Hub +
agents):

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -StartNow
```

This registers the Task Scheduler entry `Lark Collaboration Pilot` with:

- Trigger: `AtLogon` for the current user (interactive logon).
- Action: `Run-CollabPilotSupervisor.ps1` which keeps `Start-CollabPilot`
  alive on a poll loop (15s default, `-PollSeconds` 5–300) and restarts it on
  exit. A named mutex keeps one supervisor per repo+manifest pair.
- Settings: `StartWhenAvailable`, restart on failure ×3 / 1min, no battery
  stop, no execution-time limit.
- `-StartNow` stops the pilot, then starts the task, so nothing is left running
  outside the task.

**Per-agent task** (recommended when one machine hosts several agents):

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -Agent sun `
  -StartNow
```

Without `-TaskName` the task is named `Lark Collaboration Agent sun`; pass
`-TaskName SunFeishuBridge` if you prefer a stable, readable name. Same triggers
and settings, but the action becomes `Run-CollabAgentSupervisor.ps1 -Agent sun`,
which:

- is **event-driven**: it blocks in `Wait-Process` while the bridge is healthy
  (no 15s wake-ups), and normally wakes only to wait for the remote Hub
  (`-CredentialRetrySeconds`, default 60), a missing credential, or the launcher
  exiting (`-RestartSeconds`, default 5). The exception is a Hermes gateway that
  detached from its launcher: it has no launcher PID to wait on, so the
  supervisor re-checks it on `-GatewayCheckSeconds` (10 to 600, default 60);
- clears **both** registrations for that agent before every start
  (`Stop-CollabComponent` for the tracked launcher tree,
  `Stop-CollabRegisteredBridge` for the bridge's own registry resolved under
  that agent's `LARK_CHANNEL_HOME`), so a hard-killed bridge can never leave a
  stale registration that blocks the next start;
- touches only its own agent: `-StartNow` stops that agent, not the whole
  pilot.

One caveat when several per-agent tasks start at the same logon: registering a
per-agent task calls `Stop-CollabAgent.ps1` once to clear that agent's
registration, so two tasks that start in the same second serialize and one of
them waits. It converges within a few seconds and does not need intervention.

Verify what was actually registered:

```powershell
Get-ScheduledTask -TaskName 'Lark Collaboration Agent sun' | Format-List TaskName,State
# whole-pilot task instead:
Get-ScheduledTask -TaskName 'Lark Collaboration Pilot' | Format-List TaskName,State
```

After a reboot, the supervisor will relaunch on next sign-on.

The supervisor writes its own log, which is where you look when a task is
registered but the agent never comes up: `.runtime\logs\supervisor.log` for the
whole-pilot task, `.runtime\logs\<agentId>-supervisor.log` for a per-agent task.
It records each start, each Hub probe failure and each credential wait.

To uninstall:

```powershell
# per-agent task (name it if you passed -TaskName)
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1 -TaskName 'Lark Collaboration Agent sun'
# whole-pilot task
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

Uninstalling removes only the scheduled task by default and then stops the whole
pilot; add `-KeepPilotRunning` when you mean "drop the logon task, leave the
agents up".

---

## Where the local journal lives

Every bridge keeps an append-only journal of what *it* observed (group
messages, downloaded attachments, its own bot results). It is never replicated
to the Hub, so the paths in it are meaningful only on this machine:

```
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

- one root per agent, so two agents on one machine behave exactly like two
  machines and never append to the same file;
- one file per topic: a new topic starts a new file instead of growing a single
  ever-longer ledger, and a chat message outside any topic lands in
  `_chat.jsonl`;
- `run-agent.ps1` points this agent's process at its own root through
  `LARK_COLLAB_NODE_LEDGER_ROOT` (the name is historical; the value is
  per-agent);
- the record format is one JSON object per line with `id`, `scope`,
  `recordedAt`, `kind` (`message`, `attachment` or `bot-result`) and the
  payload; duplicates are suppressed by record id.

### Reading it back

The agent (and you) query the local journal with the bridge CLI, not the Hub:

```powershell
# latest records for one chat or topic (default limit 12, maximum 50)
node .\dist\cli.js local-context read --scope "<chatId>" --limit 20
node .\dist\cli.js local-context read --scope "<chatId>:<threadId>"

# keyword search; every word must appear somewhere in the record
node .\dist\cli.js local-context search --scope "<chatId>:<threadId>" --query "<keywords>"
```

`--scope` is required and must be exactly the id the record was written under:
`chatId` for chat-level messages, `chatId:threadId` for a topic. `--limit` is
clamped to 1–50 (default 12), and the command prints
`{"scope": …, "records": […]}` as JSON. Inside an agent run the same command is
on PATH as `lark-channel-bridge`, so the prompt's
`lark-channel-bridge local-context search --scope … --query …` works with no
path. A query merges the legacy single-file journal and the per-topic file and
returns the newest records by `recordedAt`.

### Migrating a node that predates `topics/`

The pre-`topics/` layout (`<root>\collaboration\local-topic-ledger.jsonl`) is
still **read**, so an in-place upgrade keeps its history; new records are never
written there. A read or search for a scope therefore still returns that scope's
old records, but the legacy file stays one big file, and a scope you never query
never shows up in the per-topic layout.

To finish the migration without losing history: stop the per-agent tasks for
this machine, group the legacy file's records by their `scope` field, append
each group to `<root>\collaboration\topics\<chatId>\<threadId>.jsonl` (or
`_chat.jsonl` when the scope has no topic part), de-duplicate by record `id`,
then archive the legacy file. Do it per agent root, and never merge two agents'
records into one file. See
[`WINDOWS_WORKER_PITFALLS.md`](./WINDOWS_WORKER_PITFALLS.md) §13 for the same
procedure with the stopping commands.

---

## Daily commands

| Want to…                | Run                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Start everything        | `.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`      |
| Stop everything         | `.\scripts\collab-pilot\Stop-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`       |
| Start only Sun          | `.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent sun -Config …`                          |
| Stop only Sun           | `.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun -Config …`                           |
| Live status             | `.\scripts\collab-pilot\Status-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`     |
| Tail logs               | `Get-Content .\.runtime\logs\sun.out.log -Wait`                                              |
| Tail stdout + stderr    | `.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name sun -Tail 80 -Follow`                   |
| Re-register at logon    | `.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config … -StartNow`                  |
| Drop the scheduled task | `.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1`                                    |
| Export another worker manifest (Hub only) | `.\scripts\collab-pilot\Export-CollabWorkerConfig.ps1 -Agent moon -HubUrl http://100.x.y.z:17321` |

`Stop-CollabAgent.ps1` and `Stop-CollabPilot.ps1` also accept
`-RestoreOriginal` / `-RestoreOriginals`, which run the agent's configured
`original.start` command after the collaboration bridge stops, which is the way
back to a pre-pilot setup.

---

## Multi-agent on one machine

Each agent on the same machine gets its own `worker-<id>.local.json`, its own
scheduled task (`-Agent <id>`), its own User-level env var
(`LARK_COLLAB_<id>_TOKEN`), its own `credentialEnv` pointer, its own
`LARK_CHANNEL_HOME` (when they do not share a profile root) and its own journal
root under `.runtime\local-topic-ledger\<id>\`.

Treat the agents as if they were on separate machines: nothing about their
runtime state is shared, only the Hub is. A sibling agent going down, being
stopped, or being reconfigured must not affect this one.

```powershell
# per-agent tasks, each one independent
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config .\.runtime\worker-sun.local.json  -Agent sun  -StartNow
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config .\.runtime\worker-moon.local.json -Agent moon -StartNow
```

`Install-CollabPilotStartup.ps1 -Agent …` names the task
`Lark Collaboration Agent <id>` when you do not pass `-TaskName`. The whole-pilot
task is the wrong tool here: it runs `Stop-CollabPilot.ps1` on `-StartNow` and
drives the pilot as a unit, so a second whole-pilot task would fight the first.
