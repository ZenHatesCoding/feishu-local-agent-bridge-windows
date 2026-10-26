# Antigravity 客户端 Worker

[返回 README](../README.zh.md) | [Agent 桥接](./AGENT_BRIDGES.zh-CN.md) | [English](./ANTIGRAVITY_DESKTOP.md)

桌面入口把飞书授权工作交给现有 Antigravity App 项目执行，使用官方 Sidecar、
agentapi 和生命周期 Hook。业务执行和话题记忆整理都不会启动 agy。
客户端需要已安装、已登录，并在当前用户会话中运行。关闭客户端后该 Worker 不可用，
不会静默回退到 CLI。

## 安装

在客户端选择或创建一个包含该 Worker 工作区的专用项目。
项目已有 ID 可在 ~/.gemini/config/projects 的配置中核对。
每个 Bot 分别使用独立的 bridge profile、Sidecar ID、项目绑定和运行目录。

```powershell
.\scripts\collab-pilot\Install-AntigravityDesktopSidecar.ps1 `
  -SidecarId <独立的-worker-sidecar-id> `
  -ProjectId <已有客户端项目-id> `
  -WorkspaceRoot C:\worker\workspace `
  -DesktopRoot C:\worker\runtime\desktop
```

安装器把宿主脚本复制到 DesktopRoot/host，添加具名 Sidecar 和具名 Hook，并保存备份。
已有配置和其他 Hook 保留；不会重启客户端、重置登录、改模型选择、覆盖原生记忆或修改权限策略。
脚本使用 Node.js；Windows Hook 通过无可见窗口的 PowerShell 执行。

在该 Pilot Agent 的 launch.environment 中配置：

```json
{
  "LARK_CHANNEL_ANTIGRAVITY_TRANSPORT": "desktop",
  "LARK_ANTIGRAVITY_DESKTOP_ROOT": "C:\\worker\\runtime\\desktop"
}
```

独立启动时，也可以在 bridge profile 中设置 antigravity.transport=desktop 和 antigravity.desktopRoot。
agentKind 仍为 antigravity。等待 DesktopRoot/heartbeat.json 持续更新，构建 bridge，
再只重启这个 Worker。模型由客户端选择；每轮 CLI 模型覆盖会明确拒绝。
IPC 读取/解析失败只让本轮明确失败；租约定时写入失败由定时器内部捕获，停止续租并隔离本轮，
不会作为未捕获异常使整个 bridge 崩溃。取消文件也写不进去时，仍由 Sidecar 的租约过期边界阻止后续工具。
只有记忆整理默认使用 agentapi 的 flash_lite 档位，避免继承耗时较长的业务模型配置；
安装器可用 MemoryModel=flash_lite/flash/pro 调整。
CLI 的 project、printTimeout 和跳过权限参数不控制客户端执行。

## 执行与边界

每次 bridge 运行创建一个新的客户端会话，使用私有随机绑定。
Sidecar 只接收其绑定项目工作区内的工作；记忆整理为纯数据任务，所有工具均被 Hook 拒绝。
当前 Hub dispatch 和记忆绑定仍逐轮传递，确定性的 Hub 协议不变。

具名 Hook 只匹配这些已绑定会话，不接管用户其他客户端会话的权限。
获授权的 run_command 通过包装器读取该次运行的私有环境，不把凭据写入工具参数。
包装器保留项目范围内的 Cwd，并传递该 Bot 的 profile 和协作命令；Windows 使用非交互 PowerShell。
这些无人值守运行会拒绝交互式提问和申请权限工具；缺少信息或需要批准时，Agent 应在最终答复中说明。

只有 Stop 成功且 fullyIdle 的最终公开 PLANNER_RESPONSE 会回传。
模型与工具生命周期只产生粗粒度活动，不导出推理、工具参数、其他会话或客户端认证令牌。
Sidecar 心跳只表示入口在线，不伪造模型进度。

取消会隔离迟到结果、拒绝后续工具，并终止经命令归属核对的 Windows 包装器进程树。
PostInvocation 会终止已取消的执行循环。已发出的原生模型请求可能先完成才进入此 Hook，
因此不宣称能即时中断服务端请求；不会杀掉客户端。
已完成会话不能沿用旧 dispatch 的环境继续执行工具。

Sidecar 重启保留会话绑定，不重新提交已接受的工作。若提交中途崩溃且无法确认绑定，
明确报告结果不确定，不冒险重复执行。bridge 租约过期会阻止遗留运行继续用工具；
客户端失联会明确失败。

Sidecar 原始的 App language-server 父进程消失后，Sidecar 会自行退出，避免客户端更新留下的
孤儿进程继续抢写心跳、抢领任务并使用失效的客户端地址。排查更新问题时，应确认该 Worker
只有一个父进程存活的 Sidecar，并验证实际工具执行；新鲜心跳本身不能证明客户端 API 可达。

## 运维与回退

DesktopRoot 保存私有请求、绑定、生命周期事件和结果。保持 Git 忽略和 Worker 用户/ACL 边界。
不要发布原始客户端日志或请求文件，其中可能含凭据和敏感任务内容。

回退时先停止该 Worker，移除 desktop 选择（若 profile 和环境都配置，需同时移除），
再用原 CLI 配置启动。卸载集成只禁用对应的具名 Sidecar 和 Hook，保留运行数据与原生会话。
CLI 的代理初始化在 per-agent 环境清理之后执行，避免刚初始化就被删除。

验收应区分客户端隔离测试、真实飞书验收和第二台电脑验收。上线前检查结果回传、
工具环境、取消、Sidecar 恢复、记忆整理和无关会话隔离。

官方接口：[Sidecars](https://antigravity.google/docs/sidecars/)、
[Hooks](https://antigravity.google/docs/hooks/)、
[CLI headless](https://antigravity.google/docs/cli/headless/)。
