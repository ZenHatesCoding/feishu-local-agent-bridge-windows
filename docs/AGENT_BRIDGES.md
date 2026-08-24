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

Without `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`, the adapter uses the `agy`
argument protocol and identifies itself as `Antigravity CLI`.

## DeepSeek Harness

Harness mode is selected explicitly by `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`,
not guessed from a bot name.

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

Harness mode runs Node with the built `apps\cli\lib\bin.js` entry and the
headless profile. The same `dist\cli.js` can therefore run Antigravity and
DeepSeek bridge processes at the same time.

## Hermes

This project does not install, update or reinstall Hermes. Collaboration copies
only `adapters\hermes\HOOK.yaml` and `handler.py` into the explicitly configured
`HERMES_HOME\hooks\feishu-collaboration-hub`. Stop removes only that Hook.

Point the manifest launch command at the existing Hermes venv and
`python.exe -m hermes_cli.main gateway run`.

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
      "--profile", "deepseek", "--agent", "antigravity",
      "--workspace", "C:\\workspaces\\deepseek"
    ],
    "workingDirectory": "C:\\workspaces\\deepseek",
    "environment": {
      "LARK_CHANNEL_HOME": "C:\\feishu-profiles\\deepseek",
      "LARK_CHANNEL_ANTIGRAVITY_BIN": "node.exe",
      "LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY": "D:\\src\\deepseek-harness\\apps\\cli\\lib\\bin.js"
    }
  }
}
```

Validate with `Test-CollabPilotConfig.ps1`; then start the group. See
[Windows operations](./WINDOWS_OPERATIONS.md) for every field and rollback.
