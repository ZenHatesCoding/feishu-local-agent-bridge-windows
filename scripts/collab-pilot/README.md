# Collaboration Pilot Scripts

[Project README](../../README.md) | [中文](./README.zh-CN.md) |
[Windows operations](../../docs/WINDOWS_OPERATIONS.md)

These scripts connect any configured number of local agent bridges to one
Feishu collaboration Hub and manage background processes, logs, context and
artifact delivery. Agent names and paths come from the Git-ignored
`.runtime\pilot.local.json`, not repository hard-coding.

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1
.\scripts\collab-pilot\Start-CollabPilot.ps1
```

The repository supplies the Hub and orchestration. Users supply installed and
logged-in agents, Feishu apps/profiles and real launch commands.
