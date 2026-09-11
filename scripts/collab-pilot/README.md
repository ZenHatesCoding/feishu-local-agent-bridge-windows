# Collaboration Pilot Scripts

[Project README](../../README.md) | [中文](./README.zh-CN.md) |
[Windows operations](../../docs/WINDOWS_OPERATIONS.md) |
[Concepts](../../docs/COLLABORATION_CONCEPTS.md) |
[Networking](../../docs/NETWORKING.md) |
[Distributed roadmap](../../docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

These scripts connect any configured number of local agent bridges to one
Feishu collaboration Hub and manage background processes, logs, context and
artifact delivery. Agent names and paths come from the Git-ignored
`.runtime\pilot.local.json`, not repository hard-coding.

With the default `role: "all"`, one Windows computer still manages the Hub and
its local Agents. The scripts also support a `worker` that connects to the
central Hub and a center-only `hub` role; a worker never starts another Hub.

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
```

`Install-CollabPilotStartup.ps1` creates a logon task for the current Windows
user and runs a long-lived supervisor. The Hub and Bots therefore do not depend
on a PowerShell, Codex, or ChatGPT window, and an exited component is started
again automatically. `Start-CollabPilot.ps1` remains useful for temporary runs
and development, but is not the durable cross-terminal startup path.

The repository supplies the Hub and orchestration. Users supply installed and
logged-in agents, Feishu apps/profiles and real launch commands.

Common lifecycle commands:

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -StartNow
.\scripts\collab-pilot\Status-CollabPilot.ps1
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

When Antigravity uses `agy.exe`, the launcher reads the current Windows user
proxy and passes it only to Antigravity. The Feishu connection remains direct
through `LARK_CHANNEL_DISABLE_PROXY=1`. If Feishu reports `Authentication
required` while the desktop client is already logged in, verify that the
Windows proxy is running and restart only that agent.
