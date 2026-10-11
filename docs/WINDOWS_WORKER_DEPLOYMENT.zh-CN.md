# Windows Worker 部署指南

[返回 README](../README.zh.md) |
[English](./WINDOWS_WORKER_DEPLOYMENT.md) |
[返回 Windows Operations](./WINDOWS_OPERATIONS.zh-CN.md) |
[踩坑清单](./WINDOWS_WORKER_PITFALLS.zh-CN.md)

下面每个命令都可以直接复制粘贴，把一台干净的 Windows 机器接成已注册的
Feishu Hub worker。示例：agent `sun`、机器 `my-worker-pc`、Hub 在
`http://100.x.y.z:17321`。

> 前提：Hub 已经在跑，你拿到了 `HUB_URL`、`TENANT_KEY`、`AGENT_ID`、
> `AGENT_TOKEN`。
>
> 机器上需要 **node**、**pnpm**、**git**（在 PATH 或知道它们的绝对路径），
> 以及**到 Hub 的网络可达性**（Tailscale 或等价方案）。

下文中 `100.x.y.z` 代表 Hub 地址，`<you>` 代表你的 Windows 用户名，`sun` /
`moon` 代表 agent id。换成你自己的值即可，其余命令不用动。

---

## 阶段 0 — 确定机器身份

先定两个值，下面全程复用：

| 名字         | 示例          | 用途                                                              |
| ------------ | ------------- | ----------------------------------------------------------------- |
| `NODE_ID`    | `my-worker-pc` | manifest 里的 `nodeId`、`LARK_COLLAB_NODE_ID` 环境变量、Hub 日志。 |
| `AGENT_ID`   | `sun`         | `agents[].id`、`credentialEnv` 后缀、task name 后缀。              |

`AGENT_ID` 是 **每个 agent 一个**（同一台机器上多 agent 各拿一个）。`NODE_ID`
是 **每台机器一个**（同台机器所有 agent 共用）。不写 `nodeId` 时会退回
`[Environment]::MachineName`；只要机器名不是你想在 Hub 客户端列表里看到的名
字，就显式写一个。

---

## 阶段 1 — 克隆 + 构建

```powershell
git clone --branch release/worker --single-branch `
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

如果 `secrets.enc` 不在，profile 在这台机器上就不能用，需要在这台机器上
重新走一遍扫码 / app-secret 绑定。

---

## 阶段 4 — Worker manifest

新建 `.runtime\worker-<AGENT_ID>.local.json`。仓库已经 ignore `.runtime/`，
所以这个文件留在本地，并且是 **每个 agent 一份**（不要跨机器拷）。正常流程
下不用手写它：在 Hub 上跑
`Export-CollabWorkerConfig.ps1 -Agent <id> -HubUrl <url>` 就会生成一份现成的，
里面已经有该 agent 的 id、显示名、别名和启动命令，`nodeId` 是占位符，
`publicUrl`/`tenantKey` 是真实值，凭据以 `credential` 明文内联。把文件拷到
这台机器后再改。

