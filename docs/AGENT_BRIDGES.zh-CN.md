# Agent Bridge 配置指南

[返回中文 README](../README.zh.md) | [English](./AGENT_BRIDGES.md) |
[协作设计](./DESIGN.zh-CN.md) | [Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)

## 先回答分支问题

第二台只运行 Worker、绝不启动 Hub 的电脑拉 `release/worker`，按 Worker 部署指南
操作；中心 Hub 电脑用 `release/hub`。开发用对应的 `develop/worker` 或
`develop/hub`。`archive/*` 只用于回退和历史参考。

## 共同前置条件

1. Windows、Git、Node.js 20.12+ 和 pnpm；DeepSeek Harness 建议 Node.js 22+。
2. 每个本地 Agent 已安装并完成自己的登录。
3. 每个机器人一个独立飞书 PersonalAgent 应用。
4. 每个机器人一个独立 `LARK_CHANNEL_HOME` 或 profile，不能共用 App Secret、
   会话锁和进程登记。
5. 仓库已执行 `pnpm install` 和 `pnpm build`。

每个飞书应用都要启用机器人能力和长连接消息事件。App Secret 只进本地加密存储，
不写进脚本和 Git。

## Agent 类型

`--agent` 只接受四种取值：`claude`、`codex`、`antigravity`、`deepseek-harness`，
其他取值在解析 profile 时直接报错。Hermes 不属于这四种，它通过自己的 Hook 接入
同一套协作（见 [Hermes](#hermes)）。

| 类型 | 引擎 | 运行期二进制 | 适配器拼出的命令行 |
| --- | --- | --- | --- |
| `claude` | Claude Code | `PATH` 上字面量 `claude` | `claude -p --output-format stream-json --verbose --permission-mode … --append-system-prompt-file …` |
| `codex` | Codex CLI | profile 中的 `codex.binaryPath` | `codex exec --json --sandbox … -C <cwd> -` |
| `antigravity` | Antigravity CLI（`agy`） | profile 中的 `antigravity.binaryPath` | `agy --input-format stream-json --output-format stream-json --print-timeout … --add-dir <cwd>` |
| `deepseek-harness` | DeepSeek Harness | `deepseekHarness.binaryPath`（Node）加 `deepseekHarness.entryPath` | `node -e <bootstrap> <entryPath>`；由 bootstrap 以 import 方式加载入口 |

这些二进制环境变量是创建 profile 时的输入，不是运行期开关：

| 变量 | 引擎 | 代码读取位置 |
| --- | --- | --- |
| `LARK_CHANNEL_CLAUDE_BIN` | `claude` | 仅首次运行的 Agent 探测；运行永远启动 `claude` |
| `LARK_CHANNEL_CODEX_BIN` | `codex` | 创建与迁移 profile，写入 `codex.binaryPath` |
| `LARK_CHANNEL_ANTIGRAVITY_BIN` | `antigravity` | 创建与迁移 profile，以及首次运行探测；生成的 Windows 服务启动器也会转发它 |
| `LARK_CHANNEL_NODE_BIN` | `deepseek-harness` | 创建 profile，写入 `deepseekHarness.binaryPath` |
| `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` | `deepseek-harness` | 创建 profile，写入 `deepseekHarness.entryPath`；同时决定首次探测是否出现该引擎 |

“创建 profile”既指 `profile create`，也指第一次不得不新建 profile 的 `run`。所以
在 `run` 前临时 export 其中一个变量，只对创建该 profile 的那一次有效。profile
一旦存有解析后的 `binaryPath`，再改这个变量也不影响它：请重新创建或直接修改
profile。唯一的例外是 Claude Code，它根本没有二进制字段；要驱动 `PATH` 之外的
构建，就把它的目录加进 `PATH`。

## 权限模型

每个 profile 只保存一对规范权限：

```json
"permissions": {
  "defaultAccess": "full",
  "maxAccess": "full"
}
```

两个字段取值都是 `read-only`、`workspace`、`full`，顺序为
`read-only < workspace < full`，默认都是 `full`。写入的 `defaultAccess` 不得高于
`maxAccess`；运行策略还会再夹一次，任何一次运行都不会超过 `maxAccess`。

| 解析后的权限 | Codex `--sandbox` | Claude `--permission-mode` |
| --- | --- | --- |
| `read-only` | `read-only` | `plan` |
| `workspace` | `workspace-write` | `acceptEdits` |
| `full` | `danger-full-access` | `bypassPermissions` |

Codex 另外把审批策略固定为 `never`，并完整继承环境变量。可选的
`permissions.claude.permissionMode` 只能把 Claude 收得更紧，而且只在该级别不高于
解析结果时生效，绝不会放宽。`plan` 等于 `read-only`，`default` 和 `acceptEdits`
等于 `workspace`，`bypassPermissions` 等于 `full`。

每次运行都会在运行参数里带上解析后的 `sandbox` 和 `permissionMode`，但
Antigravity 和 DeepSeek Harness 适配器都不读这两个值，所以两者实际都收不到由这对
权限推出的任何参数。Antigravity 只有 profile 里的
`antigravity.dangerouslySkipPermissions`（`--dangerously-skip-permissions`）和
`antigravity.sandbox`（`--sandbox`）两个开关，且创建 profile 时会把
`dangerouslySkipPermissions` 写成 `true`。DeepSeek Harness 则完全不传任何沙箱或
权限参数。

旧版 `sandbox` 块（`default` / `max` / `defaultMode` / `maxMode`，取值
`read-only` / `workspace-write` / `danger-full-access`）仍可作为输入读取，但只在
没有 `permissions` 块时才生效，并被换算到同一套三档权限。它不会被写回：
`config.json` 只持久化 `permissions`，旧块仅作为加载期的输入存在。

## 无人值守交付件

所有由 bridge 启动的 Agent 都是无人值守后台进程。bridge 会设置
`LARK_CHANNEL_UNATTENDED=1`，并向每个已维护 Agent 注入相同的运行约定：用非交互式
库或命令行工具生成交付件，以无界面方式完成校验，再通过飞书回传；协作任务则用
`collab-artifact.cmd publish` 发布。

Agent 不得启动或自动化 WPS、Microsoft Office、文件选择器、保存确认框等交互式桌面
程序。即使窗口设成隐藏，也不得使用 `PowerPoint.Application`、
`New-Object -ComObject`、`win32com` 等 Office/WPS COM 自动化生成、保存、导出或
检查交付件：系统注册的 COM 服务仍可能在用户桌面弹窗。缺少可靠的无界面生成器或
校验工具时，Agent 应明确报告缺失能力，不能要求用户在电脑上接着完成。

四条已维护 Agent 路径统一使用 Hub 生成的同一份协作提示。提示里只给出本地账本
scope 和委派、Artifact 命令的用法，不含历史文件目录。Agent 如需额外一项，用
`collab-artifact.cmd resolve --task TASK --actor AGENT --name "准确文件名"`；
需要枚举该任务可见的 Artifact 时用 `--list`。Hermes 不再自行拼接一份完整历史
提示。

`collab-artifact.cmd publish` 负责整条交付路径。若当前私有 lark-channel 工作区丢失
bot 绑定，命令会在该隔离工作区内按 `bot-only` 自动修复并重试一次，之后才算失败。
Agent 不得拿自身 `.artifacts` 暂存目录冒充交付；只有该发布命令重试后仍失败，才能
报告它的准确错误，也不能因此就让用户重启 Bridge 或运行 doctor。

## Claude Code

前置：Claude Code 已通过交互流程登录，`claude --version` 和普通提问都能正常工作。
Windows 上 `claude` 会解析到 `PATH` 里的 `claude.cmd`。

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\claude'
node .\dist\cli.js run --profile claude --agent claude --workspace C:\workspaces\claude
```

第一次运行会创建并绑定飞书应用，profile 就叫 `claude`。协作清单用同一条命令启动
它，只是换成一个稳定的 Agent ID（例如 `claude`）。

一次运行永远启动字面量命令 `claude`。`LARK_CHANNEL_CLAUDE_BIN` 只被首次运行的
Agent 探测读取，运行期不读。

每次运行适配器拼出的命令是：

```text
claude -p --output-format stream-json --verbose \
  --permission-mode <mode> --append-system-prompt-file <临时文件> \
  [--resume <sessionId>] [--model <model>]
```

prompt 走 stdin，bridge 系统提示写进一次性临时文件，所以任何 `<`、`>` 都不会经过
`cmd.exe`。输出是逐行 `stream-json`：assistant 文本、thinking 和 `tool_use` 块按
顺序变成 bridge 事件，工具结果回填卡片，最后的 `result` 行给出 token 用量和费用，
然后本次运行才标记完成。

Claude 和 Codex 可以续接，Antigravity 和 DeepSeek Harness 无状态。`/resume` 列出
`~/.claude/projects/<编码后的 cwd>` 下的 Claude 会话历史，适配器用 `--resume`
接上所选会话。Codex 的 thread 用 `exec resume --json <threadId> -` 续接。

坑点：目标丢失的 `claude.cmd` 并不会 spawn 失败。它会正常退出，并打印
`is not recognized as an internal or external command`；适配器把这一行 stderr 判成
spawn 失败并杀掉子进程，所以你看到的是真正的原因，而不是一个空回答。

## Codex

前置：Codex CLI 已安装并登录，`codex --version` 可用。非标准安装路径在创建
profile 时设置：

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\codex'
$env:LARK_CHANNEL_CODEX_BIN = 'C:\path\to\codex.cmd'
node .\dist\cli.js run --profile codex --agent codex --workspace C:\workspaces\codex
```

`LARK_CHANNEL_CODEX_BIN`（默认 `codex`）在创建 profile 时读取，解析出的绝对路径
存为 `codex.binaryPath`；之后运行都用存下来的路径。

每次运行适配器拼出的命令是（prompt 走 stdin，末尾 `-` 是 stdin 哨兵）：

```text
codex exec --json --sandbox <mode> \
  -c approval_policy="never" -c shell_environment_policy.inherit="all" \
  [--ignore-user-config] [--ignore-rules] --skip-git-repo-check -C <cwd> \
  [--image <path> ...] [--] -
```

续接运行时全局参数仍在最前，后面接 `resume --json <threadId>` 和同一个 stdin
哨兵。首次运行只有在确实传了图片时才会出现 `--` 分隔符。`--ignore-rules` 默认
开启，所以除非 profile 把 `ignoreRules` 设为 `false`，Codex 会忽略用户的规则文件；
`--ignore-user-config` 默认关闭，`~/.codex/config.toml` 因此仍然生效。除非 profile
设置了 `codex.codexHome`，否则 `CODEX_HOME` 不设置，Codex 沿用 `~/.codex` 下的
登录；只有 `inheritCodexHome` 为 `false` 时才用 profile 内的 home。

输出是 JSONL：`thread.started` 给出 thread id，`agent_message` 条目变成文本，
`command_execution` 条目变成 tool_use/tool_result 对，错误标记跟着进程退出码走，
`turn.completed` 携带用量。没有终止事件就结束的流会被判为失败，而不是静默成功。

只有 Codex 接受图片附件：通过校验的图片文件变成 `--image` 参数，其他适配器都不读
它。`/resume` 通过 `<codex> app-server --listen stdio://` 查询同一工作目录下的近期
thread 列表。

## Google Antigravity

先在可见的交互 PowerShell 里完成 `agy` 登录，后台 bridge 没法替你回答 Google 的
登录提示。`test-agy-print.ps1` 会跑一次 `agy --print`，是验证登录的快捷方式：

```powershell
.\scripts\test-agy-print.ps1
```

```powershell
$env:LARK_CHANNEL_HOME = 'C:\feishu-profiles\antigravity'
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = "$env:LOCALAPPDATA\agy\bin\agy.exe"
node .\dist\cli.js run --profile antigravity --agent antigravity --workspace C:\workspaces\antigravity
```

`LARK_CHANNEL_ANTIGRAVITY_BIN` 在创建 profile 时和首次运行探测时被读取。Windows 上
存在 `LOCALAPPDATA` 时默认是 `%LOCALAPPDATA%\agy\bin\agy.exe`，否则是 `agy`；解析
出的路径存为 `antigravity.binaryPath`。探测没有 `%LOCALAPPDATA%` 兜底，所以依赖
默认路径时请设置该变量，或显式传 `--agent`。

`antigravity` 适配器始终只用 `agy` 协议，不会因为环境变量换成别的 Agent 实现。
每次运行拼出的命令是：

```text
agy --input-format stream-json --output-format stream-json \
  --print-timeout <timeout> [--project <project>] [--model <model>] \
  [--dangerously-skip-permissions] [--sandbox] --add-dir <cwd>
```

prompt 是 stdin 上的一个 `stream-json` 信封。`agy --print` 的等待上限默认 60 分钟，
这是防止遗留进程的安全上限，不是普通任务时限，可在 profile 的
`antigravity.printTimeout` 中覆盖。只有 `agent_response` 步骤更新会变成文本，非
`SUCCESS` 的 result 状态或 `error_message` 步骤会成为本次运行的错误。Antigravity
在做调研、写文档时给不出可靠的增量文本，所以 bridge 不开启 markdown 流，而是完成
后一次性发送最终回复。入站时它也不发“已收到/正在处理”这类合成消息；飞书原生消息
状态和 bridge 的公共运行状态机制对所有 Bot 一视同仁。

Antigravity 是无状态的：没有会话或 thread 身份，无法续接，`/resume` 会说明
`agy --print` 模式没有历史。运行参数里带着解析后的权限值，但适配器不读，也不会据此
传任何权限参数；权限行为只来自 profile 的 `antigravity.dangerouslySkipPermissions`
和 `antigravity.sandbox`，且创建 profile 时会把 `dangerouslySkipPermissions` 写成
`true`。

仓库还附带围绕同一 profile 的薄封装：`run-antigravity-bridge.ps1` 前台运行，
`start-antigravity-bridge-service.ps1` 安装并启动系统后台服务（`start`），
`status-antigravity-bridge.ps1` 查看状态，
`stop-antigravity-bridge-service.ps1` 停止。四个脚本都会把
`LARK_CHANNEL_HOME` 设为 `<repo>\.lark-channel`；只有前台运行和服务安装脚本还会把
`LARK_CHANNEL_ANTIGRAVITY_BIN` 设为 `%LOCALAPPDATA%\agy\bin\agy.exe`，把
`<repo>\bin` 放到 `PATH` 最前，设置 `LARK_CHANNEL_DISABLE_PROXY=1`，并删除
`HERMES_HOME` 与 `HERMES_GIT_BASH_PATH`。这两个脚本还会通过
`scripts\antigravity-proxy-env.ps1` 读取当前 Windows 用户代理：只有在注册表启用了
代理且当前没有代理变量时，才设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和仅
回环的 `NO_PROXY`。

## DeepSeek Harness

DeepSeek Harness 使用独立的 `deepseek-harness` Agent 类型和适配器。入口路径是这个
适配器的配置，不是 Antigravity 的模式开关。

不要把旧 DeepSeek 或 Antigravity bridge 的 `bin` 目录加进该 Agent 的 `PATH`。
Pilot 会在所有清单环境覆盖完成之后，把一个不绑定身份的命令目录放到最前；适配器
再显式传入当前 profile 的 lark-channel 上下文。启动时，只有当前 App 确实写入当前
profile 的私有 target 文件，lark-cli 绑定才算成功；命令返回 0 但写进了其他 profile，
预检同样判失败。

创建 profile 必须同时提供 `deepseekHarness.binaryPath`（Node 可执行文件）和
`deepseekHarness.entryPath`。`LARK_CHANNEL_NODE_BIN`（默认 `node`）和
`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` 提供这两个值，之后运行都用存下来的值。

仓库脚本引导、配置并启动一个名为 `deepseek` 的 profile：

```powershell
.\scripts\bootstrap-deepseek-bridge.ps1
.\scripts\setup-deepseek-feishu.ps1
.\scripts\start-deepseek-bridge-service.ps1
```

`bootstrap-deepseek-bridge.ps1` 需要 Node.js、Corepack，以及（除非传
`-SkipHarness`）Git。它在本仓库执行 `pnpm install --frozen-lockfile` 和
`pnpm build`，在缺少 checkout 时把 `deepseek-harness` 克隆到
`vendor\deepseek-harness`，在那里构建 CLI，并在 `apps\cli\lib\bin.js` 缺失时报错。
`setup-deepseek-feishu.ps1` 询问 App ID，并创建 profile `deepseek`，工作目录为
`<repo>\workspace-deepseek`，`LARK_CHANNEL_HOME=<repo>\.lark-channel-deepseek`。
`start-deepseek-bridge-service.ps1` 如果发现 profile `deepseek` 已登记且存活的
进程，就直接报出 PID；否则以隐藏 PowerShell 宿主进程启动
`run-deepseek-bridge.ps1`：这是脱离终端的常驻前台 bridge，不是任务计划程序服务。
`status-deepseek-bridge.ps1` 列出该 home 的进程登记，
`stop-deepseek-bridge-service.ps1` 结束该 profile 的所有登记项。

`deepseek-harness-env.ps1` 是这些脚本共同 dot-source 的环境准备。它用
`DEEPSEEK_HARNESS_ROOT` 或 `<repo>\vendor\deepseek-harness` 解析 harness 根目录，
要求其中存在 `apps\cli\lib\bin.js`，然后导出 `LARK_CHANNEL_NODE_BIN`（解析到的
`node`）、`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`、`LARK_CHANNEL_DISABLE_PROXY=1` 和
`LARK_CHANNEL_HOME=<repo>\.lark-channel-deepseek`，把 `<repo>\bin` 放到 `PATH`
最前，并删除 `LARK_CHANNEL_ANTIGRAVITY_BIN`、`HERMES_HOME`、
`HERMES_GIT_BASH_PATH`，这样一个 shell 里不会混用两种引擎。

已有 Harness checkout 时：

```powershell
$env:DEEPSEEK_HARNESS_ROOT = 'D:\src\deepseek-harness'
.\scripts\bootstrap-deepseek-bridge.ps1 -SkipHarness
.\scripts\setup-deepseek-feishu.ps1
```

### 适配器以 import 方式加载入口

适配器不把入口当程序运行，它启动的是：

```text
node -e <bootstrap> <entryPath>
```

bootstrap 先把 stdin 缓冲下来，把 `process.argv` 改写成
`[node, <entryPath>, '--profile', 'headless', <prompt>]`，然后才
`await import(<entryPath>)`。所以 prompt 是以一次 headless 运行的位置参数进入
Harness 的，而不是通过 stdin；Harness 的答案是最后一批输出，不是可靠的增量流。
bridge 把这份完成的答案当普通话题回复一次性发出，不开启空的 markdown 流，也不发
合成的入站确认。

这是本引擎最要紧的坑点：只靠

```js
if (import.meta.main) await runCli();
```

派发的模块在被 import 时什么都不会做，因为只有该文件本身是进程入口模块时
`import.meta.main` 才为真。在 bridge 下进程入口是 `-e` 的 bootstrap。官方
`@deepseek-ai/dsh` 包的 `lib/bin.js` 结尾恰好就是这种写法，所以把 `entryPath`
指向它会得到“退出码 0、没有任何输出”的运行，bridge 只会报告一次空的成功运行，
而不是错误。

因此 `deepseekHarness.entryPath` 必须指向一个在 import 之后显式调用导出 CLI 的
shim：

```js
const mod = await import('<resolved>/node_modules/@deepseek-ai/dsh/lib/bin.js');
await mod.runCli();
```

`checkAvailability` 还会以主模块方式运行 `node <entry> --version`，所以 shim 也
必须能回答 `--version`；带守卫的裸 `lib/bin.js` 能通过这项检查，却依然无法服务
一次运行。请让 `LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY`（或 profile 的 `entryPath`）
始终指向你的 shim。

输出解析就是纯 print：stdout 的每一行变成一个文本片段，没有 JSON、工具事件或用量。
该引擎无状态，不会续接，且完全不传沙箱或权限参数。

## Hermes

本项目不会安装、更新或重装 Hermes。协作部署只把
`adapters\hermes\HOOK.yaml` 和 `handler.py` 复制到配置指定的
`HERMES_HOME\hooks\feishu-collaboration-hub`。停止时只删除这个 Hook。Hermes 不是
`--agent` 类型：它没有 bridge 适配器，启动命令完全来自清单。

清单中的 `launch` 应指向现有 venv 的 `python.exe -m hermes_cli.main gateway run`。
启用 `hermesHook` 的 `agents[]` 条目还需要 `hermesHook.home`：Pilot 用它定位 Hook
目录，并复用 `original.start.filePath` 作为 Python 解释器执行
`hermes gateway status` 探测，所以短命启动器退出后，脱离式 Hermes 网关仍能在状态
输出里看到。

Hook 只接受真实 @Hermes 的人类群消息。bot 发来的消息还必须在同一话题中存在待处理
的 Hub dispatch。授权运行时，Hermes 会收到当前 Agent 目录，以及与 Node bridge
相同的 `collab-delegate ask|handoff` 命令约定，所以所有已维护 bot 都能互相委派。
Hook 先把该 dispatch 标记为 accepted，运行结束时为同一个 dispatch 记录结果，再
明确标记 completed 或 failed。

协作群用 Hermes 的群聊 ID 边界，不要逐个用户加白名单：设置
`FEISHU_GROUP_POLICY=open`，保持 `FEISHU_ALLOWED_USERS` 为空，并把获准飞书群的
`oc_...` chat ID 写入 `FEISHU_GROUP_ALLOWED_CHATS`。这样这些群的所有成员都能
@Fool；其他群和私聊仍不在此授权范围内。该配置要求已安装的 Hermes Feishu 适配器
支持 `FEISHU_GROUP_ALLOWED_CHATS`。

## 写入协作清单

先运行 `Setup-CollabPilot.ps1`，再编辑 `.runtime\pilot.local.json`：

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
      "--agent", "deepseek-harness",
      "--workspace", "C:\\workspaces\\deepseek"
    ],
    "workingDirectory": "C:\\workspaces\\deepseek",
    "environment": {
      "LARK_CHANNEL_HOME": "C:\\feishu-profiles\\deepseek",
      "LARK_CHANNEL_NODE_BIN": "node.exe",
      "LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY": "C:\\feishu-profiles\\deepseek\\dsh-entry.mjs"
    }
  }
}
```

`LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY` 要指向上文说的“被 import 就会执行”的入口
模块，而不是带 `import.meta.main` 守卫的包内文件。用 `Test-CollabPilotConfig.ps1`
校验，然后启动整组。完整字段和回退命令见
[Windows 部署与运维](./WINDOWS_OPERATIONS.zh-CN.md)。
