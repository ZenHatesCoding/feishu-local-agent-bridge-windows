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