# DeepSeek Harness Windows Feishu Bridge Notes

This is a Windows-oriented bridge that runs DeepSeek Harness in its official
one-shot headless mode. It keeps all bridge state isolated under
`C:\deepseek-bridge\.lark-channel` and does not modify Codex, Antigravity, or
Hermes installations.

## Local paths

```text
C:\deepseek-bridge
C:\deepseek-bridge\workspace
C:\deepseek-bridge\.lark-channel
C:\Users\ZhenpingXing\Documents\Codex\2026-08-14\git-clone-https-github-com-deepseek\deepseek-harness
```

## First-time Feishu setup

Create a Feishu self-built app, enable its Bot capability, and configure the
`im.message.receive_v1` event through persistent connection. Then run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\deepseek-bridge\scripts\setup-deepseek-feishu.ps1
```

The script asks for the App ID and hidden App Secret. The secret is stored in
the bridge's encrypted local keystore and is never written into the script.

## Commands

```powershell
# start in the background
powershell -ExecutionPolicy Bypass -File C:\deepseek-bridge\scripts\start-deepseek-bridge-service.ps1

# status
powershell -ExecutionPolicy Bypass -File C:\deepseek-bridge\scripts\status-deepseek-bridge.ps1

# stop
powershell -ExecutionPolicy Bypass -File C:\deepseek-bridge\scripts\stop-deepseek-bridge-service.ps1
```

The start script uses a hidden user-session process rather than Task Scheduler,
which is blocked by this machine's application-control policy.
