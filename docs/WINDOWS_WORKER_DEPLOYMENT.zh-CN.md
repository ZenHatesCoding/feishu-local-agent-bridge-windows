# Windows Worker 部署指南

[返回 README](../README.zh.md) |
[English](./WINDOWS_WORKER_DEPLOYMENT.md) |
[返回 Windows Operations](./WINDOWS_OPERATIONS.zh-CN.md) |
[踩坑清单](./WINDOWS_WORKER_PITFALLS.zh-CN.md)

把一台干净的 Windows 机器接成已注册的 Feishu Hub worker 的完整、可复制粘贴
流程。已验证案例：agent `sun`、机器 `zpomenmax`、Hub 在
`http://100.108.87.97:17321`。

> 前提：Hub 已经在跑，你拿到了 `HUB_URL`、`TENANT_KEY`、`AGENT_ID`、
> `AGENT_TOKEN`。
>
> 机器上需要 **node**、**pnpm**、**git**（在 PATH 或知道它们的绝对路径），
> 以及**到 Hub 的网络可达性**（Tailscale 或等价方案）。

---

## 阶段 0 — 确定机器身份

先定两个值，下面全程复用：

| 名字         | 示例          | 用途                                                              |
| ------------ | ------------- | ----------------------------------------------------------------- |
| `NODE_ID`    | `zpomenmax`   | manifest 里的 `nodeId`、`LARK_COLLAB_NODE_ID` 环境变量、Hub 日志。 |
| `AGENT_ID`   | `sun`         | `agents[].id`、`credentialEnv` 后缀、task name 后缀。              |

`AGENT_ID` 是 **每个 agent 一个**（同一台机器上多 agent 各拿一个）。`NODE_ID`
是 **每台机器一个**（同台机器所有 agent 共用）。

---

## 阶段 1 — 克隆 + 构建

```powershell
git clone --branch feature/feishu-multi-agent-hub --single-branch `
  https://github.com/ZenHatesCoding/feishu-local-agent-bridge-windows.git `
  C:\feishu-local-agent-bridge
Set-Location C:\feishu-local-agent-bridge
pnpm install        # 会顺带跑 tsup 构建
```

如果 `pnpm` 不在 PATH，先装一次：

```powershell
# 可选 —— 如果 pnpm 已经在 PATH 就跳过
npm install -g pnpm@10.33.0
```

---

## 阶段 2 — 让 PowerShell 能找到 node

如果 Node 不在默认安装目录（`C:\Program Files\nodejs\…`），后面就在
worker 配置里写绝对路径。`pnpm install` 已经触发过 `tsup`，`dist/cli.js`
已经存在。

---

## 阶段 3 — 准备 Feishu app + profile（首次）

如果这个 agent 在这台机器上**还没有** Feishu app / profile，先在 **Hub
所在的主 PC** 上走一遍 `profile create` 流程，再把生成的 `~/.lark-channel/`
拷到这台机器上。然后：

```powershell
# 检查 profile 是否完整
Test-Path C:\Users\<you>\.lark-channel\profiles\<profile>\secrets.enc   # True
Get-Content C:\Users\<you>\.lark-channel\active-profile                 # <profile 名>
```

如果 `secrets.enc` 不在，profile 在这台机器上不能用——需要在这台机器上
重新走一遍扫码 / app-secret 绑定。

---

## 阶段 4 — Worker manifest

新建 `.runtime\worker-<AGENT_ID>.local.json`。仓库已经 ignore `.runtime/`，
所以这个文件是本机的：

```json
{
  "schemaVersion": 1,
  "role": "worker",
  "nodeId": "zpomenmax",
  "hub": {
    "publicUrl": "http://100.108.87.97:17321",
    "tenantKey": "zhenping-feishu-collab-v1"
  },
  "larkCliJs": "",
  "commonEnvironment": {
    "LARK_CHANNEL_DISABLE_PROXY": "1"
  },
  "unsetEnvironment": [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY"
  ],
  "agents": [
    {
      "id": "sun",
      "displayName": "Sun",
      "aliases": ["cc", "claude"],
      "enabled": true,
      "credentialEnv": "LARK_COLLAB_SUN_TOKEN",
      "launch": {
        "filePath": "C:\\node-v22.10.0-win-x64\\node.exe",
        "arguments": [
          "C:\\feishu-local-agent-bridge\\dist\\cli.js",
          "run",
          "--profile",
          "claude",
          "--agent",
          "claude",
          "--workspace",
          "C:/workspaces/claude"
        ],
        "workingDirectory": "C:/workspaces/claude",
        "environment": {
          "LARK_CHANNEL_HOME": "C:\\Users\\zhenp\\.lark-channel"
        }
      }
    }
  ]
}
```

要改的地方：

- `nodeId` / `agents[].id` / `agents[].launch.filePath` / `--workspace` /
  `LARK_CHANNEL_HOME`：对齐你这台机器。
- `hub.publicUrl` / `hub.tenantKey`：Hub 那边给你的。
- `agents[].credentialEnv`：必须以 agent id 结尾，跟下面的
  `LARK_COLLAB_<AGENT_ID>_TOKEN` 对齐。

校验：

```powershell
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1 `
  -Config .\.runtime\worker-sun.local.json
```

