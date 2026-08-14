# DeepSeek Harness Windows Feishu Bridge Notes

This branch runs DeepSeek Harness in its official one-shot headless mode. It is
intended to be cloned on a Windows computer as a self-contained Feishu bridge.
Its state lives inside the clone, so it does not modify Codex, Antigravity, or
Hermes installations.

## Install on a new computer

Prerequisites: Git and Node.js 22 or newer. In PowerShell:

```powershell
git clone --branch bridge/deepseek-harness --single-branch https://github.com/ZenHatesCoding/lark-antigravity-bridge-windows.git deepseek-feishu-bridge
cd .\deepseek-feishu-bridge
corepack enable
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-deepseek-bridge.ps1
```

The bootstrap script installs this bridge and clones/builds DeepSeek Harness at
`vendor\deepseek-harness`. To use an existing checkout instead, set
`DEEPSEEK_HARNESS_ROOT` before running the setup or service scripts.

## First-time Feishu setup

Create a Feishu self-built app, enable its Bot capability, and configure the
`im.message.receive_v1` event through persistent connection. Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-deepseek-feishu.ps1
```

The script asks for the App ID and hidden App Secret. The secret is stored in
the bridge's encrypted local keystore and is never written into the script.

## Commands

```powershell
# start in the background
powershell -ExecutionPolicy Bypass -File .\scripts\start-deepseek-bridge-service.ps1

# status
powershell -ExecutionPolicy Bypass -File .\scripts\status-deepseek-bridge.ps1

# stop
powershell -ExecutionPolicy Bypass -File .\scripts\stop-deepseek-bridge-service.ps1
```

The start script uses a hidden user-session process rather than Task Scheduler,
which is blocked by this machine's application-control policy.
