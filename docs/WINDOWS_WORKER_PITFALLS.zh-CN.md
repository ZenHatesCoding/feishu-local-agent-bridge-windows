# Windows Worker 踩坑清单（真实案例）

[返回 README](../README.zh.md) |
[English](./WINDOWS_WORKER_PITFALLS.md) |
[返回 Windows Operations](./WINDOWS_OPERATIONS.zh-CN.md)

这里记的是把一台 Windows 机器接成 Hub worker 时真实撞到的坑（本次是一台双
agent 的机器：Sun 用 Claude Code，Moon 用 DeepSeek Harness，连远端 Hub）。
每条都写明已经在 pilot 脚本里合入的修法，下一台机器照搬就行。

> 下面的例子假设仓库放在 `C:\feishu-local-agent-bridge`，用 Windows
> PowerShell 5.1。Hub 地址统一写成 `100.x.y.z`，自己替换。

---

## 1. PowerShell PATH 里没有 `node.exe`

报错：

```
Stop-CollabAgent.ps1 : 无法将node.exe识别为 cmdlet、函数、脚本文件或可运行程序的名称。
```

`pnpm install` 把 Node 装在用户解压时选的目录里。**启动侧**脚本从 manifest 读
`launch.filePath`，不受影响；**停止侧**脚本直接写 `node.exe`，依赖 PATH。
Scheduled Task 触发时会撞上同一个坑：新开的 `powershell.exe` 继承的 PATH 可能
跟用户 shell 不一样。

修法（已合入 `Pilot.Common.ps1::Stop-CollabRegisteredBridge`）：

- 从 manifest 读 `agents[*].launch.filePath`；只要该路径存在就直接用，绝对路径和
  相对路径一视同仁。
- 否则回退到 `(Get-Command node.exe -ErrorAction SilentlyContinue).Source`。
- 两条都不成立就打 warning，跳过 bridge 内的 kill。wrapper-pid 兜底仍然安全。

启动侧建议在 worker 配置里把 `launch.filePath` 写成**绝对路径**：

```json
"launch": {
  "filePath": "C:\\node-v22.10.0-win-x64\\node.exe",
  ...
}
```

只在 bash 里改 PATH（`.bashrc` 里的 `/c/node-v22.10.0-win-x64:...`）**不会**
传给 `Start-Process` 的子进程。

---

## 2. `Test-CollabHubHealth` 在 Win PS5.1 报 `TypeNotFound`

Windows PowerShell 5.1 上的报错：

```
Test-CollabHubHealth: cannot find type [Net.Http.HttpClientHandler]
```

`System.Net.Http` 是 .NET Standard 程序集，Windows PowerShell 5.1 不会预加载它。
PowerShell 7+ 会自动加载，5.1 必须显式 `Add-Type`。

修法（已合入 `Pilot.Common.ps1::Test-CollabHubHealth`）：

```powershell
if (-not ('System.Net.Http.HttpClientHandler' -as [type])) {
  try { Add-Type -AssemblyName 'System.Net.Http' } catch { }
}
```

`Pilot.Common.ps1` 在 dot-source 时也会探测一次 `System.Net.Http.HttpClient`，
所以只要脚本加载了这个库，后面的调用就有程序集可用。该函数重试 3 次，每次
间隔 1 秒（见坑 #3）。

---

## 3. 从这台机器到 Hub 的 `/health` 是间歇性的

症状：偶发 `Start-CollabAgent.ps1` 抛 `Remote Hub is unavailable: …`，但同一个
Hub 在新开 shell 里用 `Invoke-WebRequest` 5/5 都能连上。timeout 太短会把真实的、
短暂的 TCP 抖动当成故障。

修法（已合入 `Pilot.Common.ps1::Test-CollabHubHealth`）：

- `for ($attempt = 1; $attempt -le 3; $attempt++)`：尝试 3 次，失败后
  `Start-Sleep -Seconds 1`。
- 每次尝试都新建 `HttpClientHandler`（`UseProxy = $false`）和 `HttpClient`，
  所以陈旧的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 不会影响 loopback 探测。
- 第一次拿到 `ok` 为真的 JSON 就 return true。

