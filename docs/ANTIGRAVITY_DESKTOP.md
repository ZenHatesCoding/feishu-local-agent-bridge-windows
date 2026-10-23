# Antigravity App Worker

[Project README](../README.md) | [Agent bridges](./AGENT_BRIDGES.md) | [中文](./ANTIGRAVITY_DESKTOP.zh-CN.md)

The desktop transport executes authorized Feishu work in an existing Antigravity
App project. It uses the official App Sidecar, agentapi and lifecycle Hooks.
It does not spawn agy for either business work or topic-memory synthesis.
The App must be installed, signed in and running in the current user session.
Closing the App makes this Worker unavailable; there is no implicit CLI fallback.

## Install

Create or select a dedicated App project containing the Worker's workspace.
Use its existing ID from the App configuration under ~/.gemini/config/projects.
Keep each bot's bridge profile, Sidecar ID, project binding and runtime root separate.

```powershell
.\scripts\collab-pilot\Install-AntigravityDesktopSidecar.ps1 `
  -SidecarId <unique-worker-sidecar> `
  -ProjectId <existing-app-project-id> `
  -WorkspaceRoot C:\worker\workspace `
  -DesktopRoot C:\worker\runtime\desktop
```

The installer copies host assets into DesktopRoot/host, adds one named Sidecar
and one named Hook definition, and saves backups. Existing configuration and
other hooks are preserved. It does not restart the App or change its login,
model selection, native memory or permission policy. Assets use Node.js, and
Windows Hooks invoke PowerShell without opening visible windows.

Configure these variables in the selected Pilot agent's launch.environment:

```json
{
  "LARK_CHANNEL_ANTIGRAVITY_TRANSPORT": "desktop",
  "LARK_ANTIGRAVITY_DESKTOP_ROOT": "C:\\worker\\runtime\\desktop"
}
```

For standalone launches, alternatively set antigravity.transport to desktop and antigravity.desktopRoot
in the bridge profile. The agentKind remains antigravity. Wait for a fresh
DesktopRoot/heartbeat.json, build the bridge, then restart only this Worker.
The App selects the model; per-run CLI model overrides are rejected explicitly.
CLI project, print timeout and skip-permission flags do not control App execution.

## Execution and boundaries

Each bridge run creates one new App conversation with a private random binding.
The Sidecar accepts work only within its configured project workspace (memory
synthesis is data-only and denies every tool). The current Hub dispatch and
memory binding remain per-run. The deterministic Hub protocol is unchanged.

Named Hooks match only bound conversations. Unrelated App conversations retain
their normal policies. Authorized run_command calls use a wrapper that reads
the private run environment; credentials are not embedded in tool arguments.
The wrapper preserves cwd within the project and forwards the selected bot's
profile and collaboration commands. It uses non-interactive PowerShell on Windows.
Interactive question/permission tools are denied for these unattended runs;
the agent must return missing information or approval requirements in its final answer.

Only public PLANNER_RESPONSE text is returned after a successful, fully idle Stop
event. Tool/model lifecycle events produce coarse activity. Reasoning, tool
arguments, unrelated sessions and client authentication tokens are not exported.
Heartbeat freshness is availability, not fabricated agent progress.

Cancellation fences replies, denies further tools and terminates verified
wrapper-owned Windows process trees. PostInvocation terminates a cancelled loop.
An already-issued native model request may finish before that Hook runs; this
does not claim immediate server-request abortion. The App itself is never killed.
Completed conversations cannot reuse an old dispatch's environment for new tools.

Sidecar restarts preserve conversation bindings and do not resubmit accepted
work. A crash during submission with no confirmed binding fails as uncertain,
rather than risking duplicate execution. Bridge lease expiry prevents abandoned
runs from continuing tools. Client disconnects fail explicitly.

## Operations and rollback

DesktopRoot contains private requests, bindings, lifecycle events and results.
Keep it out of Git and use the Worker's OS account/ACLs. Do not publish raw App
logs or request files: they can contain credentials or sensitive task data.

For rollback, stop this Worker, remove the desktop transport selection (both
profile and environment if set), then restart with the existing CLI configuration.
Disable only this named Sidecar and Hook if removing the integration; retain
runtime state and native conversations. CLI proxies are initialized after per-agent
environment removal, avoiding accidental deletion of the newly initialized proxy.

Validation must distinguish isolated App tests from real Feishu acceptance and
second-PC acceptance. Test result delivery, tool environment, cancellation,
Sidecar recovery, memory synthesis and unrelated-session isolation before rollout.

Official interfaces: [Sidecars](https://antigravity.google/docs/sidecars/),
[Hooks](https://antigravity.google/docs/hooks/),
[CLI headless](https://antigravity.google/docs/cli/headless/).
