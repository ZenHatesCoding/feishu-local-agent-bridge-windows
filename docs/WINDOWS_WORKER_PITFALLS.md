# Windows Worker Pitfalls (Real-World Hit List)

[Back to README](../README.md) | [Back to WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.md) |
[中文](./WINDOWS_WORKER_PITFALLS.zh-CN.md)

These are the failures we actually hit bringing up a Windows worker: a two-agent
box, Sun on Claude Code and Moon on DeepSeek Harness, joined to a remote Hub.
Each item names the fix that already landed in the pilot scripts, so the next
machine can skip the rerun.

> Conventions used below: `paths` assume the repo lives at
> `C:\feishu-local-agent-bridge`. PowerShell is Windows PowerShell 5.1 unless
> noted. Hub addresses are written `100.x.y.z`, so substitute your own.

---

## 1. `node.exe` is not on the PowerShell PATH

Symptom:

```
Stop-CollabAgent.ps1 : 无法将node.exe识别为 cmdlet、函数、脚本文件或可运行程序的名称。
```

`pnpm install` puts Node into whatever folder the user unzipped it to. The
start-side scripts are fine: they take the path from the manifest. The
**stop-side** scripts call bare `node.exe` and rely on PATH. The
`Scheduled Task` action hits the same trap, because a fresh PowerShell session
can inherit a different PATH than the user shell.

Fix (already in `Pilot.Common.ps1::Stop-CollabRegisteredBridge`):

- Read `agents[*].launch.filePath` from the manifest; if that path exists, use
  it, relative or absolute alike. Otherwise fall back to
  `(Get-Command node.exe -ErrorAction SilentlyContinue).Source`.
- If neither resolves, log a warning and skip the in-bridge kill. The
  wrapper-PID stop is still a safe fallback.

For the start side, prefer an **absolute** `launch.filePath` in the worker
config, e.g.

```json
"launch": {
  "filePath": "C:\\node-v22.10.0-win-x64\\node.exe",
  ...
}
```

Bash-side PATH edits (`/c/node-v22.10.0-win-x64:...` in `.bashrc`) **do not**
propagate to `Start-Process` children.

---

## 2. `Test-CollabHubHealth` throws `TypeNotFound` for `[Net.Http.HttpClient]`

Symptom on Windows PowerShell 5.1:

```
Test-CollabHubHealth: cannot find type [Net.Http.HttpClientHandler]
```

`System.Net.Http` is a .NET Standard assembly that Windows PowerShell 5.1 does
not pre-load. PowerShell 7+ auto-loads it; 5.1 needs an explicit `Add-Type`.

Fix (already in `Pilot.Common.ps1::Test-CollabHubHealth`):

```powershell
if (-not ('System.Net.Http.HttpClientHandler' -as [type])) {
  try { Add-Type -AssemblyName 'System.Net.Http' } catch { }
}
```