单次请求的 timeout 由调用方传 `-TimeoutSeconds`。函数参数默认 5 秒，实际调用分别
传 1 秒（Hub 启动轮询）、2 秒（status）、3 秒（start/supervisor 的 Hub 门槛）。
如果 Hub 在 Tailscale 后面，**不要**把这些值再调小：交互唤醒时 Tailscale NAT
重协商偶尔会短暂阻塞连接。

---

## 4. `LARK_CHANNEL_HOME` 必须指向真实存在的 profile 根目录

症状：

```
Error: 当前没有配置，非交互模式无法完成扫码创建应用。
```

`resolveAppPaths().rootDir` 默认是 `C:\Users\<you>\.lark-channel`。如果在 worker
配置里覆盖 `LARK_CHANNEL_HOME`，**新路径必须存在并且下面有 `profiles/<name>/`
子目录**。指向空目录（比如 `C:\feishu-profiles\claude`）时，bootstrap 会抛出上面
引用的那条报错，因为那里找不到 profile。

自检：

```powershell
Test-Path C:\Users\<you>\.lark-channel\profiles\claude\secrets.enc   # 必须是 True
Get-Content C:\Users\<you>\.lark-channel\active-profile               # 内容是 'claude'
```

本次安装的做法：把 `.runtime/worker-<agent>.local.json` 里的
`launch.environment.LARK_CHANNEL_HOME` 写成 `C:\Users\<you>\.lark-channel`
（即**真正的**默认路径），或者干脆不写，让 bridge 自己默认。

---

## 5. `credentialEnv` 在 `Process` scope 读，不是 `User`

`Pilot.Common.ps1::Get-CollabAgentToken` 里写的是：

```powershell
[Environment]::GetEnvironmentVariable([string]$Agent.credentialEnv, 'Process')
```

`setx LARK_COLLAB_<agent>_TOKEN <value>` 写到的是 **User** scope。新起的
PowerShell 进程会在启动时把 User 级变量加载进自己的进程环境块，所以 Task
Scheduler / `Start-Process` 的子进程在 `Process` scope 里拿得到。但**干净启动的
`powershell.exe -File Start-CollabAgent.ps1` 偶尔**拿不到 `Process` 级副本，因为
有些 shell 会丢掉注册表来源的环境变量。

修法（已合入 `Start-CollabAgent.ps1`，`Run-CollabAgentSupervisor.ps1` 里的
`Import-CredentialFromUserScope` 是同一套逻辑）：

```powershell
if ($agentConfig.credentialEnv -and -not [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'Process')) {
  $userValue = [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'User')
  if ($userValue) {
    [Environment]::SetEnvironmentVariable($agentConfig.credentialEnv, $userValue, 'Process')
  }
}
```

这样手动启动和定时任务启动走同一路径。这两处都不读 Machine scope，而
`Get-CollabAgentToken` 自己也不会回退到 User scope：提升没跑，凭据就是没有。
supervisor 的凭据判断直接问 `Get-CollabAgentToken`，而不是只看 `credentialEnv`，
所以 manifest 里的 `credential` 和 `agent-tokens.json` 也算数，只有全部来源都
为空时它才会等。

---

## 6. 两个 bridge 抢同一个 profile 锁

症状：

```
当前 profile 已有 bridge 进程占用；非交互模式无法确认停止，请先用
lark-channel-bridge ps 查看并用 lark-channel-bridge kill <bot id> 停止后重试
```

profile（或 app）锁还被占着，通常是上一次 Stop 没清干净。下一次启动会直接拒绝，
不会卡住。

恢复方式：

```powershell
# registry 是按 LARK_CHANNEL_HOME 分家的：要切到该 agent 真正用的 home，
# 否则列表是空的，而它的 bridge 明明还在跑。
$env:LARK_CHANNEL_HOME = 'C:\Users\<you>\.lark-channel'
node C:\feishu-local-agent-bridge\dist\cli.js ps

# 用上面 ID 列打印的短 id 杀掉
node C:\feishu-local-agent-bridge\dist\cli.js kill <id>
```

正规做法仍然是让 pilot 脚本替你解析 home：
`Stop-CollabAgent.ps1 -Agent <id>`。或者更暴力：

