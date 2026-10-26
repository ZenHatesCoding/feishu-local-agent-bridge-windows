# Worker 话题记忆：使用与运维

[返回中文 README](../README.zh.md) | [English](./WORKER_MEMORY.md) |
[设计与验收合同](./plans/WORKER_TOPIC_MEMORY.zh-CN.md) | [Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)

## 能力与边界

每个逻辑 Bot 实例独立保存 SQLite 账本、当前任务状态、历史摘要和来源关系。
飞书话题跨新的模型会话保持连续；模型、昵称和 cwd 不决定记忆边界。
Hub 不运行归纳模型、不保存本地记忆，也不向同机 Worker 提供特殊磁盘访问。

实现包含自动加载、checkpoint、后台与执行前整理、分层摘要、来源展开、累计检索预算、
固定约束校验、挂起待办、失败重试、版本恢复及 legacy 导入。本机自动化与宿主验证不等于
另一台电脑完成了飞书真实验收；旧 Worker 需要更新同一代码版本。

完整账本是本 Worker 获准观察到的内容，不是所有群消息。未投递消息和归属未知的旧记录
不能当成已知背景。不会将原始思维链或凭据作为任务记忆收集。

## 启用和配置

Pilot 默认启用本机 Bot 的记忆。`all` 与 `worker` 使用同一机制，后者不会为记忆启动 Hub。
实例根为 `<pilot-state>/worker-memory/<agent-id>`；新的 JSONL 也按实例分开，旧共享账本原位保留。
独立 bridge 使用 `LARK_MEMORY_ENABLED=1`；`LARK_MEMORY_ROOT` 可覆盖 profile 推导的实例根。

根目录包含 identity.json、memory.sqlite、blobs、宿主 skills、bindings 和 jobs。不同 Bot 不能
共用同一个实例根。搬迁保留身份；克隆成新 Bot 使用新根。这些目录不能提交 Git。

Pilot 顶层或单个 Agent 可配置：

```json
{
  "memory": {
    "enabled": true,
    "maxMemoryTokens": 12000,
    "maintenance": { "backgroundEnabled": true }
  }
}
```

总预算支持 4000–128000，约束记忆包和本轮检索，不代表宿主整个模型窗口。
使用包含包装的保守 UTF-8 字节界，不按中文字符数除以四。默认状态/摘要/近期/累计检索预留
约 3000/4000/3000/2000，包装也计入总量，必要时减少可选摘要。有效关键约束不机械截断。

后台关闭后不执行空闲与结果后整理；执行前仍可为保证历史覆盖做必要整理。维护使用原模型和登录，
每小时默认最多 8 次模型调用，每个任务最多一次结构修正，额度持久化。失败从五分钟开始退避；
相同覆盖范围/版本反复失败时指数退避，最长六小时，原文保留。维护使用较小的完整来源批次，
不截断原文冒充已覆盖。未变的固定状态由代码保留，模型可以省略；修改仍需新的用户证据，
并通过严格的 checkpoint 校验。Harness 维护只读取最终 JSON 结果，不把推理或工具事件
写入记忆结果，也不把模型推理附在维护错误中。
Harness Worker 可以设置 `LARK_MEMORY_HARNESS_PATCH`，指向自己的本地 Cordis 配置覆盖文件。
仅维护调用通过宿主官方 `--patch` 选项加载它，可选择快速、非思考配置而不改变业务会话。
需同时配置提供方支持的思考参数格式和模型能力；单独写 `off` 可能只是省略参数，
仍会启用提供方默认的思考模式。本地端点和凭据引用保留在 Git 忽略的部署文件中。

## Agent 工具

普通群和话题使用同一套有界记忆：普通群 scope 是 chat ID，话题 scope 是 `chatId:threadId`。
获准的无 @ 消息先记账，再执行回复门槛。若平台只投递 @ 事件，存在真实覆盖缺口，
本地存储或归纳不能凭空补回未收到的内容。

每轮自动注入 worker_topic_memory，包含状态、近期记录、摘要、来源 ID、挂起数量和覆盖情况。
各宿主有自己的 SKILL.md，安装在 Worker 自有目录，记忆包提供路径，最小运行规则始终注入。
不会覆盖用户全局 AGENTS.md、CLAUDE.md、SOUL.md 或原生记忆。

