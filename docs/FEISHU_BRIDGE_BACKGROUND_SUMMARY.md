# 飞书桥接后台运行总结

更新日期：2026-07-02

## 结论

三套桥接可以并存后台运行，但要分开启动、分开停止，避免互相抢环境变量。

- Hermes：使用已有 Windows 计划任务 `Hermes_Gateway`
- Codex：使用 `C:\codex-bridge` 里的后台启动脚本
- Antigravity：使用 `C:\antigravity-bridge` 里的独立后台启动脚本

重要：Windows 后台启动/停止涉及计划任务，建议用“管理员模式 PowerShell”执行下面的后台启动、停止、状态命令，尤其是 Antigravity 的 `start/stop/status` 脚本。

## Hermes 桥接

后台启动：

```powershell
Start-ScheduledTask -TaskName Hermes_Gateway
```

停止：

```powershell
Stop-ScheduledTask -TaskName Hermes_Gateway
```

查看状态：

```powershell
Get-ScheduledTask -TaskName Hermes_Gateway | Select-Object TaskName,State
```

当前计划任务实际执行文件：

```text
C:\Users\ZhenpingXing\AppData\Local\hermes\gateway-service\Hermes_Gateway.cmd
```

## Codex 飞书桥接

后台启动：

```powershell
powershell -ExecutionPolicy Bypass -File C:\codex-bridge\start-codex-bridge.ps1
```

停止：

```powershell
powershell -ExecutionPolicy Bypass -File C:\codex-bridge\stop-codex-bridge.ps1
```

查看运行中的桥接：

```powershell
lark-channel-bridge ps
```

日志位置：

```text
C:\Users\ZhenpingXing\.lark-channel\profiles\codex\logs\manual\bridge.out.log
C:\Users\ZhenpingXing\.lark-channel\profiles\codex\logs\manual\bridge.err.log
```

## Antigravity 飞书桥接

后台启动：

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\start-antigravity-bridge-service.ps1
```

停止：

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\stop-antigravity-bridge-service.ps1
```

查看状态：

```powershell
powershell -ExecutionPolicy Bypass -File C:\antigravity-bridge\scripts\status-antigravity-bridge.ps1
```

前台调试启动：

```powershell
cd C:\antigravity-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\run-antigravity-bridge.ps1
```

工作目录：

```text
C:\antigravity-bridge\workspace
```

独立配置目录：

```text
C:\antigravity-bridge\.lark-channel
```

Antigravity CLI 路径：

```text
C:\Users\ZhenpingXing\AppData\Local\agy\bin\agy.exe
```

备注：

- Antigravity 桥接独立使用 `C:\antigravity-bridge\.lark-channel`，不使用 Codex/Hermes 的 `.lark-channel` 配置。
- Antigravity 桥接启动脚本会清理 `HERMES_HOME` 和 `HERMES_GIT_BASH_PATH`，避免被误识别成 Hermes 环境。
- 如果 `agy` 触发 Google 登录验证码，需要在可交互 PowerShell 窗口里完成登录，不要在后台桥接里做首次登录。

可交互登录/检查命令：

```powershell
Start-Process powershell.exe -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  'Set-Location ''C:\antigravity-bridge\workspace''; & ''C:\Users\ZhenpingXing\AppData\Local\agy\bin\agy.exe'' --print ''请只输出 OK'' --print-timeout 5m'
)
```

如果这个窗口里出现验证码或输入提示，把验证码粘贴到这个窗口里。
