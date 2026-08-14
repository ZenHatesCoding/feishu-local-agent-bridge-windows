# DeepSeek Harness 飞书桥接（Windows）

这是基于 `lark-channel-bridge` 的 Windows 部署分支，用飞书机器人将消息转交给本机的 DeepSeek Harness。

## 新电脑安装

先安装 Git 与 Node.js 22 或更高版本，然后在 PowerShell 中执行：

```powershell
git clone --branch deepseek-harness --single-branch https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git deepseek-feishu-bridge
cd .\deepseek-feishu-bridge
corepack enable
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-deepseek-bridge.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\setup-deepseek-feishu.ps1
```

最后一个脚本会要求输入飞书 App ID，并完成扫码绑定。应用密钥、会话与工作区均保存在当前 clone 的 `.lark-channel` 目录，不会写入 Git。

启动、查看状态与停止：

```powershell
.\scripts\start-deepseek-bridge-service.ps1
.\scripts\status-deepseek-bridge.ps1
.\scripts\stop-deepseek-bridge-service.ps1
```

详细说明见 [DeepSeek Harness Windows Notes](./docs/DEEPSEEK_HARNESS_WINDOWS_BRIDGE.md)。