```powershell
Get-CimInstance Win32_Process -Filter 'Name="node.exe"' |
  Where-Object { $_.CommandLine -like '*dist\cli.js*' -and $_.CommandLine -like '*--profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

凡是换 `LARK_CHANNEL_HOME`、或同一台机器同时跑多个同名 profile agent
之前，都要先 Stop 干净。

---

## 7. Feishu App 凭证要先在 lark-cli 里 bind

启动期会打印这条 warning：

```
lark-cli is not installed
lark-cli is the Feishu/Lark command-line tool. After installation, the agent can…
(non-interactive mode; skipping auto-install)
```

**不是错误**，但有两点含义：

1. 没装 `lark-cli`，bot **没法读消息历史、发附件、列群成员**。话题里的
   `@Sun` 只有在消息直接 @ Sun 时才生效；走 Hub 委派给其他 agent 同样会受影响：
   提交本身走 Hub REST 接口，但模型调用的 shim 依赖 lark-cli，
   `collab-delegate.cmd reply|handoff|ask` 需要 `LARK_COLLAB_REAL_LARK_CLI_JS`，
   并通过 lark-cli 发出真正的 @；`collab-artifact.cmd publish` 也硬依赖它。
   只有 bridge 内部的 marker 路径不需要 lark-cli：模型输出
   `collaboration_reply`、`collaboration_ask` 或 `collaboration_handoff` 标记，
   由 bridge 自己渲染出 @。
2. `npm install -g @larksuite/cli` 在 Windows 上偶尔会 `rmdir` 失败
   （Trae / Cursor / VS Code 占着目录），需要关掉 IDE 再装，或者加 `--force`。

在怪到引擎之前先确认这一层：`run-agent.ps1` 会把
`LARK_COLLAB_REAL_LARK_CLI_JS` 指向真实入口，并把 pilot 的 `bin` 目录放到
`PATH` 最前面，shim 因此能找到它。如果还是报这条 warning，说明自动解析没找到。
按 [WINDOWS_OPERATIONS](./WINDOWS_OPERATIONS.zh-CN.md) 里 `pilot.larkCliJs` 的
说明处理。

---

## 8. 群**根消息**里的 `@Sun` 不会被 Hub 路由

Worker-mode 的 collab 特性（`/v1/agents`、`submit`、dispatch）只在消息落在
Feishu **话题**（`omt_…` threadId）里才生效。直接发在群根的 `@Sun` 走 bridge
本地路径；能回复，但不会触发 Hub 派发。

要测端到端：

1. 打开群。
2. 长按某条消息 → "在话题中回复"。
3. 在话题里 `@Sun <prompt>`。

---

## 9. Hub `/workers` 不带 worker token 返回 401

症状：

```
Invoke-WebRequest http://100.x.y.z:17321/workers
401 Unauthorized
```

Hub 上并没有 `/workers` 这个路由。不带 token 时 `GET /health` 正常应答，其余
一律 401，未知路径则是 404。真正要看的是 `/v1/agents`（Hub 上已经注册的身份
列表）。从 worker 机器上用该 agent 自己的 token 就能读：

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

`/v1/agents` 列的是**已注册**的身份，所以 `sun` 只有在它的 bridge 连上并注册之后才会
出现。这里没有心跳：`lastSeenAt` 是最后一次注册的时间，不是存活信号，所以跑了一整天的
bridge 显示的仍是它启动时的时间。从没起过的 agent 不在列表里，bridge 已停的会留一条
过期记录。`sun` 出现且 `nodeId/instanceId` 是你机器上的值，说明 collab 模式端到端打通了。

---

## 10. `worker-sun.local.json` 是 git-ignored 的本机清单

仓库已经忽略 `.runtime/`。**不要**把 `worker-sun.local.json` 跨机器拷贝：里面
有机器特定的 `nodeId`、`launch.filePath`、`launch.workingDirectory`、
`launch.arguments`（含 `--workspace`）、`launch.environment`
（`LARK_CHANNEL_HOME`），以及 `credentialEnv` 指针。可携带配置的最小单元是本机
manifest 加 User 级 env var。

---

## 11. 怎么确认 wrapper → wrapper → node 的 env 链路没断

如果怀疑 wrapper 在传给 `node.exe` 的过程中丢了 `LARK_COLLAB_*` 变量，
塞一个 probe 跑同一套链路：

```javascript
// .runtime/env-probe.js
const want = ['LARK_COLLAB_HUB_URL','LARK_COLLAB_HUB_TOKEN','LARK_COLLAB_TENANT_KEY',
              'LARK_COLLAB_AGENT_ID','LARK_COLLAB_NODE_ID','LARK_COLLAB_INSTANCE_ID'];