期望：`Config OK: … / Role: worker / Enabled agents: sun / Hub: …`。

---

## 阶段 5 — 把 Hub token 写到 User 级

```powershell
[Environment]::SetEnvironmentVariable(
  'LARK_COLLAB_SUN_TOKEN',
  '<粘贴你的 AGENT_TOKEN>',
  'User'
)
# 确认
[Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User').Length
# 应该输出 64
```

User 级 env var **跨重启保留**，并且 Task Scheduler 任务和交互 PowerShell
都会继承。

---

## 阶段 6 — 手动启动（冒烟测试）

```powershell
.\scripts\collab-pilot\Start-CollabAgent.ps1 `
  -Agent sun `
  -Config .\.runtime\worker-sun.local.json
```

期望：

```
sun started in background (PID …).
Hub health: True
…
```

然后：

```powershell
.\scripts\collab-pilot\Status-CollabPilot.ps1 `
  -Agent sun `
  -Config .\.runtime\worker-sun.local.json
```

应打印一行 `Running = True`。

从任何能访问 Hub 的机器上，验证 Sun 已经用正确的 `nodeId` 注册：

```powershell
$token = [Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User')
$h = [System.Net.Http.HttpClientHandler]::new(); $h.UseProxy = $false
$c = [System.Net.Http.HttpClient]::new($h); $c.Timeout = [TimeSpan]::FromSeconds(5)
$c.DefaultRequestHeaders.Add('Authorization', "Bearer $token")
($c.GetAsync('http://100.108.87.97:17321/v1/agents').GetAwaiter().GetResult()
  .Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).agents |
  Where-Object id -eq 'sun' |
  Format-List id,nodeId,instanceId,lastSeenAt
```

---

## 阶段 7 — 飞书侧冒烟测试

在 **Hub owner** 所在的群里，打开一个话题（长按某条消息 → "在话题中回
复"），然后 `@Sun ping`。Sun 应该回复。

如果没回复，看
[`WINDOWS_WORKER_PITFALLS.zh-CN.md`](./WINDOWS_WORKER_PITFALLS.zh-CN.md) §7-§8。

---

## 阶段 8 — 登录自启

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -StartNow
```

注册 Task Scheduler 任务 `Lark Collaboration Pilot`：

- 触发器：`AtLogon`，当前用户，interactive logon。
- 动作：跑 `Run-CollabPilotSupervisor.ps1`，它会 15 秒轮询地把
  `Start-CollabPilot` 拉起来，进程死了自动重启。
- 设置：`StartWhenAvailable`、失败 ×3 / 1 分钟重跑、不在电池模式停。

`-StartNow` 会立刻启动一次。验证：

```powershell
Get-ScheduledTask -TaskName 'Lark Collaboration Pilot' | Format-List *
```

下次重启 / 重登后，supervisor 会自动把 worker 拉起来。

卸载：

```powershell
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

---

## 日常命令

| 想做…                  | 跑                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| 全部启动               | `.\scripts\collab-pilot\Start-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`         |
| 全部停止               | `.\scripts\collab-pilot\Stop-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`          |
| 只启动 Sun             | `.\scripts\collab-pilot\Start-CollabAgent.ps1 -Agent sun -Config …`                            |
| 只停止 Sun             | `.\scripts\collab-pilot\Stop-CollabAgent.ps1 -Agent sun -Config …`                             |
| 实时状态               | `.\scripts\collab-pilot\Status-CollabPilot.ps1 -Config .\.runtime\worker-sun.local.json`        |
| 跟踪日志               | `Get-Content .\.runtime\logs\sun.out.log -Wait`                                                 |
| 注册登录自启           | `.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config … -StartNow`                     |
| 删除登录自启           | `.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1`                                       |

---

## 一台机器跑多个 agent

每多一个 agent 就多一份 `worker-<id>.local.json`，每个 agent 单独调一次
`Install-CollabPilotStartup.ps1`，**`-Config`** 指向各自的 manifest（必要时
用 `-TaskName` 区分多个 task）。每个 agent 需要独立的 User 级 env var
（`LARK_COLLAB_<id>_TOKEN`），并在 manifest 里把 `credentialEnv` 指过去。