```json
{
  "schemaVersion": 2,
  "role": "worker",
  "nodeId": "my-worker-pc",
  "hub": {
    "publicUrl": "http://100.x.y.z:17321",
    "tenantKey": "<TENANT_KEY>"
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
          "LARK_CHANNEL_HOME": "C:\\Users\\<you>\\.lark-channel"
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
- `larkCliJs`：留 `""` 即可，除非要固定某个具体安装。worker 启动器会自动解析
  真实 `@larksuite/cli` 的 JavaScript 入口（先看启动器 `node.exe` 旁，再看 npm
  全局根目录，最后看 `%APPDATA%\npm`），并导出为 `LARK_COLLAB_REAL_LARK_CLI_JS`。
  这样 pilot `bin` 里的 `lark-cli` shim 才能工作，bridge preflight 也不会误报
  “lark-cli is not installed”并因此阻塞飞书投递（协作交棒、artifacts 发布）。

### manifest 字段

`schemaVersion` 必须是 `2`，其它值直接拒绝加载。下面就是 manifest 的真实字段
集：顶层、`hub` 块和一条 `agents[]`。

| 字段                   | 是否必填                | 行为，以及不写时的结果                                                                        |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `schemaVersion`        | 是                      | 必须是 `2`，否则报 `Unsupported pilot config schemaVersion.`                                   |
| `role`                 | 否                      | `all`（默认）、`hub` 或 `worker`。不写即 `all`：本机既跑 Hub 又跑 agent。                      |
| `nodeId`               | 否                      | 本机名字。不写则用 `[Environment]::MachineName`。                                              |
| `larkCliJs`            | 否                      | 显式指定真实 lark-cli 的 JS 入口。不写或 `""` 则自动解析（见上）。                              |
| `commonEnvironment`    | 否                      | 名字→值映射，在 agent 自己的 `launch.environment` 之前应用到所有 agent 进程。                  |
| `unsetEnvironment`     | 否                      | 变量名数组，在应用上面那张映射之前从 agent 环境里删除。                                        |
| `agents`               | 是（至少 1 个 enabled） | agent 名单。至少要有一个 enabled 的 agent。                                                    |
| `hub.publicUrl`        | worker 上必填           | Hub 基地址，结尾 `/` 会被去掉。worker 缺这个字段拒绝启动。                                      |
| `hub.tenantKey`        | worker 上必填           | 共享 tenant key。缺失时回退读 `.runtime\tenant-key.txt`，再缺就启动失败。                       |
| `hub.bindHost` / `hub.host` / `hub.port` | 仅 hub/`all` | **本地** Hub 的监听地址（默认 `127.0.0.1:17321`）。worker 上不读。                              |
| `hub.leaseMinutes` / `hub.maxCausalDepth` / `hub.maxConversationTurns` | 仅 hub/`all` | Hub 侧限额，会写进生成的 `hub-config.json`。worker 上不读。                     |
| `agents[].id`          | 是                      | agent id：Hub 侧身份、task 名、日志文件名前缀、账本目录都用它。                                |
| `agents[].displayName` | 是                      | 注册到 Hub 的显示名。                                                                          |
| `agents[].aliases`     | 否                      | Hub 解析 @ 时可接受的其它名字。不写即没有。                                                    |
| `agents[].enabled`     | 否                      | 不写即启用。`false` 会让该 agent 完全不参与启动、停止和校验。                                   |
| `agents[].runOnThisNode` | 否                    | 不写即在本机运行。`false` 表示不在本机启动它；如果这台机器跑 Hub，它还会把该 agent 留在生成的 `hub-config.json` 里，而 worker 上没有本地 Hub 状态，这个字段就只表示"别在本机启动"。 |
| `agents[].credentialEnv` | 建议填                 | 存放该 agent Hub 凭据的环境变量名。                                                            |
| `agents[].credential`  | 否                      | 内联明文凭据，只在 manifest 里**没有** `credentialEnv` 字段时使用。如果写了 `credentialEnv` 但变量为空，启动会直接失败并报 `Credential environment variable is not set: <name>`，不会回退到 `credential` 或 `agent-tokens.json`。 |
| `agents[].launch.filePath` | 是                   | 要跑的可执行文件（例如 `node.exe`）。必须存在，或能在 PATH 上解析到。                           |
| `agents[].launch.arguments` | 否                   | 参数数组；`${REPO_ROOT}`、`${STATE_DIR}`、`${USERPROFILE}`、`${LOCALAPPDATA}` 和 `%VAR%` 会被展开。 |
| `agents[].launch.workingDirectory` | 否           | 默认仓库根目录；写了就必须存在。                                                              |
| `agents[].launch.environment` | 否                | 每个 agent 的环境变量；在 `commonEnvironment` 之后应用，能覆盖它。                              |
| `agents[].launch.unsetEnvironment` | 否            | 每个 agent 自己的删除项，最后应用。                                                            |
| `agents[].original.stop` / `original.start` | 否    | pilot 接管前、交还 profile 时执行的命令。                                                      |
| `agents[].hermesHook.enabled` / `hermesHook.home` | 否 | Hermes gateway 集成；`enabled` 为 true 时 `home` 必填。                                    |

在这台机器上，只有 `hub.publicUrl` 和 `hub.tenantKey` 两个字段是关于 Hub 的，
其余全是 worker 侧配置。

上面那四个值令牌在 `filePath`、`arguments`、`workingDirectory` 和每个环境变量
值里都会展开。除此之外，worker 启动前环境是被**清空**的：启动器删除一份固定的继承变量
清单（`LARK_CHANNEL`、`LARK_CHANNEL_UNATTENDED`、`LARK_CHANNEL_HOME`、
`LARK_CHANNEL_PROFILE`、`LARK_CHANNEL_CONFIG`、`LARKSUITE_CLI_CONFIG_DIR`、
`LARK_CHANNEL_CODEX_BIN`、`LARK_CHANNEL_NODE_BIN`、`LARK_CHANNEL_ANTIGRAVITY_BIN`、
`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`、`LARK_CHANNEL_ANTIGRAVITY_BRIDGE`、
`LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE`、`DSH_CWD`），然后依次应用
`unsetEnvironment`、`commonEnvironment`，最后是 `launch.environment`。清单之外的变量会
保留，比如 `LARK_CHANNEL_DISABLE_PROXY` 和 `LARK_CHANNEL_LOG_DAYS`；即使这样，worker
也不会继承到另一个 agent 的 profile。

### 凭据从哪里来

启动器按这个顺序为每个 agent 解析一个凭据：

1. `credentialEnv`，在 **Process** 作用域读取；
2. 内联的 `credential`；
3. 本机 `.runtime\agent-tokens.json`（如果存在，属于 Hub 侧状态）。

两个启动入口 `Start-CollabAgent.ps1` 和 `Run-CollabAgentSupervisor.ps1` 都会先在
变量只存在于 User 作用域、当前进程里为空时，把它从 **User** 作用域提到 Process
作用域，这样交互式启动和 Task Scheduler 启动行为完全一致。Machine 作用域从不会
被读。阶段 5 要做的就是这件事：令牌留在 User 作用域，`credentialEnv` 指向它，
manifest 里不留明文 `credential`。

### 校验

```powershell
.\scripts\collab-pilot\Test-CollabPilotConfig.ps1 `
  -Config .\.runtime\worker-sun.local.json
```

