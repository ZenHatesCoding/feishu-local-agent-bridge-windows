# Agent Bridge 配置指南

[返回中文 README](../README.zh.md) | [English](./AGENT_BRIDGES.md) |
[协作设计](./DESIGN.zh-CN.md) | [Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)

## 先回答分支问题

新电脑只拉 `feature/feishu-multi-agent-hub`。当前分支已经统一包含 Claude Code、
Codex、Antigravity、DeepSeek Harness 的 bridge 能力，以及 Hermes Hook 和协作 Hub。
不需要为了部署不同 Agent 再切换或克隆其他分支。

`main`、`antigravity`、`deepseek-harness` 是旧部署形态的历史/回退分支。它们可以
继续独立使用，但不再是新部署文档的主路径。

## 共同前置条件

1. Windows、Git、Node.js 20.12+ 和 pnpm；DeepSeek Harness 建议 Node.js 22+。
2. 每个本地 Agent 已安装并完成自己的登录。
3. 每个机器人一个独立飞书 PersonalAgent 应用。
4. 每个机器人一个独立 `LARK_CHANNEL_HOME` 或 profile，不能共用 App Secret、
   会话锁和进程登记。
5. 仓库已执行 `pnpm install` 和 `pnpm build`。

飞书应用需要启用机器人能力和长连接消息事件。首次 profile 创建时按终端流程提供
App ID/App Secret；秘密进入本地加密存储，不写进脚本和 Git。

## Claude Code

前置：`claude --version` 和交互登录可用。

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\claude'
node .\dist\cli.js run `
  --profile claude `
  --agent claude `
  --workspace C:\workspaces\claude
```

第一次运行会创建/绑定飞书应用。协作清单中的 `launch` 使用同一条命令，并给它一个
稳定 Agent ID，例如 `claude`。

## Codex

前置：Codex CLI 已登录，`codex --version` 可用。非标准安装路径可以显式设置：

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\codex'
$env:LARK_CHANNEL_CODEX_BIN = 'C:\path\to\codex.cmd'
node .\dist\cli.js run `
  --profile codex `
  --agent codex `
  --workspace C:\workspaces\codex
```

## Google Antigravity

先在可见的交互 PowerShell 中完成 `agy` 登录，确认它能直接输出结果。后台进程无法
替你处理 Google 登录提示。

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\antigravity'
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = "$env:LOCALAPPDATA\agy\bin\agy.exe"
node .\dist\cli.js run `
  --profile antigravity `
  --agent antigravity `
  --workspace C:\workspaces\antigravity
```

没有 `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` 时，`antigravity` 适配器使用 `agy`
参数协议，显示名称是 `Antigravity CLI`。

## DeepSeek Harness

DeepSeek Harness 与 Antigravity 共用 bridge 的配置类型，但运行协议由
`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` 显式切换，不会靠机器人名字猜测。

最省事的完整安装：

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

bootstrap 默认把官方 Harness 克隆到 `vendor\deepseek-harness` 并构建 CLI。已有
Harness checkout 时：

```powershell
$env:DEEPSEEK_HARNESS_ROOT = 'D:\src\deepseek-harness'
.\scripts\bootstrap-deepseek-bridge.ps1 -SkipHarness
.\scripts\setup-deepseek-feishu.ps1
```

脚本最终设置的关键变量是：

```powershell
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = (Get-Command node).Source
$env:LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY = `
  'D:\src\deepseek-harness\apps\cli\lib\bin.js'
```

两者同时存在时，适配器以 Node 启动 Harness 的 headless profile，显示名称为
`DeepSeek Harness`。同一份 `dist\cli.js` 因而可以分别启动 Justice/Antigravity 和
Chariot/DeepSeek 两个进程。

## Hermes

本项目不会安装、更新或重装 Hermes。协作部署只把
`adapters\hermes\HOOK.yaml` 和 `handler.py` 复制到配置指定的
`HERMES_HOME\hooks\feishu-collaboration-hub`。停止时只删除这个目录。

Hermes 的 venv、源码、配置、会话、记忆、技能和其他 Hook 都不属于本项目部署范围。
清单中的 `launch` 应指向现有 venv 的 `python.exe -m hermes_cli.main gateway run`。

## 写入协作清单

先运行：

```powershell
.\scripts\collab-pilot\Setup-CollabPilot.ps1
notepad .\.runtime\pilot.local.json
```

每个 `agents[]` 条目至少需要：

- `id`、`displayName`、`aliases`；
- 实际 `launch.filePath`、`arguments`、`workingDirectory`；
- 独立 profile 所需的 `launch.environment`；
- 可选的原 bridge `original.stop/start`，用于无损切换和回退；
- Hermes 才需要的 `hermesHook`。

DeepSeek 协作进程示例：

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
      "--profile", "deepseek",
      "--agent", "antigravity",
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

配置完成后执行 `Test-CollabPilotConfig.ps1`，再启动整组。完整字段和回退命令见
[Windows 部署与运维](./WINDOWS_OPERATIONS.zh-CN.md)。