```text
lark-channel-bridge memory read
lark-channel-bridge memory search --query "报告页数"
lark-channel-bridge memory inspect --id <source-id>
lark-channel-bridge memory expand --id <source-id> --offset 0
lark-channel-bridge memory checkpoint --file candidate.json
```

Node 命令自动绑定本轮。Hermes 每条命令添加 Hook 给出的 `--binding "<binding-file>"`，
不使用会在并行话题间串用的全局绑定。Node 的旧 local-context read/search 绑定调用转发到同一只读接口。
检索先给索引，再展开原文，分页和累计额度跨 shell 子进程保持。长原文分片，并保存完整文本 blob。

checkpoint 结构：

```json
{
  "baseRevision": 1,
  "through": 4,
  "items": [{
    "itemId": "report-length", "kind": "constraint", "text": "报告三页",
    "status": "active", "sourceRefs": ["<actual-event-id>"],
    "evidenceLevel": "human-explicit", "pinned": true
  }],
  "summary": "用户明确更正页数，原要求和更正可查回。"
}
```

来源必须真实存在，推进覆盖需要摘要，版本、来源、预算和固定约束都会校验。
用户决定、Agent 报告和工具观察分别标记，不能伪造验证。有新的用户来源才能更改/撤销固定约束。
被移出当前状态的未完成待办保存成可检索的 parked 条目，不会自动算作完成。

## 失败与宿主边界

空输出、非法结构、假来源、编码损坏、过期版本和超限不发布半成品；不以截断冒充成功摘要。
维护输出不进入飞书发送或 Hub 动作解析。Claude/Hermes 维护关闭工具，Codex 使用只读 sandbox；
agy/Harness 保留宿主权限边界，不提供操作系统强隔离承诺。维护不注入协作凭据或业务 Bridge 提示。

未整理内容能完整放进近期窗口时继续运行；否则先整理，仍无法覆盖则明确阻止依赖旧历史的执行。
Node 将该次已接受 dispatch 标记 failed，消息仍保留。CLI 内部工具循环/session 压缩由宿主负责。

## 诊断、迁移与恢复

在未绑定的独立 shell 中运维：

```powershell
node .\dist\cli.js memory status --root <instance-root> --owner <agent-id> --tenant <tenant-key>
node .\dist\cli.js memory doctor --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread>
node .\dist\cli.js memory migrate --root <instance-root> --owner <agent-id> --tenant <tenant-key> --file <legacy.jsonl>
node .\dist\cli.js memory export --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread> --file <new-export.jsonl>
node .\dist\cli.js memory backup --root <instance-root> --owner <agent-id> --tenant <tenant-key> --file <new-snapshot.sqlite>
node .\dist\cli.js memory rollback --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread> --revision 0
```

status 展示观察/整理范围、版本、错误与退避、挂起事项和 legacyUnattributed，默认不输出正文/凭据。
jobs 保留维护输入和候选，属于 Worker 私有诊断数据。

默认只导入能确认属于当前实例的记录；其他行计入未知归属，旧文件保留。确认整份文件的归属和可见性后
才可使用 `--confirmed-owner`，不能按共享账本所在目录猜作者。重复导入幂等，损坏行不当成事实。

回滚建立新版本，不删除原文，不改 Hub 负责人。revision 0 清空派生状态以便重建。
数据库备份使用一致性 SQLite snapshot；完整实例搬迁还应保留 identity 和 blobs。

```powershell
.\scripts\collab-pilot\Restart-CollabAgent.ps1 -Agent <agent-id>
```

此命令真正重启实例；Hermes 会先停止对应 detached gateway、确认退出，再安装 Hook 和拉起，
不会仅复制文件后继续使用旧 Python 模块。不会重装 Hermes、清空登录或覆盖原生记忆。
禁用记忆后重启可恢复原 local-context 行为，原账本/数据库/Artifact 均保留。
Node 22.13+ 使用内置 SQLite；Node 20 使用固定版本的可选 better-sqlite3 驱动，必须成功安装。