const out = {};
for (const k of want) {
  const v = process.env[k];
  out[k] = v ? (k === 'LARK_COLLAB_HUB_TOKEN' ? `<set len=${v.length}>` : v) : '<empty>';
}
console.log(JSON.stringify(out, null, 2));
```

确认完就删掉。`.runtime/` 在 gitignore 里，但留个 probe 没好处。

---

## 12. Scheduled Task 触发器：`AtLogon` 是默认，`AtStartup` 是个陷阱

`Install-CollabPilotStartup.ps1` 注册的是 `AtLogon -User <you>` +
`LogonType Interactive`，所以 bot **只在用户登录后才启动**。这是对的，原因有
两个：

1. User 级 env var（`LARK_COLLAB_SUN_TOKEN`）在用户登录时才会被注入到 Process
   scope。
2. `~/.lark-channel` 是 per-user 的，SYSTEM 上下文任务访问不到。

改成 `AtStartup` 的话，要么直接失败（没有 logon 会话、没有 profile），要么必须
存凭据，这就**泄露了用户密码**。**别这么干**。如果"开机自起"真的要求登录前
启动，正确做法是给 bot 单独开一个 service account 加自己的 profile，不要去改
触发器类型。

---

## 13. 账本要 **每个 agent 一份**，还要 **每个话题一个文件**

本地"观察到的群消息"账本以前是**每台机器一个文件**、而且所有话题挤在一个文件
里。在一台跑多 agent 的机器上：

- 共用文件让每个 agent 都把同一条群消息各追加一份，N 个 agent 就长 N 倍；
- 单个无限增长的文件把所有话题混在一起。

现在是：

```
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

`run-agent.ps1` 把 `LARK_COLLAB_NODE_LEDGER_ROOT` 指向
`.runtime\local-topic-ledger\$Agent`（环境变量名是历史遗留，语义已经是 per
agent），bridge 则按 scope 一个文件：话题（`chatId:threadId`）写上面那个
话题文件，普通群消息写 `_chat.jsonl`。每个 scope 内按记录的 `id` 去重，所以
同一条消息被重复观察到不会写两遍。

旧的单文件路径（`<root>\collaboration\local-topic-ledger.jsonl`）仍然**会被
读取**：查询时会把旧文件和当前话题文件一起读，所以原地升级不丢历史；新记录
不再写进去。这个账本是节点本地的：只记录这个 bridge 实际观察到的内容，不会
同步到 Hub。

升级已有节点：

```powershell
# 先停掉 agent 的 task 再动账本
Stop-ScheduledTask -TaskName FeishuBridgeSun
Stop-ScheduledTask -TaskName FeishuBridgeMoon
# 按记录的 `scope` 分组、按 `id` 去重，再分别追加进各 agent 根目录下的
# <agentRoot>\collaboration\topics\<chatId>\<threadId>.jsonl（迁移说明见下）
```

判断标准：**没有 `scope` 的记录无法迁移**。每条记录都带自己被抓到的 scope，
scope 就是 `chatId` 或 `chatId:threadId`。写入方一定会写 `scope` 和 `id`；
丢弃发生在读取方：scope 与请求的不一致、或没有 `id` 的记录会被跳过，所以迁移后
保留的正好是当前读取逻辑能返回的部分。内容迁完之后把旧文件归档（本次留在
`.runtime\archive\ledger-pre-topics\`）。

---

## 14. `$ErrorActionPreference = 'Stop'` 下，原生 CLI 的 stderr 会直接杀死脚本

症状：supervisor 退出码 1，日志停在 "start: …" 之后的下一步，而同一个脚本
手工跑却没事。`Start-CollabAgent.ps1`、`Stop-CollabAgent.ps1` 和两个 supervisor
都设了 `$ErrorActionPreference = 'Stop'`，而 Windows PowerShell 5.1 里**把原生命令的
stderr 重定向会把它变成 terminating error**：

```powershell
# CLI 把"没找到"写到 stderr 时，这行会致命：
& node $cli kill $id *> $null

