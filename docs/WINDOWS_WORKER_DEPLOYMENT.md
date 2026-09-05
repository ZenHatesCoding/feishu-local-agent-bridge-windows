# Windows Worker Deployment Recipe

[Back to README](../README.md) | [Back to WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.md) |
[中文](./WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
[Pitfalls](./WINDOWS_WORKER_PITFALLS.md)

A complete, copy-paste-able recipe for turning a fresh Windows machine into a
registered Feishu-Hub worker. Worked example: agent `sun`, machine
`zpomenmax`, Hub at `http://100.108.87.97:17321`.

> Assumes the Hub already runs and you've been given:
> `HUB_URL`, `TENANT_KEY`, `AGENT_ID`, `AGENT_TOKEN`.
>
> Assumes the machine has **node**, **pnpm**, **git** on PATH (or in their
> install locations) and **network reachability to the Hub** (Tailscale or
> equivalent).

---

## Phase 0 — Decide machine identity

Pick two values you will use everywhere below:

| Name         | Example       | Used for                                                   |
| ------------ | ------------- | ---------------------------------------------------------- |
| `NODE_ID`    | `zpomenmax`   | `nodeId` in manifest, `LARK_COLLAB_NODE_ID` env, Hub logs. |
| `AGENT_ID`   | `sun`         | `agents[].id`, `credentialEnv` suffix, task name suffix.   |

The `AGENT_ID` is **per agent** (each agent on a multi-agent machine gets a
distinct one). The `NODE_ID` is **per machine** (same value across all agents
on the box).

---

## Phase 1 — Clone + build

```powershell
git clone --branch feature/feishu-multi-agent-hub --single-branch `
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

If `secrets.enc` is missing, the profile is not usable here — re-do the QR /
app-secret bind on this box.

---

## Phase 4 — Worker manifest

Create `.runtime\worker-<AGENT_ID>.local.json`. The repo already ignores
`.runtime/`, so this file is per-machine:

```json
{
  "schemaVersion": 1,
  "role": "worker",
  "nodeId": "zpomenmax",
  "hub": {
    "publicUrl": "http://100.108.87.97:17321",
    "tenantKey": "zhenping-feishu-collab-v1"
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
          "LARK_CHANNEL_HOME": "C:\\Users\\zhenp\\.lark-channel"
        }
      }
    }
  ]
}
```

Things to change:

- `nodeId` / `agents[].id` / `agents[].launch.filePath` / `--workspace` /
  `LARK_CHANNEL_HOME` — match your machine.
- `hub.publicUrl` / `hub.tenantKey` — given to you by whoever runs the Hub.
- `agents[].credentialEnv` — must end with your agent id; pick a name that
  matches `LARK_COLLAB_<AGENT_ID>_TOKEN`.

Validate:

```powershell
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1 `
  -Config .\.runtime\worker-sun.local.json
```

Expected: `Config OK: … / Role: worker / Enabled agents: sun / Hub: …`.

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
# Should print 64
```

User-level env vars **persist across reboots** and are inherited by both Task
Scheduler tasks and interactive PowerShell sessions.

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

Then:

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1 `
  -Agent sun `
  -Config .\.runtime\worker-sun.local.json
```

Should print a table row with `Running = True`.

From any machine with Hub reachability, verify Sun is registered with the
correct `nodeId`:

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

---

## Phase 7 — Smoke test in Feishu

In the **Hub owner's** group, open a topic (long-press a message → "Reply in
topic"), then `@Sun ping`. Sun should reply.

If it does not reply, see
[`WINDOWS_WORKER_PITFALLS.md`](./WINDOWS_WORKER_PITFALLS.md) §7–§8.

---

## Phase 8 — Auto-start at logon

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -StartNow
```

This registers the Task Scheduler entry `Lark Collaboration Pilot` with:

- Trigger: `AtLogon` for the current user (interactive logon).
- Action: `Run-CollabPilotSupervisor.ps1` which keeps `Start-CollabPilot`
  alive on a poll loop (15s default) and restarts it on exit.
- Settings: `StartWhenAvailable`, restart on failure ×3 / 1min, no battery
  stop.

It also starts it immediately via `-StartNow`. Verify:

```powershell
Get-ScheduledTask -TaskName 'Lark Collaboration Pilot' | Format-List *
```

After a reboot, the supervisor will relaunch on next sign-on.

To uninstall:

```powershell
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

---

## Daily commands

| Want to…                | Run                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Start everything        | `.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`      |
| Stop everything         | `.\scripts\collab-pilot\Stop-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`       |
| Start only Sun          | `.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent sun -Config …`                          |
| Stop only Sun           | `.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun -Config …`                           |
| Live status             | `.\scripts\collab-pilot\Status-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`     |
| Tail logs              | `Get-Content .\.runtime\logs\sun.out.log -Wait`                                              |
| Re-register at logon    | `.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config … -StartNow`                 |
| Drop the scheduled task | `.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1`                                    |

---

## Multi-agent on one machine

Each agent on the same machine gets its own `worker-<id>.local.json`. Run
`Install-CollabPilotStartup.ps1` once per agent, **passing `-Config …`** to
each call so each task names a different config. The scheduled task name
defaults to `Lark Collaboration Pilot`; pass `-TaskName …` to disambiguate.

Each agent needs its own User-level env var (`LARK_COLLAB_<id>_TOKEN`) and
its own `credentialEnv` pointer in the manifest.