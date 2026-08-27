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
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

The repository supplies the Hub and orchestration. Users supply installed and
logged-in agents, Feishu apps/profiles and real launch commands.

When Antigravity uses `agy.exe`, the launcher reads the current Windows user
proxy and passes it only to Antigravity. The Feishu connection remains direct
through `LARK_CHANNEL_DISABLE_PROXY=1`. If Feishu reports `Authentication
required` while the desktop client is already logged in, verify that the
Windows proxy is running and restart only that agent.