# 安全：不重定向时 stderr 只是屏幕文本，退出码也读得到
& node $cli kill 1
if ($LASTEXITCODE -ne 0) { Write-Warning "…未登记，走后备路径" }
```

`dist\cli.js kill <id>` 在 registry 里找不到该 id 时会往 **stderr** 打
`✗ 没找到匹配的 bot:<id>` 并退出 1，硬杀过 bridge 之后这是**正常**结果。两条
规则：

1. 不要自己重写"清 bridge 登记"，直接调
   `Pilot.Common.ps1::Stop-CollabRegisteredBridge`：它会先切到该 agent 自己的
   `LARK_CHANNEL_HOME`，清掉该 agent 的 registry 条目，并且把"登记不存在"当
   warning。stop 侧和 start 侧都已经替你调好了（`Stop-CollabAgent.ps1`，以及
   per-agent supervisor 里的 `Clear-AgentRuntime`），正常运维不需要手写 kill。
2. 非要在 `$ErrorActionPreference = 'Stop'` 下跑原生命令，就不要重定向它的
   stderr，或者单独把这一次调用的 preference 降下来。

相关：bridge CLI 的 registry 位置来自 `LARK_CHANNEL_HOME`
（`<home>\registry\processes.json`），而且这个变量在命令执行**之前**就被读走了，
所以有独立 home 的 agent 必须先导出它：

```powershell
$env:LARK_CHANNEL_HOME = 'C:\Users\<you>\.lark-channel-<agent>'
node C:\feishu-local-agent-bridge\dist\cli.js kill 1   # 1 = 该 registry 里的第一条
```

不导出的话，CLI 去看的是另一个 agent 的 registry，然后对一个明明存在的 id
报 "not found"。

---

## 15. 飞书权限 `im:message.group_msg` 才决定 bot 能不能**看到**群消息

两个独立开关，很容易混：

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| `im:message.group_msg` 权限 | 飞书应用（授权范围） | bot **收得到**所有群消息（不论是否 @它） |
| `requireMentionInGroup: true` | bridge profile | bot **只回复** @了它的消息 |

没有这个权限，非 @ 的群消息根本到不了 bridge，平台只推送 @bot 事件。在
飞书/lark-cli 这一侧，`+chat-messages-list` 会报权限错误（`230027`，或形如
`99991672` 的 API 错误）；本仓库并不调用这个接口，所以这条现象来自 lark-cli。
用增量授权补，不用碰 app secret：

- 在群里直接操作：在 `/config` 里把"群里需要 @ bot"关掉。bridge 会检查该权限，
  缺了就发一张一键增量授权卡片，只用 app id + tenant scopes 拼链接。
- 等价的离线做法：

```javascript
// .runtime/grant-group-msg-scope.mjs —— 生成 scope-grant.json + 一张二维码 PNG
import { registerApp } from '@larksuite/channel';
await registerApp({
  source: 'lark-channel-bridge',
  appId: '<cli_…>',
  addons: { scopes: { tenant: ['im:message.group_msg'] } },
});
```

然后让应用 owner 扫码。**不要在 payload 里带 `appSecret`**：带了会走另一条流程，
启动器随后报 "应用不存在"。

想保持"全都看得到、只有 @ 才回复"，就保留 `requireMentionInGroup: true`。权限
补齐后，白名单群里非 @ 的消息仍然会进账本，因为 bridge 在 mention 策略**之前**
就记录了这条消息。

---

## 16. `intake/skip-not-allowed-user` + `reason: denied-chat` 是误导性日志

群里一条 @bot 的消息可能被丢掉，而日志看起来像**用户**的问题：

```json
{"event":"intake/skip-not-allowed-user","scope":"oc_…","sender":"…","reason":"denied-chat"}
```

真实含义是：这个**群**不在该 profile 的 `access.allowedChats` 里，同时发送者
既不是应用 owner 也不是管理员。不是这个人没权限。日志里 sender 只保留后六位，
所以要按 `scope`/`reason` 判断，别按用户判断。两种正规开群方式：

1. 群内自助：应用 owner 或管理员 @bot 发 `/invite group`（或 `/invite all group`）。
2. 把 `chat_id` 加进该 profile `config.json` 的 `access.allowedChats`，然后重启
   **那个** agent。

不要整体拷贝另一个 agent 的 `allowedChats`。属于某个 agent 的群（比如只给 Claude
的群）必须留在另一个 agent 的白名单之外。只加你验证过的那一个 id。

---

## 17. 无 hub 机器上的 worker 群：除了 Hub 什么都不共享

一台机器跑多个 agent 时，把它们当成在不同机器上。每个 agent 的这些东西都必须
独立：

| 项目 | 每 agent 的值 |
| --- | --- |
| manifest | `.runtime\worker-<id>.local.json` |
| task | `Install-CollabPilotStartup.ps1 … -Agent <id> -TaskName <Name>` |
| supervisor | `Run-CollabAgentSupervisor.ps1 -Agent <id>`（事件驱动，健康时完全空闲） |
| 凭据 | User 级 `LARK_COLLAB_<ID>_TOKEN` + manifest 里的 `credentialEnv` |
| profile 根目录 | 不共用一个 profile 时各自的 `LARK_CHANNEL_HOME` |
| 账本 | `.runtime\local-topic-ledger\<id>\` |

只有 Hub 的 URL / tenant key 是共享的。任何"停掉/重启/改配置"都必须限定在自己
这个 agent：per-agent task 的 `-StartNow` 停的是该 agent 而不是整个 pilot，一个
agent 的崩溃循环绝不能把邻居带下水。逐个 agent 用
`Status-CollabPilot.ps1 -Agent <id>` 和 `/v1/agents`（见 §9）核对。

---

## 18. npm 装的 `@deepseek-ai/dsh` 被 bridge import 时根本不会跑

DeepSeek Harness 引擎入口（`node_modules\@deepseek-ai\dsh\lib\bin.js`）是 ESM，
结尾是：

```javascript
if (import.meta.main) await runCli();
//#endregion
export { runCli };
```

`import.meta.main` 只在**该文件本身**是进程入口时为真。bridge adapter 用的是
`node -e` 引导脚本，把入口当**模块** import
（`await import(pathToFileURL(entry).href)`），于是 import 成功、立刻返回、进程
以 0 退出且没有任何输出，bot 就静默什么也不回。

修法：profile 指向一个显式调用导出函数的 shim：

```javascript
// ~/.lark-channel-<agent>/dsh-entry.mjs
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const mod = await import(pathToFileURL(entry).href);
await (mod.runCli ?? mod.default?.runCli)();
```

然后在 agent 的 `launch.environment` 里把 `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`
指向这个文件，并验证：

```powershell
node C:\Users\<you>\.lark-channel-<agent>\dsh-entry.mjs --version   # 必须打印版本号
```

adapter 运行期启动的 node 来自 profile 里的 `deepseekHarness.binaryPath`，这个值在
创建 profile 时由 `LARK_CHANNEL_NODE_BIN` 写入：如果这个 harness agent 用的不是全局
那个 `node.exe`，就要在创建 profile 时把 `LARK_CHANNEL_NODE_BIN` 指向 shim 解析
`node_modules` 时所用的同一个解释器；profile 已经存在的话，这个变量不再生效，需要
修改或重建 profile。注意 `--version` 只证明入口能加载，`node <entry> --version` 直接跑入口
一样会打印版本号；"引擎退出码 0 但没有任何输出"才是这个坑，不是飞书的问题。

---

## 19. Windows PowerShell 5.1 既没有 `[Convert]::ToHexString` 也没有 `RandomNumberGenerator::GetBytes(int)`

症状：在 Hub 机器上（`role: all` 或 `hub`），`Start-CollabPilot.ps1`、
`Start-CollabHub.ps1`、`Start-CollabAgent.ps1` 在写出
`hub-token.txt`、`tenant-key.txt`、`agent-tokens.json`、`hub-config.json` 之前就失败：

```
Method invocation failed because [System.Convert] does not contain a method named 'ToHexString'.
Method invocation failed because [System.Security.Cryptography.RandomNumberGenerator] does not contain a method named 'GetBytes'.
```

`[Convert]::ToHexString` 是 .NET 5 才有的，静态的
`RandomNumberGenerator.GetBytes(int)` 是 .NET Core 3.0 才有的。而计划任务跑的是
`powershell.exe`，也就是 .NET Framework 4.8 上的 Windows PowerShell 5.1，两者都不存在。
worker 角色不会踩到（它在生成 hub 状态之前就 return 了），所以只有 Hub 机器会直接
起不来。

修法（已在 `Pilot.Common.ps1::New-CollabHexSecret`）：用
`[Security.Cryptography.RandomNumberGenerator]::Create()` 建实例，用实例重载
`GetBytes(byte[])` 填 `byte[]`，再用
`[BitConverter]::ToString($bytes).Replace('-','')` 转十六进制。这几个 API 在 5.1 和 7
上都有，所以同一份脚本在两种解释器下都能用。有单元测试盯着，防止有人再把 .NET 5+
专属调用写回来。

自查：`powershell.exe -NoProfile -Command "[Convert]::ToHexString([byte[]]@(1,2))"`
在 5.1 上失败、在 `pwsh` 上成功。

---

## 20. "每个 agent 一个 supervisor"必须认识三种凭据来源，以及脱离的 Hermes 网关

在"保活一个 agent"的循环里，两个存活判断很容易写错：

1. 只看 `credentialEnv` 的 Process 作用域。agent 完全可以用 manifest 里的内联
   `credential`，或者用 `.runtime\agent-tokens.json`；认这套优先级的是
   `Get-CollabAgentToken`。只看环境变量的判断会在一个配置正确的 agent 上永远等待，
   每次重试都打印"凭据未设置"。
2. 只要 `pids.json` 里没有 launcher PID 就重启。脱离的 Hermes 网关在**没有 launcher**
   的情况下是健康的：`Start-CollabAgent.ps1` 会故意删掉自己的 PID 记录。没有网关检查
   的 supervisor 会每几秒重跑一次启动流程，和用户自己的服务打架。

修法（已在 `Run-CollabAgentSupervisor.ps1`）：改成问 `Get-CollabAgentToken`（捕获它的
报错）而不是读某一个变量；重启之前，对 manifest 里 `hermesHook` 打开的 agent 先查
`Test-CollabHermesGateway`，并按较慢的 `-GatewayCheckSeconds`（默认 60）复查。其他引擎
保持事件驱动的 `Wait-Process` 路径。

---

## 21. 写在 `collaboration/` 之外的 Hermes 账本永远不会被读到

症状：Hermes agent 在飞书里答了，但
`lark-channel-bridge local-context read --scope <chatId:threadId>` 对该话题返回空记录，
而同一台机器上的 Claude/DeepSeek bridge 有记录。

Hook 以前往 `<root>/local-topic-ledger.jsonl` 追加，而读取方解析的是
`<root>/collaboration/topics/<chatId>/<threadId>.jsonl`（以及旧单文件
`<root>/collaboration/local-topic-ledger.jsonl`）。目录不同，两边碰不上；换成
per-agent 根目录之后更是不可能碰面。

修法（已在 `adapters/hermes/handler.py::_record_local_topic`）：写进
`<root>/collaboration/topics/<安全化的 chatId>/<安全化的 threadId>.jsonl`，记录字段
（`id`、`scope`、`recordedAt`、`kind`、`messageId`、`senderId`、`content`）与 TypeScript
账本一致，两段路径都做安全化。Hook 的契约测试盯着这个位置，防止再次漂移。

验证：把 `LARK_COLLAB_NODE_LEDGER_ROOT` 指向一个临时目录运行 hook，再用
`local-context read` 读该 scope。
