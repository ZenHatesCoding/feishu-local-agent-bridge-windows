# Antigravity Windows Feishu Bridge Notes

This repository is a Windows-oriented personal vibecoding adaptation of `lark-channel-bridge`, built together with Codex and based on the upstream project by `zarazhangrui`.

The upstream project is MIT licensed. Keep the original `LICENSE` file and copyright notice when redistributing this fork.

## What This Fork Adds

- Adds an `antigravity` agent adapter that calls the local `agy` CLI.
- Keeps Antigravity bridge state isolated under `C:\antigravity-bridge\.lark-channel`.
- Adds Windows helper scripts for foreground debugging and background service management.
- Adds a local `lark-cli` wrapper so Antigravity can send Feishu files/images without being confused by Hermes environment variables.
- Avoids proxy leakage with `LARK_CHANNEL_DISABLE_PROXY=1`.
- Reports Antigravity stderr back to Feishu when `agy` exits with no stdout, avoiding confusing `(no content)` replies.

## Windows Paths Used On This Machine

```text
C:\antigravity-bridge
C:\antigravity-bridge\workspace
C:\antigravity-bridge\.lark-channel
C:\Users\ZhenpingXing\AppData\Local\agy\bin\agy.exe
```

## Antigravity Commands

Foreground debug:

```powershell
cd C:\antigravity-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\run-antigravity-bridge.ps1
```

Background start:

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\start-antigravity-bridge-service.ps1
```

Stop:

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\stop-antigravity-bridge-service.ps1
```

Status:

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\status-antigravity-bridge.ps1
```

On this Windows setup, background service commands may need to be run from an Administrator PowerShell because they create/control Windows Task Scheduler entries.

## Login Note

Do the first `agy` Google login in an interactive PowerShell window, not through the background bridge.

Interactive check:

```powershell
Start-Process powershell.exe -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  'Set-Location ''C:\antigravity-bridge\workspace''; & ''C:\Users\ZhenpingXing\AppData\Local\agy\bin\agy.exe'' --print ''请只输出 OK'' --print-timeout 5m'
)
```

If Google shows a verification code or input prompt, paste it into that new PowerShell window.

## Other Local Bridges

Hermes background start:

```powershell
Start-ScheduledTask -TaskName Hermes_Gateway
```

Hermes stop:

```powershell
Stop-ScheduledTask -TaskName Hermes_Gateway
```

Codex background start:

```powershell
powershell -ExecutionPolicy Bypass -File C:\codex-bridge\start-codex-bridge.ps1
```

Codex stop:

```powershell
powershell -ExecutionPolicy Bypass -File C:\codex-bridge\stop-codex-bridge.ps1
```

These bridges intentionally use separate configuration directories and startup scripts.