它会检查：

- 至少有一个 enabled agent，否则 `No enabled agents are configured.`；
- `dist\cli.js` 存在（仅当本机还要跑 Hub 时）；
- worker 必须有 `hub.publicUrl`，否则 `Worker role requires hub.publicUrl.`；
- 对每个本地 agent：`id` 和 `displayName` 都有值；`launch.filePath` 有值且
  解析出的可执行文件存在（或在 PATH 上）；`launch.workingDirectory` 写了就要
  存在；`hermesHook.enabled` 为真时 `hermesHook.home` 要存在。

成功时打印四行：

```
Config OK: <你的 manifest 绝对路径>
Role: worker
Enabled agents: sun
Hub: http://100.x.y.z:17321
```

有任何问题就通过 `Write-Error` 逐条打印，并以退出码 1 结束。

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
# 应该输出一个正数
```

User 级 env var **跨重启保留**，并且 Task Scheduler 任务和交互 PowerShell
都会继承。新值只对之后启动的进程可见，冒烟测试前先开一个新的 PowerShell。

如果拿到的 worker manifest 里还留着内联 `credential`，在 User 级变量就位后把
那行删掉：环境变量优先级更高，而明文副本只是多一个泄露口。Process 与 User
作用域这个坑的细节见
[`WINDOWS_WORKER_PITFALLS.zh-CN.md`](./WINDOWS_WORKER_PITFALLS.zh-CN.md) 第 5 节。

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

`started in background` 只在真正启动时打印；如果这个 agent 已经在跑，你会看到
`sun is already running (PID …).`。两种情况后面都会接同样的状态块，因为
`Start-CollabAgent.ps1` 最后会为该 agent 调一次状态脚本：

```
Hub health: True
Name  PID   Running Worker   LastError
----  ---   ------- ------   ---------
sun   12345     True node.exe
```

`Running = True` 表示被跟踪的 launcher 进程活着（Hermes agent 则是它的 detached
gateway 能应答）。

从任何能访问 Hub 的机器上，验证 Sun 已经用正确的 `nodeId` 注册：

```powershell
$token = [Environment]::GetEnvironmentVariable('LARK_COLLAB_SUN_TOKEN','User')
$h = [System.Net.Http.HttpClientHandler]::new(); $h.UseProxy = $false
$c = [System.Net.Http.HttpClient]::new($h); $c.Timeout = [TimeSpan]::FromSeconds(5)
$c.DefaultRequestHeaders.Add('Authorization', "Bearer $token")
($c.GetAsync('http://100.x.y.z:17321/v1/agents').GetAwaiter().GetResult()
  .Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).agents |
  Where-Object id -eq 'sun' |
  Format-List id,nodeId,instanceId,lastSeenAt
