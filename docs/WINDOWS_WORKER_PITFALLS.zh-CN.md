# Windows Worker 踩坑清单（真实案例）

[返回 README](../README.zh.md) |
[English](./WINDOWS_WORKER_PITFALLS.md) |
[返回 Windows Operations](./WINDOWS_OPERATIONS.zh-CN.md)

本文件汇总在 `zpomenmax` 这台机器上把 Sun 接成 Hub worker 实际撞到的坑。
每条都标注了已经在 pilot 脚本里合入的修法，下一台机器照搬就行。

> 下面例子假设仓库放在 `C:\feishu-local-agent-bridge`，使用 Windows
> PowerShell 5.1。

---

## 1. PowerShell PATH 里没有 `node.exe`

报错：

```
Stop-CollabAgent.ps1 : 无法将node.exe识别为 cmdlet、函数、脚本文件或可运行程序的名称。
```

`pnpm install` 把 Node 装在自定义目录里。**启动侧**脚本因为从 manifest
里读 `launch.filePath` 而不受影响，但**停止侧**脚本直接写 `node.exe`，
依赖 PATH。同一个坑也会在 Scheduled Task 触发时出现——新开的
`powershell.exe` 继承的 PATH 跟用户 shell 的不同。

修法（已合入 `Pilot.Common.ps1::Stop-CollabRegisteredBridge`）：

- 从 manifest 读 `agents[*].launch.filePath`；如果是绝对路径且存在，
  优先用它。
- 否则回退到 `(Get-Command node.exe -ErrorAction SilentlyContinue).Source`。
- 都没有就 warn，跳过 bridge 内 kill，让 wrapper-pid 兜底。

启动侧建议直接把 `launch.filePath` 写绝对路径：

```json
"launch": {
  "filePath": "C:\\node-v22.10.0-win-x64\\node.exe",
  ...
}
```

只在 bash 里改 PATH（例如 `.bashrc` 加 `/c/node-v22.10.0-win-x64`）不会
传给 `Start-Process` 的子进程。

---

## 2. `Test-CollabHubHealth` 在 Win PS5.1 报 `TypeNotFound`

报错：

```
Test-CollabHubHealth: cannot find type [Net.Http.HttpClientHandler]
```

`System.Net.Http` 是 .NET Standard 程序集，**Windows PowerShell 5.1 默认不
预加载**。PowerShell 7+ 会自动加载，5.1 必须显式 `Add-Type`。

修法（已合入 `Pilot.Common.ps1::Test-CollabHubHealth`）：

```powershell
if (-not ('System.Net.Http.HttpClientHandler' -as [type])) {
  try { Add-Type -AssemblyName 'System.Net.Http' } catch { }
}
```

顺手把这个函数改成 **3 次重试、每次 5 秒超时**（见坑 #3）。

---

## 3. 从这台机器到 Hub 的 `/health` 是间歇性的

症状：偶发 `Start-CollabAgent.ps1` 抛 `Remote Hub is unavailable: …`，但
同一个 Hub 在新开 shell 里用 `Invoke-WebRequest` 5/5 都能连上。3 秒
timeout 把真实的、短暂的 TCP 抖动当成了故障。

修法（已合入 `Pilot.Common.ps1::Test-CollabHubHealth`）：

- 单次 `HttpClient.Timeout` = 5 秒（调用方原来传 2s，脚本里写死 3s）。
- 3 次重试，每次间隔 1 秒。
- 第一次拿到 `{"ok":true}` 就 return true。

如果 Hub 在 Tailscale 后面，**不要**把 timeout 再调小——交互唤醒时
Tailscale NAT 重协商偶尔会短暂阻塞连接。

---

## 4. `LARK_CHANNEL_HOME` 必须指向真实存在的 profile 根目录

症状：

```
Error: 当前没有配置，非交互模式无法完成扫码创建应用。
```

`resolveAppPaths().rootDir` 默认是 `C:\Users\<you>\.lark-channel`。如果
在 worker 配置里覆盖 `LARK_CHANNEL_HOME`，**新路径必须存在并且下面有
`profiles/<name>/` 子目录**。把它指向空目录（比如 `C:\feishu-profiles\claude`
这种全新建但空的目录）会静默启动失败。

自检：

```powershell
Test-Path C:\Users\zhenp\.lark-channel\profiles\claude\secrets.enc   # 必须是 True
Get-Content C:\Users\zhenp\.lark-channel\active-profile                # 内容是 'claude'
```

本次安装的做法：把 `.runtime/worker-<agent>.local.json` 里的
`launch.environment.LARK_CHANNEL_HOME` 写成 `C:\Users\<you>\.lark-channel`
（即真正的默认路径），或者干脆不写，让 bridge 自己默认。

---

## 5. `credentialEnv` 在 `Process` scope 读，不是 `User`

`Pilot.Common.ps1::Get-CollabAgentToken` 里写的是：

```powershell
[Environment]::GetEnvironmentVariable([string]$Agent.credentialEnv, 'Process')
```

