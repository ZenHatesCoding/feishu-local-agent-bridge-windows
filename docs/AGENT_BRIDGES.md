# Agent Bridge Configuration

[Back to README](../README.md) | [中文](./AGENT_BRIDGES.zh-CN.md) |
[Collaboration design](./DESIGN.md) | [Windows operations](./WINDOWS_OPERATIONS.md)

## Branch Answer

For a new computer, clone only `feature/feishu-multi-agent-hub`. It now contains
the maintained Claude Code, Codex, Antigravity and DeepSeek Harness bridge
paths, plus the Hermes Hook and collaboration Hub. No second agent-specific
clone is required.

`main`, `antigravity` and `deepseek-harness` preserve older standalone layouts
for history and rollback. They are not the primary new-install path.

## Shared Prerequisites

1. Windows, Git, Node.js 20.12+ and pnpm; Node.js 22+ is recommended for Harness.
2. Every local agent is installed and logged in through its own interactive flow.
3. One Feishu PersonalAgent app per bot.
4. One distinct `LARK_CHANNEL_HOME` or profile per bot.
5. `pnpm install` and `pnpm build` completed in this checkout.

Enable the bot capability and persistent-connection message event in each
Feishu app. App Secrets go to the local encrypted profile store, never scripts
or Git.

## Unattended Artifact Delivery

Every bridge-launched Agent runs as an unattended background worker. The bridge
sets `LARK_CHANNEL_UNATTENDED=1` and injects the same runtime contract into every
maintained Agent: create the requested artifact with non-interactive libraries
or command-line tools, validate it headlessly, and return it through Feishu (or
`collab-artifact.cmd publish` in a collaboration task).

Agents must not launch or automate WPS, Microsoft Office, file pickers, save
dialogs, or other interactive desktop applications. Office/WPS COM automation,
including `PowerPoint.Application`, `New-Object -ComObject`, and `win32com`, is
not a supported artifact path even when configured as hidden: the registered
COM server can still display a window or confirmation dialog in the user's
desktop session. If a reliable headless generator or validator is unavailable,
the Agent reports that missing capability instead of asking the user to finish
the task on the computer.

All four maintained Agent paths receive the same Hub-generated collaboration
prompt. Historical files appear first as a bounded metadata catalog; a complete
path/locator record is supplied only when the current objective references that
Artifact. An Agent can run `collab-artifact.cmd resolve --task TASK --actor
AGENT --name "EXACT_NAME"` for one additional file, or `--list` when the catalog
is insufficient. Hermes does not build a separate full-history prompt.

`collab-artifact.cmd publish` owns the complete delivery path. If the current
private lark-channel workspace has lost its bot binding, the command repairs
that isolated workspace as `bot-only` and retries once before failing. Agents
must not substitute their native `.artifacts` staging directory or tell the
user to restart/doctor the Bridge unless this delivery command itself still
returns an exact error after the retry.

## Claude Code

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\claude'
node .\dist\cli.js run --profile claude --agent claude --workspace C:\workspaces\claude
```

## Codex

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\codex'
$env:LARK_CHANNEL_CODEX_BIN = 'C:\path\to\codex.cmd'
node .\dist\cli.js run --profile codex --agent codex --workspace C:\workspaces\codex
```

## Google Antigravity