```

---

## 阶段 7 — 飞书侧冒烟测试

群消息要能到达这个 agent，三件事必须同时成立：

1. Feishu 应用必须拿到群消息权限 `im:message.group_msg`。没有它，平台只推送
   @ 了 bot 的消息，非 @ 的群流量根本不会到达。
2. `requireMentionInGroup: true`（默认值）是**另一个独立开关**：应用能看到全部
   群消息，而 bridge 仍然只回答 @ 了它的消息。非 @ 的消息会被记进账本，但不回。
3. 群必须在该 agent 的 `access.allowedChats` 里。app owner 或 admin 在群里用
   `/invite group`（或 `/invite all group`）开通，或者你把 `chat_id` 加到那个
   profile 的 `access.allowedChats` 后只重启这一个 agent。

然后，在 **Hub owner** 所在的群里打开一个话题（长按某条消息 → "在话题中回
复"），`@Sun ping`。Sun 应该回复。

如果没回复，别在这里重复排查：看
[`WINDOWS_WORKER_PITFALLS.zh-CN.md`](./WINDOWS_WORKER_PITFALLS.zh-CN.md) 第 7–8 节
（凭据 profile 校验、话题根目录规则）、第 15 节（权限）、第 16 节（`denied-chat`
日志意味着**这个群**不在该 agent 的名单里）。

---

## 阶段 8 — 登录自启

有两种形态，不能混用。

**整机任务**（单个 agent，或想用一个 task 同时管 Hub + 所有 agent）：

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -StartNow
```

注册 Task Scheduler 任务 `Lark Collaboration Pilot`：

- 触发器：`AtLogon`，当前用户，interactive logon。
- 动作：跑 `Run-CollabPilotSupervisor.ps1`，它会 15 秒轮询地把
  `Start-CollabPilot` 拉起来（`-PollSeconds` 可调 5–300），进程死了自动重启。
  一个命名 mutex 保证同一 repo+manifest 只有一个 supervisor。
- 设置：`StartWhenAvailable`、失败 ×3 / 1 分钟重跑、不在电池模式停、不限运行时
  长。
- `-StartNow` 先停掉 pilot，再启动任务，所以不会有东西留在任务之外运行。

**每 agent 一个任务**（一台机器跑多个 agent 时推荐）：

```powershell
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 `
  -Config .\.runtime\worker-sun.local.json `
  -Agent sun `
  -StartNow