`setx LARK_COLLAB_<agent>_TOKEN <value>` 写到的是 **User** scope。Task
Scheduler 启动的进程会把 User 级变量提升到 Process 级，但**干净启动的
`powershell.exe -File Start-CollabAgent.ps1` 偶尔**会因为 shell 不同
而拿不到 Process 级副本。

修法（已合入 `Start-CollabAgent.ps1`）：

```powershell
if ($agentConfig.credentialEnv -and -not [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'Process')) {
  $userValue = [Environment]::GetEnvironmentVariable($agentConfig.credentialEnv, 'User')
  if ($userValue) {
    [Environment]::SetEnvironmentVariable($agentConfig.credentialEnv, $userValue, 'Process')
  }
}
```

这样手动启动和定时任务启动走同一路径。

---

## 6. 两个 bridge 同时绑同一个 profile 会死锁

症状：

```
当前 profile 已有 bridge 进程占用；非交互模式无法确认停止，请先用
lark-channel-bridge ps 查看并用 lark-channel-bridge kill <bot id> 停止后重试
```

两个 bridge 进程抢同一个 `~/.lark-channel/profiles/<name>/` 就会卡住。
通常是因为上一次 Stop 半残。

恢复方式：

```powershell
# 看 Sun 在 registry 里登记的所有 bot
node C:\feishu-local-agent-bridge\dist\cli.js ps
# 用短 id 杀掉
node C:\feishu-local-agent-bridge\dist\cli.js kill 5428
```

或者更暴力：

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

1. 没装 `lark-cli`，bot **没法读消息历史、发附件、列群成员**——意味着
   `@Sun` 必须**直接 @ Sun** 才能触发，bot 自己从消息流里翻消息的路径
   会断。
2. `npm install -g @larksuite/cli` 在 Windows 上偶尔会 `rmdir` 失败
   （Trae / Cursor / VS Code 占着目录），需要关掉 IDE 再装，或者加
   `--force`。装完之后 `where lark-cli` 应有路径。

---

## 8. 群**根消息**里的 `@Sun` 不会被 Hub 路由

Worker-mode 的 collab 特性（`/v1/agents`、`submit`、dispatch）只在消息
落在 Feishu **话题**（`omt_…` threadId）里才生效。直接发在群根的
`@Sun` 走的是 bridge 本地路径——能回复，不会触发 Hub 派发。

要测端到端：

1. 打开群。
2. 长按某条消息 → "在话题中回复"。
3. 在话题里 `@Sun <prompt>`。

---

## 9. Hub `/workers` 不带 worker token 返回 401

```
Invoke-WebRequest http://100.108.87.97:17321/workers
401 Unauthorized
```

这是预期——`/v1/agents`（Hub 端的 worker 注册列表）需要 Hub token。从
worker 机器上用 Sun 自己的 token 就能验证自己确实注册了：

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

`sun` 出现在列表里，且 `nodeId/instanceId` 是你机器上的值，说明 collab
模式端到端打通了。

---

## 10. `worker-sun.local.json` 是 git-ignored 的本机清单

仓库已经忽略 `.runtime/`。**不要**把 `worker-sun.local.json` 跨机器拷
贝——里面包含机器特定的 `nodeId`、`workspace`、`launch.filePath`，外加
（隐式）`credentialEnv` 指针。本机 manifest + User 级 env var 才是
"可携带配置"的最小单元。

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
`LogonType Interactive`，意味着 bot **只在用户登录后才启动**。这是
对的，原因有两个：

1. User 级 env var（`LARK_COLLAB_SUN_TOKEN`）在用户登录时才会被
   注入到 Process scope。
2. `~/.lark-channel` 是 per-user 的，SYSTEM 上下文任务访问不到。

如果改成 `AtStartup`，要么直接失败（没有 logon 会话、没有 profile），
要么必须存凭据——这就**泄露了用户密码**。**别这么干**。如果
"开机自起"真的要求登录前启动，正确做法是给 bot 单独开一个 service
account 加自己的 profile，不要去改触发器类型。

---

## 13. 账本要 **每个 agent 一份**，还要 **每个话题一个文件**

本地"观察到的群消息"账本以前是**每台机器一个文件**、而且所有话题挤在一个文件
里。在一台跑多 agent 的机器上这两半都是错的：

- 共用文件让每个 agent 都把同一条群消息各追加一份，N 个 agent 就长 N 倍；
- 单个无限增长的文件把所有话题混在一起。

现在是：

```
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\<threadId>.jsonl
<repo>\.runtime\local-topic-ledger\<agentId>\collaboration\topics\<chatId>\_chat.jsonl
```

`run-agent.ps1` 把 `LARK_COLLAB_NODE_LEDGER_ROOT` 指向
`.runtime\local-topic-ledger\$Agent`（环境变量名是历史遗留，语义已经是 per
agent）。旧的单文件路径仍然**会被读取**，所以原地升级不丢历史；新记录不再写进去。

升级已有节点：

```powershell
# 先停掉 agent 的 task 再动账本
Stop-ScheduledTask -TaskName SunFeishuBridge
Stop-ScheduledTask -TaskName MoonFeishuBridge
# 用一小段 Node 脚本按记录的 `scope` 分组，按 id 去重后分别写进
# <新根目录>\collaboration\topics\<chatId>\<threadId>.jsonl，每个 agent 根目录各做一遍
```

