# Windows Worker Pitfalls (Real-World Hit List)

[Back to README](../README.md) | [Back to WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.md) |
[中文](./WINDOWS_WORKER_PITFALLS.zh-CN.md)

This file collects the **specific** failures that bit during a real Windows
worker bring-up (machine `zpomenmax`, Sun agent, Hub at `100.108.87.97:17321`).
The fixes that landed in the pilot scripts are called out so a new machine can
skip the rerun.

> Conventions used below: `paths` assume the repo lives at
> `C:\feishu-local-agent-bridge`. PowerShell is Windows PowerShell 5.1 unless
> noted.

---

## 1. `node.exe` is not on the PowerShell PATH

Symptom:

```
Stop-CollabAgent.ps1 : 无法将node.exe识别为 cmdlet、函数、脚本文件或可运行程序的名称。
```

`pnpm install` puts Node into whatever folder the user unzipped it to. The
start-side scripts work because they take the path from the manifest, but
**stop-side** scripts call bare `node.exe` and rely on PATH. Same trap bites
the `Scheduled Task` action when a fresh PowerShell session inherits a
different PATH than the user shell.

Fix (already in `Pilot.Common.ps1::Stop-CollabRegisteredBridge`):

- Read `agents[*].launch.filePath` from the manifest; if it's an absolute path
  and exists, use it. Otherwise fall back to `(Get-Command node.exe
  -ErrorAction SilentlyContinue).Source`.
- If neither resolves, log a warning and skip the in-bridge kill — the
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

`System.Net.Http` is a .NET Standard assembly that **is not pre-loaded** in
Windows PowerShell 5.1. PowerShell 7+ auto-loads it; 5.1 needs an explicit
`Add-Type`.

Fix (already in `Pilot.Common.ps1::Test-CollabHubHealth`):

```powershell
if (-not ('System.Net.Http.HttpClientHandler' -as [type])) {
  try { Add-Type -AssemblyName 'System.Net.Http' } catch { }
}
```