```

不传 `-TaskName` 时任务名是 `Lark Collaboration Agent sun`；想要一个稳定好读的
名字就传 `-TaskName SunFeishuBridge`。触发器和设置相同，动作换成
`Run-CollabAgentSupervisor.ps1 -Agent sun`：

- **事件驱动**：bridge 健康时它阻塞在 `Wait-Process`（不再 15 秒唤醒），正常情况下只在
  等 Hub 恢复、等凭据补齐、或 agent 退出后重启时才干活（`-CredentialRetrySeconds` 默认
  60 秒，`-RestartSeconds` 默认 5 秒）。例外是脱离了启动器的 Hermes 网关：它没有 launcher
  PID 可等，只能按 `-GatewayCheckSeconds`（10 到 600，默认 60）复查；
- 每次启动前把这个 agent 的**两侧登记都清掉**（`Stop-CollabComponent` 清
  pids.json 里的 launcher 进程树，`Stop-CollabRegisteredBridge` 在**该 agent 的**
  `LARK_CHANNEL_HOME` 下清 bridge 自己的 registry），所以被硬杀过的 bridge 不会
  留下陈旧登记把下次启动卡在“当前 profile 已有 bridge 进程占用”；
- 只动自己这个 agent：`-StartNow` 停的是该 agent，不是整个 pilot。

多个 per-agent 任务在同一时刻登录时一起启动，会有一个问题：注册 per-agent 任务
会调一次 `Stop-CollabAgent.ps1` 清掉该 agent 的登记，所以同一秒启动的两个任务
会串行，其中一个会多等一会儿。几秒内自愈，不需要人工介入。

验证实际注册了什么：

```powershell
Get-ScheduledTask -TaskName 'Lark Collaboration Agent sun' | Format-List TaskName,State
# 如果是整机任务：
Get-ScheduledTask -TaskName 'Lark Collaboration Pilot' | Format-List TaskName,State
```

下次重启 / 重登后，supervisor 会自动把 worker 拉起来。

supervisor 自己也有日志，任务注册成功但 agent 起不来时就看它：整机任务是
`.runtime\logs\supervisor.log`，per-agent 任务是
`.runtime\logs\<agentId>-supervisor.log`。每次启动、每次 Hub 探测失败、每次等
凭据都会记在里面。

卸载：

```powershell
# per-agent 任务（传过 -TaskName 就写那个名字）
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1 -TaskName 'Lark Collaboration Agent sun'
# 整机任务
.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1
```

卸载默认只删掉计划任务，随后停掉整个 pilot；只想“去掉自启、agent 继续跑”就加
`-KeepPilotRunning`。

---

## 本地账本放在哪

每个 bridge 只记录**它自己看到过**的东西（群消息、下载的附件、自己的 bot
结果），append-only，从不同步到 Hub，里面的路径只在这台机器上有意义：

```
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

- 每个 agent 一个根目录：同一台机器上的两个 agent 就和两台机器一样，绝不追加
  到同一个文件；
- 每个话题一个文件：新话题开新账，而不是往一个越来越长的单文件里追加；不在
  任何话题里的聊天消息进 `_chat.jsonl`；
- `run-agent.ps1` 通过 `LARK_COLLAB_NODE_LEDGER_ROOT` 把这个 agent 的进程指向
  它自己的根目录（变量名是历史遗留，值是 per-agent 的）；
- 记录格式是每行一个 JSON 对象，字段有 `id`、`scope`、`recordedAt`、`kind`
  （`message`、`attachment` 或 `bot-result`）以及负载；按记录 id 去重。

### 怎么查回来

agent（和你）用 bridge CLI 查本地账本，不经过 Hub：

```powershell
# 某个群 / 话题的最新记录（默认 12 条，最多 50 条）
node .\dist\cli.js local-context read --scope "<chatId>" --limit 20
node .\dist\cli.js local-context read --scope "<chatId>:<threadId>"

# 关键词检索：每个词都必须出现在记录里
node .\dist\cli.js local-context search --scope "<chatId>:<threadId>" --query "<关键词>"
```