`Pilot.Common.ps1` also probes for `System.Net.Http.HttpClient` when it is
dot-sourced, so any script that so much as loads the library gets the assembly
before it needs it. The function retries 3× with a 1 s gap between attempts (see
pitfall #3).

---

## 3. Hub `/health` is intermittent from this machine

Symptom: `Start-CollabAgent.ps1` throws `Remote Hub is unavailable: …`
sometimes, but the same Hub answers 5/5 from `Invoke-WebRequest` in a fresh
shell. A short timeout masks real, brief TCP blips.

Fix (already in `Pilot.Common.ps1::Test-CollabHubHealth`):

- `for ($attempt = 1; $attempt -le 3; $attempt++)`: three attempts, `Start-Sleep
  -Seconds 1` after a failed attempt.
- Every attempt builds a **fresh** `HttpClientHandler` with `UseProxy = $false`
  and a fresh `HttpClient`, so a stale `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`
  cannot break a loopback probe.
- Return `true` on the first body whose `ok` field is truthy.

The per-request timeout is the caller's `-TimeoutSeconds`. The function
parameter defaults to 5 s; the callers pass 1 s (Hub startup poll), 2 s
(status) or 3 s (start/supervisor hub gate). If the Hub is on Tailscale, do
**not** lower those numbers: Tailscale NAT re-establishment can briefly stall a
connection after an interactive wake-up.

---

## 4. `LARK_CHANNEL_HOME` must point at the actual profile root

Symptom:

```
Error: 当前没有配置，非交互模式无法完成扫码创建应用。
```

`resolveAppPaths().rootDir` defaults to `C:\Users\<you>\.lark-channel`. If you
override `LARK_CHANNEL_HOME` in the worker config, **the new value must exist
and have** `profiles/<name>/` under it. Pointing `LARK_CHANNEL_HOME` at an
empty directory (e.g. `C:\feishu-profiles\claude`) throws the error quoted
above during bootstrap, because no profile is found there.

How to check:

```powershell
Test-Path C:\Users\<you>\.lark-channel\profiles\claude\secrets.enc   # must be True
Get-Content C:\Users\<you>\.lark-channel\active-profile               # 'claude'
```

Fix in this bring-up: set `launch.environment.LARK_CHANNEL_HOME` to
`C:\Users\<you>\.lark-channel` (i.e. the **real** default) in
`.runtime\worker-<agent>.local.json`. Or omit it and let the bridge default.

---

## 5. `credentialEnv` is read at `Process` scope, not `User`

`Pilot.Common.ps1::Get-CollabAgentToken` reads:

```powershell
[Environment]::GetEnvironmentVariable([string]$Agent.credentialEnv, 'Process')
```

`setx LARK_COLLAB_<agent>_TOKEN <value>` writes the var at **User** scope.
A fresh PowerShell process loads User-level vars into its process env block on
startup, so Task Scheduler / `Start-Process` children inherit them in `Process`
scope. But a *standalone* `powershell.exe -File Start-CollabAgent.ps1`
launched from a clean shell sometimes sees `Process` empty, because some
shells drop registry-derived env vars.

Fix (already in `Start-CollabAgent.ps1`, with the same helper in
`Run-CollabAgentSupervisor.ps1::Import-CredentialFromUserScope`):

```powershell
if ($agentConfig.credentialEnv -and -not [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'Process')) {
  $userValue = [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'User')
  if ($userValue) {
    [Environment]::SetEnvironmentVariable($agentConfig.credentialEnv, $userValue, 'Process')
  }
}
```

Manual starts and scheduled-task starts now behave identically. Neither lift
reads Machine scope, and `Get-CollabAgentToken` never falls back to User scope
itself: if the lift did not run, the credential simply is not there. The
supervisor's credential gate asks `Get-CollabAgentToken` rather than looking at
`credentialEnv` alone, so the inline `credential` and `agent-tokens.json`
sources count too, and it only waits when every source is empty.

---

## 6. Profile-lock contention between concurrent bridges

Symptom:

```
当前 profile 已有 bridge 进程占用；非交互模式无法确认停止，请先用 lark-channel-bridge ps
查看并用 lark-channel-bridge kill <bot id> 停止后重试
```

A profile (or app) lock is still held, usually by a bridge whose previous stop
was half-cleaned. The next start refuses instead of hanging.

How to recover:

```powershell
# The registry is per LARK_CHANNEL_HOME: inspect the home the agent actually
# uses, or the list will be empty even while its bridge is running.
$env:LARK_CHANNEL_HOME = 'C:\Users\<you>\.lark-channel'
node C:\feishu-local-agent-bridge\dist\cli.js ps

# Kill by the short id printed in the ID column
node C:\feishu-local-agent-bridge\dist\cli.js kill <id>
```

The supported path is still the pilot script, which resolves the right home for
you: `Stop-CollabAgent.ps1 -Agent <id>`. Or belt-and-suspenders:

```powershell
Get-CimInstance Win32_Process -Filter 'Name="node.exe"' |
  Where-Object { $_.CommandLine -like '*dist\cli.js*' -and $_.CommandLine -like '*--profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Always stop before switching `LARK_CHANNEL_HOME` or running multiple agents
that share a profile name.

---

## 7. Feishu App credential must be validated before `lark-cli` bind

Symptom:

```
lark-cli is not installed
lark-cli is the Feishu/Lark command-line tool. After installation, the agent can…
(non-interactive mode; skipping auto-install)
```

Non-fatal warning, not an error. Two implications:

1. Without `lark-cli` on PATH, **the bot cannot read message history, send
   attachments, or list chat participants**. An `@Sun` mention in a topic then
   only works if the message directly @-mentions Sun. Hub-mediated delegation is
   hit too. It submits over the Hub REST endpoint, but the shims a model calls
   need lark-cli: `collab-delegate.cmd reply|handoff|ask` requires
   `LARK_COLLAB_REAL_LARK_CLI_JS` and posts the real @-mention through lark-cli,
   and `collab-artifact.cmd publish` requires it as well. Only the
   bridge-internal marker path is lark-cli-free: the model emits a
   `collaboration_reply`, `collaboration_ask` or `collaboration_handoff` marker
   and the bridge renders the mention itself.
2. `npm install -g @larksuite/cli` may partially fail on Windows when an
   installer tries to `rmdir` an in-use directory. Re-run after closing any
   Trae / Cursor / VS Code that holds the dir open. Or use `--force`.

Check before blaming the engine: `run-agent.ps1` exports
`LARK_COLLAB_REAL_LARK_CLI_JS` to the real entry and puts the pilot `bin`
directory first on `PATH`, so the shim can resolve it. If the warning appears
anyway, the auto-resolve found nothing. See the `pilot.larkCliJs` guidance in
[WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.md).

---

## 8. `@Sun` in the **root** of a chat is dropped

Worker-mode collaboration features (`/v1/agents`, `submit`, dispatch) only
kick in when the message arrives in a Feishu **topic** (`omt_…` threadId).
Plain root-chat `@Sun` falls through to the bridge's local-only handling; that
replies fine, but it doesn't exercise Hub dispatch.

For an end-to-end smoke test, always:

1. Open the chat.
2. Long-press a message → "Reply in topic".
3. `@Sun <prompt>` inside the topic.

---

## 9. Hub `/workers` returns 401 without worker auth

Symptom:

```
Invoke-WebRequest http://100.x.y.z:17321/workers
401 Unauthorized
```

There is no `/workers` route. The Hub answers `GET /health` without auth, then
401 for everything else without a token, then 404 for an unknown path. The
endpoint that matters is `/v1/agents` (the identities the Hub has actually
registered), and from your worker box an agent token is enough to read it:

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

`/v1/agents` lists **registered** identities, so `sun` appears only after its
bridge has connected and registered. There is no heartbeat: `lastSeenAt` is the
time of the last registration, not a liveness signal, so a bridge that has been
up for hours still shows the time it started. An agent that never started, or
whose bridge is down, is absent or stale. When it is listed with your `nodeId`
and `instanceId`, collab mode is wired up end-to-end.

---

## 10. `worker-sun.local.json` is a git-ignored local manifest

The repo already ignores `.runtime/`. Make sure you do **not** copy
`worker-sun.local.json` from one machine to another. It contains machine
specific `nodeId`, `launch.filePath`, `launch.workingDirectory`,
`launch.arguments` (including `--workspace`), `launch.environment`
(`LARK_CHANNEL_HOME`), and the `credentialEnv` pointer. The portable unit is a
per-machine manifest plus a User-level env var.

---

## 11. The existing `Start-Process` chain propagates env correctly

If you ever doubt that a wrapper is dropping `LARK_COLLAB_*` vars on the way
to `node.exe`, drop this probe and run it through the same wrapper:

```javascript
// .runtime/env-probe.js
const want = ['LARK_COLLAB_HUB_URL','LARK_COLLAB_HUB_TOKEN','LARK_COLLAB_TENANT_KEY',
              'LARK_COLLAB_AGENT_ID','LARK_COLLAB_NODE_ID','LARK_COLLAB_INSTANCE_ID'];
const out = {};
for (const k of want) {
  const v = process.env[k];
  out[k] = v ? (k === 'LARK_COLLAB_HUB_TOKEN' ? `<set len=${v.length}>` : v) : '<empty>';
}
console.log(JSON.stringify(out, null, 2));
```

Delete it once you've confirmed. `.runtime/` is gitignored, but no reason to
leave probe files behind.

---

## 12. Scheduled Task trigger choice: `AtLogon` is the default, `AtStartup` is a trap

`Install-CollabPilotStartup.ps1` registers with `AtLogon -User <you>` and
`LogonType Interactive`. The bot therefore starts **only after a user signs
in**. That's the right default for two reasons:

1. The user-level env var (`LARK_COLLAB_SUN_TOKEN`) is loaded into Process
   scope by the user logon.
2. `~/.lark-channel` is per-user; SYSTEM-context tasks can't write there.

If you swap to `AtStartup`, the task either fails (no logon session, no
profile) or needs stored credentials, which leaks the user's password.
**Don't.** If "开机自起" really means pre-logon, the correct fix is a
dedicated service account with its own profile, not a tweak to the existing
trigger.

---

## 13. One journal per **agent**, and one journal file per **topic**

The local observed-topic journal used to be one JSONL file per machine and one
file for everything. On a multi-agent box that meant:

- the shared file made every agent append its own copy of the same group
  message, so the journal grew N-fold on an N-agent node, and
- one ever-growing file mixed every topic together.

Now:

```
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

`run-agent.ps1` sets `LARK_COLLAB_NODE_LEDGER_ROOT` to
`.runtime\local-topic-ledger\$Agent` (per agent, despite the historical env
name), and the bridge writes one file per scope: the topic file above for a
`chatId:threadId` scope, `_chat.jsonl` for a plain chat. Records are
de-duplicated by `id` per scope, so re-observing a message does not append it
twice.

The legacy single-file path (`<root>\collaboration\local-topic-ledger.jsonl`) is
still **read**: the bridge queries the legacy file and the per-topic file
together, so an in-place upgrade keeps its history. Nothing is written there any
more. This journal is node-local: it records what that bridge observed and
is never replicated to the Hub.

Upgrading an existing node:

```powershell
# stop the agents (per-agent tasks) before touching the journals
Stop-ScheduledTask -TaskName FeishuBridgeSun
Stop-ScheduledTask -TaskName FeishuBridgeMoon
# group the legacy records by `scope`, de-duplicate by `id`, and append each
# group to <agentRoot>\collaboration\topics\<chatId>\<threadId>.jsonl for every
# agent root (see the migration note below)
```

Rule of thumb: **if a record has no `scope`, it cannot be migrated**. Every
record carries the scope it was observed in, and scopes are `chatId` or
`chatId:threadId`. The writer always writes both `scope` and `id`; the reader is
what skips records whose scope does not match the requested one, or that carry
no `id`, so the migration keeps only what the current reader would return.
Archive the legacy files once their content is in the per-topic files (this
checkout kept them under `.runtime\archive\ledger-pre-topics\`).

---

## 14. A native CLI's stderr is fatal while `$ErrorActionPreference = 'Stop'`

Symptom: a supervisor dies with exit code 1 exactly one step after logging
"start: …", while the same script run by hand survives. `Start-CollabAgent.ps1`,
`Stop-CollabAgent.ps1` and both supervisors set
`$ErrorActionPreference = 'Stop'`, and in Windows PowerShell 5.1 **redirecting a
native command's stderr turns it into a terminating error**:

```powershell
# FATAL when the CLI writes its "not found" message to stderr:
& node $cli kill $id *> $null

# Safe: unredirected stderr is plain console text, and the exit code is readable
& node $cli kill 1
if ($LASTEXITCODE -ne 0) { Write-Warning "…not registered; falling back" }
```

`dist\cli.js kill <id>` writes `✗ 没找到匹配的 bot:<id>` to **stderr** and exits
1 whenever the id is not in the registry, which is a normal outcome after a
hard kill. Two rules follow:

1. Never re-implement "clear the bridge registration"; call
   `Pilot.Common.ps1::Stop-CollabRegisteredBridge`, which resolves the agent's
   own `LARK_CHANNEL_HOME` first, kills the agent's registry entry, and treats a
   missing registration as a warning. The stop and start sides call it for you
   (`Stop-CollabAgent.ps1` and the per-agent supervisor's `Clear-AgentRuntime`),
   so normal operation never needs a hand-rolled kill.
2. If you must run a native command under `$ErrorActionPreference = 'Stop'`,
   do not redirect its stderr, or lower the preference around that one call.

Related: the bridge CLI resolves its registry from `LARK_CHANNEL_HOME`
(`<home>\registry\processes.json`), and it reads that variable **before** the
command runs, so an agent with its own home must export it first:

```powershell
$env:LARK_CHANNEL_HOME = 'C:\Users\<you>\.lark-channel-<agent>'
node C:\feishu-local-agent-bridge\dist\cli.js kill 1   # 1 = first entry in *this* registry
```

Without that export the CLI inspects a different agent's registry and reports
"not found" for an id that is right there.

---

## 15. Feishu scope `im:message.group_msg` is what makes a bot *see* group traffic

Two independent switches, easy to confuse:

| Setting | Where | Effect |
| --- | --- | --- |
| `im:message.group_msg` scope | Feishu app (授权范围) | the bot **receives** every group message, @-mentioned or not |
| `requireMentionInGroup: true` | bridge profile | the bot **answers** only messages that @-mention it |

Without the scope, a non-@ group message never reaches the bridge at all: the
platform only pushes @-bot events. On the Feishu/lark-cli side,
`+chat-messages-list` then fails with a permission error (`230027`, or a
`99991672`-shaped API error); nothing in this repository calls that endpoint, so
treat the error as an observation from lark-cli. Add the scope incrementally,
without touching the app secret:

- In chat: turn off "群里需要 @ bot" in `/config`. The bridge verifies the
  scope and, when it is missing, sends a one-click incremental authorization
  card built from the app id plus the tenant scopes only.
- Offline equivalent:

```javascript
// .runtime/grant-group-msg-scope.mjs — writes scope-grant.json + a QR PNG
import { registerApp } from '@larksuite/channel';
await registerApp({
  source: 'lark-channel-bridge',
  appId: '<cli_…>',
  addons: { scopes: { tenant: ['im:message.group_msg'] } },
});
```

Then have the app owner scan the QR. Keep the app secret out of the payload:
passing `appSecret` makes the request take a different path and the launcher
then reports "应用不存在".

Keep `requireMentionInGroup: true` when you want "see everything, answer only
when @-mentioned". With the scope granted, non-@ messages from an allowed chat
are still journaled, because the bridge records the message **before** the
mention policy is applied.

---

## 16. `intake/skip-not-allowed-user` with `reason: denied-chat` is misleading

A `@bot` message in a group the bot is a member of can be dropped while the log
reads like a *user* problem:

```json
{"event":"intake/skip-not-allowed-user","scope":"oc_…","sender":"…","reason":"denied-chat"}
```

It means the **chat** is not in that profile's `access.allowedChats`, and the
sender is neither the app owner nor an admin. It does not mean the human is
unauthorized. The sender is truncated to its last six characters, so match on
`scope`/`reason`, not on the user. Two sanctioned ways to open a group:

1. In-group onboarding: the app owner or an admin @-mentions the bot with
   `/invite group` (or `/invite all group`).
2. Add the `chat_id` to `access.allowedChats` in that profile's `config.json`
   and restart **that** agent.

Never copy another agent's `allowedChats` wholesale. A chat that belongs to one
agent (a Claude-only group, for instance) must stay out of the other's list.
Add exactly the id you verified.

---

## 17. Hub-less worker families: nothing shared but the Hub

When one machine hosts several agents, treat them as if they were on separate
machines. Per agent, all of these must be separate:

| Thing | Per agent value |
| --- | --- |
| Manifest | `.runtime\worker-<id>.local.json` |
| Task | `Install-CollabPilotStartup.ps1 … -Agent <id> -TaskName <Name>` |
| Supervisor | `Run-CollabAgentSupervisor.ps1 -Agent <id>` (event-driven, idle when healthy) |
| Credential | User-level `LARK_COLLAB_<ID>_TOKEN` + `credentialEnv` pointer |
| Profile root | `LARK_CHANNEL_HOME` when they do not share one |
| Journal | `.runtime\local-topic-ledger\<id>\` |

Only the Hub URL/tenant key is shared. Anything that stops, restarts or
reconfigures a sibling agent must stay scoped to that agent: `-StartNow` on a
per-agent task stops the agent, not the pilot, and an agent's crash-loop must
never take its neighbour down. Verify per agent with
`Status-CollabPilot.ps1 -Agent <id>` and `/v1/agents` (see #9).

---

## 18. `@deepseek-ai/dsh` from npm never runs when imported by the bridge

The DeepSeek Harness engine entry (`node_modules\@deepseek-ai\dsh\lib\bin.js`)
is ESM ending in:

```javascript
if (import.meta.main) await runCli();
//#endregion
export { runCli };
```

`import.meta.main` is only true when *that file* is the process entry. The
bridge adapter starts the engine from a `node -e` bootstrap that imports the
entry as a module (`await import(pathToFileURL(entry).href)`). The import
succeeds, returns immediately and the run exits 0 with no output, so the bot
silently answers nothing.

Fix: point the profile at a shim that calls the exported CLI function:

```javascript
// ~/.lark-channel-<agent>/dsh-entry.mjs
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const mod = await import(pathToFileURL(entry).href);
await (mod.runCli ?? mod.default?.runCli)();
```

Then set `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` to that file in the agent's
`launch.environment`, and sanity-check it:

```powershell
node C:\Users\<you>\.lark-channel-<agent>\dsh-entry.mjs --version   # must print a version
```

The node binary the adapter spawns is the profile's
`deepseekHarness.binaryPath`, which the profile stores when it is created from
`LARK_CHANNEL_NODE_BIN`. A harness agent whose Node is not the global `node.exe`
must therefore point `LARK_CHANNEL_NODE_BIN` at the same interpreter the shim
resolves `node_modules` from. That variable is read only while the profile is
created, so an existing profile needs `deepseekHarness.binaryPath` edited
directly or the profile recreated. Note that `--version` only proves the entry
loads: `node <entry> --version` also prints a version when the entry runs
directly as a main module. The real symptom is an engine that exits 0 with no
output, which is this pitfall and not a Feishu problem.

---

## 19. Windows PowerShell 5.1 has neither `[Convert]::ToHexString` nor `RandomNumberGenerator::GetBytes(int)`

Symptom: on a Hub node (`role: all` or `hub`), `Start-CollabPilot.ps1`,
`Start-CollabHub.ps1` or `Start-CollabAgent.ps1` fails before `hub-token.txt`,
`tenant-key.txt`, `agent-tokens.json` and `hub-config.json` are written:

```
Method invocation failed because [System.Convert] does not contain a method named 'ToHexString'.
Method invocation failed because [System.Security.Cryptography.RandomNumberGenerator] does not contain a method named 'GetBytes'.
```

`[Convert]::ToHexString` arrived in .NET 5 and the static
`RandomNumberGenerator.GetBytes(int)` in .NET Core 3.0. The scheduled task runs
`powershell.exe`, which is Windows PowerShell 5.1 on .NET Framework 4.8, and
neither method exists there. A `worker` node never noticed, because it returns
before hub-state creation; a Hub node could not bootstrap at all.

Fix (already in `Pilot.Common.ps1::New-CollabHexSecret`): create the generator
with `[Security.Cryptography.RandomNumberGenerator]::Create()`, fill a `byte[]`
through the instance `GetBytes(byte[])` overload, and format it with
`[BitConverter]::ToString($bytes).Replace('-','')`. All three exist in 5.1 and
7, so the same script runs under either interpreter, and a unit test fails if
the .NET-5-only calls come back.

Check: `powershell.exe -NoProfile -Command "[Convert]::ToHexString([byte[]]@(1,2))"`
fails on 5.1 and succeeds on `pwsh`.

---

## 20. A per-agent supervisor must know all three credential sources and the detached Hermes gateway

Two liveness mistakes are easy to make in a "keep one agent alive" loop:

1. Looking only at `credentialEnv` in Process scope. An agent may legitimately be
   configured with an inline `credential`, or through
   `.runtime\agent-tokens.json`, and `Get-CollabAgentToken` is the function that
   owns that precedence. A gate that reads one variable waits forever on a
   correctly configured agent and logs "credential not set" on every retry.
2. Restarting whenever no launcher PID is left in `pids.json`. A detached Hermes
   gateway is healthy with no launcher: `Start-CollabAgent.ps1` removes its own
   PID entry on purpose. Without a gateway check the supervisor re-runs the whole
   start path every few seconds and fights the user's own service.

Fix (already in `Run-CollabAgentSupervisor.ps1`): ask `Get-CollabAgentToken`
(catching its error) instead of reading one variable, and before restarting check
`Test-CollabHermesGateway` for agents whose manifest enables `hermesHook`,
re-checking on the slower `-GatewayCheckSeconds` timer (default 60). Every other
engine keeps the event-driven `Wait-Process` path.

---

## 21. A Hermes journal written outside `collaboration/` is never read

Symptom: a Hermes agent answers in Feishu, but
`lark-channel-bridge local-context read --scope <chatId:threadId>` returns no
records for that topic while the Claude/DeepSeek bridges on the same box have
them.

The Hook used to append to `<root>/local-topic-ledger.jsonl`, while the reader
resolves `<root>/collaboration/topics/<chatId>/<threadId>.jsonl` (and the legacy
`<root>/collaboration/local-topic-ledger.jsonl`). Different directory, so the two
never met, and with a per-agent root they never could.

Fix (already in `adapters/hermes/handler.py::_record_local_topic`): write into
`<root>/collaboration/topics/<safe chatId>/<safe threadId>.jsonl` with the same
record shape the TypeScript ledger writes (`id`, `scope`, `recordedAt`, `kind`,
`messageId`, `senderId`, `content`), sanitizing both path segments. The Hook
contract test pins the location so it cannot drift again.

Verify: run the Hook with `LARK_COLLAB_NODE_LEDGER_ROOT` pointing at a scratch
directory, then read that scope with `local-context read`.
