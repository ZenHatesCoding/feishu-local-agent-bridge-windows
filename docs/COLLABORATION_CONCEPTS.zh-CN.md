# 多 Agent 协作概念入门

[返回中文 README](../README.zh.md) | [English](./COLLABORATION_CONCEPTS.md) |
[设计原理](./DESIGN.zh-CN.md) | [跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
[Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)

本文用尽量直白的语言解释项目中的 Bot、Agent、Bridge、Hub、Pilot、dispatch、
账本、上下文和产物。它回答“这些东西分别是什么”，协议细节见
[设计原理](./DESIGN.zh-CN.md)，当前可执行命令见
[Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)。

## 先把整个系统想成一家公司

| 项目概念 | 大白话比喻 | 真正负责的事情 |
| --- | --- | --- |
| 飞书群和话题 | 办公室和项目讨论串 | 人可见的消息、文件和真实 `@` 通知 |
| Bot | 员工的飞书账号 | 以一个明确身份收发飞书消息 |
| Agent / LLM | 真正干活的员工 | 分析、写代码、制作文档和调用工具 |
| Bridge | 员工与飞书之间的服务员 | 把飞书消息交给 Agent，再把结果发回飞书 |
| Hub | 不会思考的项目秘书 | 记任务、发工作单、检查交接、筛选上下文 |
| Pilot 脚本 | 开门、关门和安排工位的管理员 | 启停 Hub/Bot、注入配置、保存 PID 和日志 |
| Ledger | 项目流水账 | 依次记录消息、负责人、工作单、结果和文件 |
| Dispatch | 正式工作单 | 指明哪个 Agent 被授权完成什么目标 |
| Context | 给接手者的交接包 | 当前目标、已接受结论和可见历史 |
| Artifact | 公共文件柜中的交付件 | PPT、Word、PDF、图片等文件及其完整性信息 |

## Hub 不是 LLM

Hub 不调用模型，不理解自然语言，也不会自己挑选“最合适”的 Agent。它是一个
TypeScript 小服务器，由三部分组成：

1. HTTP API：Bridge 用它提交事件、领取工作单和读取上下文；
2. 固定规则：普通 `if/else` 和状态机检查谁能接手、咨询、完成或读取；
3. 追加式账本：把发生的事情依次写入 `.runtime\collaboration.jsonl`。

例如用户发送 `@World 分析这个项目`，Hub 不理解“分析”的含义。它只识别：这是
人类消息、目标是 World，于是把 World 设为负责人并创建 dispatch。真正理解要求并
工作的是 World 背后的 Codex、Claude 或其他 Agent。

当前实现位置：

- HTTP 路由：[`src/collab/server.ts`](../src/collab/server.ts)
- 任务规则和状态投影：[`src/collab/hub.ts`](../src/collab/hub.ts)
- JSONL 账本：[`src/collab/ledger.ts`](../src/collab/ledger.ts)
- 交接提示封装：[`src/collab/context.ts`](../src/collab/context.ts)

## Dispatch 是正式工作单

飞书 `@` 和 Hub dispatch 是两把不同的钥匙：

```text
飞书真实 @ = 按门铃，让目标 Bot 收到通知
Hub dispatch = 预约单，证明目标 Agent 被授权工作
```

目标 Bridge 必须同时看到真实通知和发给自己的待处理 dispatch 才会运行。只有文本
里的 `@Chariot` 没有授权，只有 Hub 记录没有飞书通知也不会物理唤醒 Bot。这能避免
随口提到某个 Bot 就触发工作，也能阻止 Bot 之间无限互相唤醒。

一张工作单的正常状态是：

```text
pending -> accepted -> completed
                    \-> failed
```

Hub 用固定规则检查工作单确实属于当前 Agent、父工作单仍有效、当前负责人有权交接，
而不是让模型靠自觉遵守。

## Ledger 是流水账，Context 是交接包

Ledger 保存完整事实，例如：

```text
1. 用户创建任务并 @World
2. World 成为负责人
3. Hub 创建发给 World 的 dispatch
4. World 接受并返回分析结论
5. World 正式 handoff 给 Chariot
6. Chariot 接受并交付文件
```

Context 不是整本账本的粗暴复制。Hub 先按任务参与关系和可见性过滤，再由 Bridge
把允许看到的内容包装成 `collaboration_context`。接手者通常获得用户要求、已接受
结论、风险、交付件和本次目标，但不会获得另一个 Agent 的私有思维链、秘密或无关
任务。

一个飞书话题对应一个任务，因此话题 A 不会自动进入话题 B 的提示词。

## Artifact 是交付件，不只是路径文字

当前单机 Pilot 会把文件快照到：

```text
.runtime\artifacts\<taskId>\<sha256>\<file-name>
```

Hub 记录文件名、类型、本机路径、大小、SHA-256 和可用的飞书消息/文件标识。
SHA-256 类似文件指纹，用于去重和检查文件是否损坏。同一台电脑上的后续 Agent 可以
直接读取这个稳定快照。

这里也解释了当前跨电脑的最大限制：电脑 A 的 `C:\...` 路径对电脑 B 没有意义。
未来必须把共享协议改成可下载的 artifact ID/远程 locator，并在每台机器落成本机
缓存。详细方案见[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。

## Pilot 是运维脚本，不参与思考

Pilot 是 `scripts\collab-pilot` 下的一组 PowerShell 脚本。它负责：

- 读取被 Git 忽略的本机清单；
- 生成 Hub token、tenant key 和运行配置；
- 启动、检查和停止 Hub 与各个 Bridge；
- 给每个 Agent 注入自己的身份、工作区和环境变量；
- 保存 PID、stdout/stderr 日志和回退命令；
- 在需要时恢复原来的独立 Bridge。

所以两者的区别是：

```text
Pilot：把所有程序正确启动和停止
Hub：程序运行期间管理任务和交接
```

当前 Pilot 默认认为 Hub 和所有 Agent 都在同一台 Windows 电脑上。这是跨电脑部署
需要修改 Pilot 的根本原因，而不是飞书本身不允许异地 Bot。

## 一次真实工作的完整链路

```text
用户在飞书 @World
  -> World Bridge 收到消息
  -> Bridge 向 Hub 登记消息
  -> Hub 记账、设置负责人并创建 dispatch
  -> Bridge 领取 dispatch 和可见 context
  -> World 背后的 LLM 思考和工作
  -> Bridge 把最终结果写回 Hub
  -> Bridge 以 World 身份回复飞书
```

如果 World 要交给 Chariot：

```text
World 先向 Hub 提交 handoff
  -> Hub 校验并创建 Chariot dispatch
  -> World 在同一飞书话题真实 @Chariot
  -> Chariot Bridge 同时检查通知与 dispatch
  -> Chariot 取得筛选后的交接包并继续工作
```

只有“LLM 思考和工作”这一步使用模型；Hub、Pilot 和账本都是普通程序。

## 账本、内存和 Token 会不会一直增长

当前版本会增长，但三种增长不同：

- **磁盘**：JSONL 账本和 artifact 快照目前没有自动归档或保留期限；
- **Hub 内存**：启动时会重放全部账本，运行时也保留任务、dispatch 和幂等索引；
- **Bot token**：不同话题互不污染，但同一个长期话题目前会把全部可见事件再次加入
  交接上下文，因此越聊越贵。

Agent 自己恢复的模型 session/thread 还可能与 Hub 历史重复，这是另一层 token
增长。短任务通常没有问题，长期话题则需要“完整原始账本 + 带来源序号的摘要检查点
+ 最近事件”，并把完成很久的任务从热内存移入归档。不能直接静默截断中间历史，
否则可能丢失已经确认的决定。

这些是明确的未来改进项，不应被误解为当前已经实现。具体阶段和验收标准见
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)。