`--scope` 必填，且必须与该记录写入时的 id 完全一致：群级消息用 `chatId`，
话题用 `chatId:threadId`。`--limit` 会被夹到 1–50（默认 12），输出是
`{"scope": …, "records": […]}` 形式的 JSON。agent 运行期间同一个命令以
`lark-channel-bridge` 的名字在 PATH 上，所以提示词里的
`lark-channel-bridge local-context search --scope … --query …` 不用写路径。
查询会同时合并旧的单文件账本和 per-topic 文件，按 `recordedAt` 返回最新的记录。

### 迁移 `topics/` 之前的节点

`topics/` 之前的布局（`<root>\collaboration\local-topic-ledger.jsonl`）仍然会被
**读取**，所以原地升级不丢历史；新记录不会再写进去。因此对某个 scope 做
read/search 仍然能返回它的老记录，但旧文件始终是一个大文件，而你没有查过的
scope 永远不会出现在 per-topic 布局里。

要彻底迁完又不丢历史：先停掉这台机器的 per-agent 任务，把旧文件里的记录按
`scope` 字段分组，逐组追加到
`<root>\collaboration\topics\<chatId>\<threadId>.jsonl`（scope 没有话题部分时写
`_chat.jsonl`），按记录 `id` 去重，然后归档旧文件。逐个 agent 根目录做，绝不
把两个 agent 的记录并进同一个文件。同样的步骤（连同停止命令）见
[`WINDOWS_WORKER_PITFALLS.zh-CN.md`](./WINDOWS_WORKER_PITFALLS.zh-CN.md) 第 13 节。

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
| 同时看 stdout + stderr | `.\scripts\collab-pilot\Get-CollabPilotLog.ps1 -Name sun -Tail 80 -Follow`                      |
| 注册登录自启           | `.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config … -StartNow`                     |
| 删除登录自启           | `.\scripts\collab-pilot\Uninstall-CollabPilotStartup.ps1`                                       |
| 导出另一个 worker manifest（仅 Hub） | `.\scripts\collab-pilot\Export-CollabWorkerConfig.ps1 -Agent moon -HubUrl http://100.x.y.z:17321` |

`Stop-CollabAgent.ps1` 和 `Stop-CollabPilot.ps1` 还接受
`-RestoreOriginal` / `-RestoreOriginals`：协作 bridge 停掉后执行该 agent 配置的
`original.start` 命令，也就是回到接入 pilot 之前的状态。

---

## 一台机器跑多个 agent

每多一个 agent 就多一份 `worker-<id>.local.json`、一个独立 task
（`-Agent <id>`）、一个独立的 User 级 env var（`LARK_COLLAB_<id>_TOKEN`）、一个
独立的 `credentialEnv` 指针；如果 profile 根目录不同还要各自的
`LARK_CHANNEL_HOME`；账本根目录各自在 `.runtime\local-topic-ledger\<id>\`。

把它们当成两台机器：除了 Hub，运行时状态一律不共享。兄弟 agent 挂掉、被停、
被改配置，都不能影响这一个。

```powershell
# 每个 agent 一个 task，互不影响
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config .\.runtime\worker-sun.local.json  -Agent sun  -StartNow
.\scripts\collab-pilot\Install-CollabPilotStartup.ps1 -Config .\.runtime\worker-moon.local.json -Agent moon -StartNow
```

`Install-CollabPilotStartup.ps1 -Agent …` 在不传 `-TaskName` 时任务名默认是
`Lark Collaboration Agent <id>`。整机任务在这里是错的工具：它的 `-StartNow` 会跑
`Stop-CollabPilot.ps1`，把 pilot 当成一个整体驱动，第二个整机任务只会和第一个
互相打架。