判断标准：**没有 `scope` 的记录无法迁移**。每条记录都带自己被抓到的 scope，
scope 就是 `chatId` 或 `chatId:threadId`。

---

## 14. `$ErrorActionPreference = 'Stop'` 下，原生 CLI 的 stderr 会直接杀死脚本

症状：supervisor 退出码 1，日志停在 "releasing existing bridge registration …"
这一行之后，而同一个脚本手工跑却没事。start / stop 两侧脚本都设了
`$ErrorActionPreference = 'Stop'`，而 Windows PowerShell 5.1 里**把原生命令的
stderr 重定向会把它变成 terminating error**：

```powershell
# CLI 把"没找到"写到 stderr 时，这行会致命：
& node $cli kill $id *> $null

# 安全：不重定向时 stderr 只是屏幕文本，退出码也读得到
& node $cli kill 1
if ($LASTEXITCODE -ne 0) { Write-Warning "…未登记，走后备路径" }
```

`lark-channel-bridge kill <id>` 在 registry 里找不到该 id 时会往 stderr 打
`✗ 没找到匹配的 bot:<id>` 并退出 1 —— 硬杀过 bridge 之后这是**正常**结果。两条
规则：

1. 不要自己重写"清 bridge 登记"，直接调
   `Pilot.Common.ps1::Stop-CollabRegisteredBridge`：它会先切到该 agent 自己的
   `LARK_CHANNEL_HOME`，并且把"登记不存在"当 warning。
2. 非要在 `$ErrorActionPreference = 'Stop'` 下跑原生命令，就不要重定向它的
   stderr，或者单独把这一次调用的 preference 降下来。

相关：`lark-channel-bridge kill` 只能清掉它解析得到的 registry。registry 在
`LARK_CHANNEL_HOME`（默认 `~/.lark-channel`）下面，**不在** agent 自己的 home
下；所以有独立 home 的 agent 必须先导出这个变量再调 CLI，否则 CLI 去看的是另一个
agent 的 registry，然后对一个明明存在的 id 报 "not found"。

---

## 15. 飞书权限 `im:message.group_msg` 才决定 bot 能不能**看到**群消息

两个独立开关，很容易混：

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| `im:message.group_msg` 权限 | 飞书应用（授权范围） | bot **收得到**所有群消息（不论是否 @它） |
| `requireMentionInGroup: true` | bridge profile | bot **只回复** @了它的消息 |

没有这个权限，非 @ 的群消息根本到不了 bridge，`+chat-messages-list` 也会报飞书
`230027`（权限不足）或 `99991672`。用增量授权补，不用碰 app secret：

```javascript
// .runtime/grant-group-msg-scope.mjs —— 生成 scope-grant.json + 一张二维码 PNG
import { registerApp } from '@larksuite/channel';
await registerApp({
  source: 'incremental',
  appId: '<cli_…>',
  addons: { scopes: { tenant: ['im:message.group_msg'] } },
});
```

然后让应用 owner 扫码。**不要在 payload 里带 `appSecret`**：带了会失败并报
"应用不存在"。

想保持"全都看得到、只有 @ 才回复"，就保留 `requireMentionInGroup: true`——权限
补齐后，非 @ 消息仍然会进账本（bridge 在 mention 策略之前就记录）。

---

## 16. `intake/skip-not-allowed-user` + `reason: denied-chat` 是误导性日志

群里一条 @bot 的消息可能被丢掉，而日志看起来像**用户**的问题：

```json
{"event":"intake/skip-not-allowed-user","reason":"denied-chat","chatId":"oc_…"}
```

真实含义是：这个**群**不在该 profile 的 `access.allowedChats` 里（同时发送者既不是
应用 owner 也不是管理员）——不是这个人没权限。两种正规开群方式：

1. 群内自助：应用 owner 或管理员 @bot 发 `/invite group`（或 `/invite all group`）。
2. 把 `chat_id` 加进该 profile `config.json` 的 `access.allowedChats`，然后重启
   **那个** agent。

不要整体拷贝另一个 agent 的 `allowedChats`——属于某个 agent 的群（比如只给 Claude
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

DeepSeek Harness 引擎入口（`node_modules/@deepseek-ai/dsh/lib/bin.js`）是 ESM，
结尾是：

```javascript
if (import.meta.main) await runCli();
```

`import.meta.main` 只在**该文件本身**是进程入口时为真。bridge adapter 用
`await import(entry)` 引导引擎，于是 import 成功、立刻返回、进程以 0 退出且没有
任何输出——bot 就静默什么也不回。

修法：profile 指向一个显式调用导出函数的 shim：

```javascript
// ~/.lark-channel-<agent>/dsh-entry.mjs
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')).href);
await (mod.runCli ?? mod.default?.runCli)();
```

然后在 agent 的 `launch.environment` 里把 `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`
指向这个文件，并验证：

```powershell
node C:\Users\<you>\.lark-channel-<agent>\dsh-entry.mjs --version   # 必须打印版本号
```

"引擎退出码 0 但没有任何输出"就是这个问题，不是飞书的问题。