Complete the `agy` login in a visible interactive PowerShell first.

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\antigravity'
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = "$env:LOCALAPPDATA\agy\bin\agy.exe"
node .\dist\cli.js run --profile antigravity --agent antigravity --workspace C:\workspaces\antigravity
```

The Antigravity adapter always uses the `agy` protocol. It never selects another
agent implementation from environment variables.
The default `agy --print` wait ceiling is 60 minutes. It is a leaked-process
safety limit rather than a normal task duration, and can be overridden through
`antigravity.printTimeout`. Because Antigravity does not provide dependable
incremental text while researching or building documents, the bridge sends the
final answer once as a normal reply instead of opening a markdown stream. It
does not post a synthetic “received/working” message at intake; Feishu's native
message state and the bridge's common run-state mechanism apply equally to all
Bots.

## DeepSeek Harness

DeepSeek Harness has its own `deepseek-harness` agent kind and adapter. The
entry path is configuration for that adapter, not a mode switch on Antigravity.

Do not add an older DeepSeek or Antigravity bridge `bin` directory to this
Agent's `PATH`. The Pilot supplies one identity-neutral command directory after
all manifest environment overrides, and the adapter passes the current
profile's explicit lark-channel context. On startup, lark-cli binding is
accepted only when the current App is present in this profile's private target
file; a zero exit code that wrote another profile is a failed preflight.

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

The bootstrap clones and builds Harness under `vendor\deepseek-harness`. To use
an existing checkout:

```powershell
$env:DEEPSEEK_HARNESS_ROOT = 'D:\src\deepseek-harness'
.\scripts\bootstrap-deepseek-bridge.ps1 -SkipHarness
.\scripts\setup-deepseek-feishu.ps1
```

The adapter runs Node with the built `apps\cli\lib\bin.js` entry and the
headless profile. Prompts are carried over stdin so long topics never depend on
the Windows command-line limit. Harness produces its answer as a final batch
rather than a dependable incremental stream. The bridge posts that completed
answer once as a normal topic reply and does not open an empty markdown stream
or post a synthetic intake acknowledgement.

## Hermes

This project does not install, update or reinstall Hermes. Collaboration copies
only `adapters\hermes\HOOK.yaml` and `handler.py` into the explicitly configured
`HERMES_HOME\hooks\feishu-collaboration-hub`. Stop removes only that Hook.

Point the manifest launch command at the existing Hermes venv and
`python.exe -m hermes_cli.main gateway run`.

The Hook accepts a human group message only when Hermes was actually mentioned.
For bot-originated messages it additionally requires a pending Hub dispatch for
the same topic. During an authorized run Hermes receives the current agent
directory and the same `collab-delegate ask|handoff` command contract as the
Node bridges, so every maintained bot can delegate to every other bot. The Hook
acks the dispatch as accepted, then records and completes or fails that exact
dispatch when the run ends.

For a shared collaboration group, use Hermes's group-chat boundary rather than
a per-person allowlist: set `FEISHU_GROUP_POLICY=open`, keep
`FEISHU_ALLOWED_USERS` empty, and set `FEISHU_GROUP_ALLOWED_CHATS` to the
approved Feishu `oc_...` chat IDs. All members of those groups can then
@mention Fool; messages from other groups and direct messages remain outside
that authorization grant. This requires the installed Hermes Feishu adapter to
provide `FEISHU_GROUP_ALLOWED_CHATS` support.

## Collaboration Manifest

Run `Setup-CollabPilot.ps1`, then edit `.runtime\pilot.local.json`. Each enabled
entry needs a stable identity, a real launch command, working directory and
profile-specific environment. `original.stop/start` is optional rollback
orchestration; only Hermes needs `hermesHook`.

DeepSeek example:

```json
{
  "id": "chariot",
  "displayName": "Chariot",
  "aliases": ["deepseek"],
  "enabled": true,
  "launch": {
    "filePath": "node.exe",
    "arguments": [
      "${REPO_ROOT}\\dist\\cli.js", "run",
      "--profile", "deepseek", "--agent", "deepseek-harness",
      "--workspace", "C:\\workspaces\\deepseek"
    ],
    "workingDirectory": "C:\\workspaces\\deepseek",
    "environment": {
      "LARK_CHANNEL_HOME": "C:\\feishu-profiles\\deepseek",
      "LARK_CHANNEL_NODE_BIN": "node.exe",
      "LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY": "D:\\src\\deepseek-harness\\apps\\cli\\lib\\bin.js"
    }
  }
}
```

Validate with `Test-CollabPilotConfig.ps1`; then start the group. See
[Windows operations](./WINDOWS_OPERATIONS.md) for every field and rollback.