Also rewrote the function to **retry 3× with 5s timeout** instead of failing
on the first transient blip (see pitfall #3).

---

## 3. Hub `/health` is intermittent from this machine

Symptom: `Start-CollabAgent.ps1` throws `Remote Hub is unavailable: …`
sometimes, but the same Hub is reachable 5/5 from `Invoke-WebRequest` in a
fresh shell. Three-second timeout masks real, brief TCP blips.

Fix (already in `Pilot.Common.ps1::Test-CollabHubHealth`):

- Per-request `HttpClient.Timeout` = 5s (was 2s in callers, 3s in script).
- Three attempts with 1s gap.
- Return `true` on the first `{"ok":true}`.

If the Hub is on Tailscale, do **not** lower the timeout — Tailscale NAT
re-establishment can briefly stall a connection from an interactive wake-up.

---

## 4. `LARK_CHANNEL_HOME` must point at the actual profile root

Symptom:

```
Error: 当前没有配置，非交互模式无法完成扫码创建应用。
```

Default `resolveAppPaths().rootDir` is `C:\Users\<you>\.lark-channel`. If you
override `LARK_CHANNEL_HOME` in the worker config, **the new value must exist
and have** `profiles/<name>/` under it. Pointing `LARK_CHANNEL_HOME` at an
empty directory (e.g. `C:\feishu-profiles\claude`) silently fails bootstrap.

How to check:

```powershell
Test-Path C:\Users\zhenp\.lark-channel\profiles\claude\secrets.enc   # must be True
Get-Content C:\Users\zhenp\.lark-channel\active-profile                # 'claude'
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
launched from a clean shell sometimes sees `Process` empty because some
shells drop registry-derived env vars.

Fix (already in `Start-CollabAgent.ps1`):

```powershell
if ($agentConfig.credentialEnv -and -not [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'Process')) {
  $userValue = [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'User')
  if ($userValue) {
    [Environment]::SetEnvironmentVariable($agentConfig.credentialEnv, $userValue, 'Process')
  }
}
```

So manual starts and scheduled-task starts now behave identically.

---

## 6. Profile-lock contention between concurrent bridges

Symptom:

```
当前 profile 已有 bridge 进程占用；非交互模式无法确认停止，请先用 lark-channel-bridge ps
查看并用 lark-channel-bridge kill <bot id> 停止后重试
```

Two bridge processes trying to bind the same `~/.lark-channel/profiles/<name>/`
silently deadlock. Symptom is usually a leftover from a half-cleaned Stop.

How to recover:

```powershell
# Show every Sun bot the registry knows about
node C:\feishu-local-agent-bridge\dist\cli.js ps
# Kill by short id
node C:\feishu-local-agent-bridge\dist\cli.js kill 5428
```

Or belt-and-suspenders:

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
   attachments, or list chat participants** — meaning `@Sun` mentions in a
   topic only work if the message directly @-mentions Sun. Hub-mediated
   delegation to other agents is unaffected (it goes through the Hub REST
   endpoint, not lark-cli).
2. `npm install -g @larksuite/cli` may partially fail on Windows when an
   installer tries to `rmdir` an in-use directory. Re-run after closing any
   Trae / Cursor / VS Code that holds the dir open. Or use `--force`.

---

## 8. `@Sun` in the **root** of a chat is dropped

Worker-mode collaboration features (`/v1/agents`, `submit`, dispatch) only
kick in when the message arrives in a Feishu **topic** (`omt_…` threadId).
Plain root-chat `@Sun` falls through to the bridge's local-only handling —
which is fine but doesn't exercise Hub dispatch.

For an end-to-end smoke test, always:

1. Open the chat.
2. Long-press a message → "Reply in topic".
3. `@Sun <prompt>` inside the topic.

---

## 9. Hub `/workers` returns 401 without worker auth

Symptom:

```
Invoke-WebRequest http://100.108.87.97:17321/workers
401 Unauthorized
```

That's expected — `/v1/agents` (Hub-side introspection of registered
workers) requires a Hub token. From your worker box, the same Sun token
proves it is alive:

```powershell
$token = [Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User')
$h = [System.Net.Http.HttpClientHandler]::new(); $h.UseProxy = $false
$c = [System.Net.Http.HttpClient]::new($h); $c.Timeout = [TimeSpan]::FromSeconds(5)
$c.DefaultRequestHeaders.Add('Authorization', "Bearer $token")
($c.GetAsync('http://100.108.87.97:17321/v1/agents').GetAwaiter().GetResult()
  .Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).agents |
  Where-Object id -eq 'sun' |
  Format-List id,nodeId,instanceId,lastSeenAt
```

If `sun` is listed with your `nodeId` and `instanceId`, collab mode is wired
up end-to-end.

---

## 10. `worker-sun.local.json` is a git-ignored local manifest

The repo already ignores `.runtime/`. Make sure you do **not** copy
`worker-sun.local.json` from one machine to another — it contains machine-
specific `nodeId`, `workspace`, `launch.filePath`, and (implicitly) the
`credentialEnv` pointer. Per-machine manifest + User-level env var is the
unit of portable config.

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

Delete it once you've confirmed — `.runtime/` is gitignored, but no reason to
leave probe files behind.

---

## 12. Scheduled Task trigger choice: `AtLogon` is the default, `AtStartup` is a trap

`Install-CollabPilotStartup.ps1` registers with `AtLogon -User <you>` and
`LogonType Interactive`. That means the bot starts **only after a user signs
in**. That's the right default for two reasons:

1. The user-level env var (`LARK_COLLAB_SUN_TOKEN`) is loaded into Process
   scope by the user logon.
2. `~/.lark-channel` is per-user; SYSTEM-context tasks can't write there.

If you swap to `AtStartup`, the task either fails (no logon session, no
profile) or needs stored credentials — which leaks the user's password.
**Don't.** If "开机自起" really means pre-logon, the correct fix is a
dedicated service account with its own profile, not a tweak to the existing
trigger.