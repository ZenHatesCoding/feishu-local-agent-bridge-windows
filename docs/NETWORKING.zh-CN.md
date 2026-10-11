# 多电脑联网与 Tailscale

[返回中文 README](../README.zh.md) | [English](./NETWORKING.md) |
[Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md) |
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)

这里只讲不同电脑之间怎样安全互访。Hub、Pilot、dispatch 等概念见
[概念入门](./COLLABORATION_CONCEPTS.zh-CN.md)，启动命令见
[Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md)。

## 大白话结论

Tailscale 相当于给分散在不同地点的电脑接上一根**加密的虚拟局域网网线**。加入同一
Tailscale 网络的电脑会获得稳定的私网地址，例如 `100.x.y.z`，可以像在同一个路由器
下面一样互相访问。

在本项目中，它只负责联网：

```text
主电脑：Hub + 现有 Bot  ── Tailscale 私网 ── 另一台电脑：新增 Bot
```

Tailscale 不是 Hub，不是 LLM，不保存任务、上下文或交付件，也不代替飞书和 GitHub。

## 为什么先使用它

远程 Bot 必须访问主电脑的 Hub，才能取得同一个 taskId、自己的 dispatch、经过权限
筛选的上下文和 Artifact locator。普通电脑通常位于路由器和防火墙后面，不能直接被
另一地点的电脑访问。传统公网方案还需要公网 IP、端口映射、域名、TLS 证书和防火墙
维护。

Tailscale 为早期部署提供更小的运维面：

- 通常不需要公网 IP 或路由器端口映射；
- 设备之间的链路加密；
- 只有加入相应私网并被访问策略允许的设备才能连接；
- Hub 可以绑定 VPN 网卡地址，不必暴露到整个互联网。

因此项目当前推荐“私网 HTTP + 每 Agent 独立凭据”。Tailscale 保护网络入口，Agent
凭据限制调用身份，两层职责不同，不能互相替代。

## 本项目怎样配置

主电脑继续使用 `role: "all"`，同时运行 Hub 和现有 Bot：

```json
{
  "role": "all",
  "nodeId": "main-pc",
  "hub": {
    "bindHost": "100.x.y.z",
    "publicUrl": "http://100.x.y.z:17321",
    "port": 17321,
    "tenantKey": "one-private-shared-domain"
  }
}
```

额外电脑使用 `role: "worker"` 和同一个 `publicUrl`、`tenantKey`。主电脑可通过
`Export-CollabWorkerConfig.ps1` 为已登记 Agent 导出一份带独立凭据的私密清单。

两个地址职责不同，混用是 worker 连不上的常见原因：

- `hub.bindHost` 是 Hub 本机监听的网卡地址，默认 `127.0.0.1`，只接受本机连接。
  要让远程 worker 访问，必须在这里写 VPN 地址（或写 `0.0.0.0` 监听全部网卡）。
  `hub.host` 是同一字段的旧写法。
- `hub.publicUrl` 是所有 Bridge 和命令行访问 Hub 的地址。省略时 Pilot 会按
  `http://<hub.host>:<hub.port>` 推导，并把 `0.0.0.0` 换成 `127.0.0.1`；这对单机是
  正确的，对 worker 则不正确，所以不要只设 `bindHost` 就以为 worker 能连上。
- `hub.port` 默认 `17321`，同时用于监听和推导出的 URL。

推导 URL 读的是 `hub.host`，不是 `bindHost`。把 `bindHost` 设成 VPN 地址只改变了监听
网卡，不会改变 Bridge 使用的地址，因此服务远程 worker 的中心应同时设置这两个字段。

### 哪些地址必须可达

| 方向 | 从 | 到 | 用途 |
| --- | --- | --- | --- |
| 入站 TCP | worker 节点 | Hub 的 `publicUrl` 主机与端口 | `/health` 探测、提交事件、轮询 dispatch、读取上下文、回执 |
| 出站 | Hub 节点 | 飞书开放接口 | 接收群消息、发送回复、启用时运行 coordinator |
| 出站 | 每台节点 | 飞书开放接口 | 每个 Bridge 以自己的应用身份独立连接 |
| 出站 | 每台节点 | 自己的模型端点 | Agent 推理 |
| 出站 | 发布/接收节点 | GitHub、飞书文件接口或对象存储 | 任务需要文件时上传和下载 Artifact |
| 入站 | 无人 | worker 节点 | worker 完全不需要开放入站端口，Bridge 只主动外连 |

Hub 是控制与元数据通道，Artifact 字节走飞书或 Git，不经过 Hub，所以 Hub 端口不必按
文件传输量规划。

Tailscale 不由本项目安装、升级或配置。它只是取得 `bindHost`/`publicUrl` 中那个地址
的一种方式；项目真正需要的只是一个所有节点都能访问的私网地址。

两台电脑均加入同一 Tailscale 网络后，先在 worker 上验证：

```powershell
Invoke-RestMethod http://100.x.y.z:17321/health
```

返回 `ok: true` 只证明网络和 Hub 可达：`/health` 本身不需要任何凭据。Agent 身份、
群权限与 dispatch 仍需通过 Pilot 预检和飞书真实 `@` 交接验证。

## 代理与环回地址

位于 HTTP 代理后面的 Windows 电脑可能能上网却访问不到本机 Hub。Pilot 和 Bridge 把
这两条路径分开处理：

- `Test-CollabHubHealth` 构造 HTTP 客户端时设置 `UseProxy = $false`，因此 Hub 健康
  探测不会经过 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`。
- 两个示例清单都在 `commonEnvironment` 中设置 `LARK_CHANNEL_DISABLE_PROXY=1`，
  飞书连接因此直连，不再遵循上述代理变量。
- Pilot 的 Antigravity 辅助脚本 `scripts/antigravity-proxy-env.ps1` 读取 Windows 当前
  用户代理，且只作用于该 agent 进程。它写入代理变量时，若 `NO_PROXY` 仍为空就补上
  `NO_PROXY=127.0.0.1,localhost`；若代理变量已存在则直接返回，也不会覆盖已有的
  `NO_PROXY`。
- Pilot 启动器的 `unsetEnvironment` 列表会在 agent 启动前移除 `HTTP_PROXY`、
  `HTTPS_PROXY` 和 `ALL_PROXY`。

如果 worker 能连飞书却连不上 Hub，先检查代理变量和 `bindHost`，再去怀疑 VPN。

## 安全边界

鉴权方式是每个主体一个 Bearer token：Hub 管理 token 存在 `.runtime\hub-token.txt`，
每个 Agent 一个 token 存在 `.runtime\agent-tokens.json`。Hub 从
`LARK_COLLAB_AGENT_TOKEN_<SAFEID>` 读每个 Agent 的 token，其中 `<SAFEID>` 是 agent id
转大写、再把 `[A-Z0-9]` 之外的字符全部换成 `_`。导出 worker 清单时 token 以明文
`credential` 字段写进清单，操作者应把它移到 `credentialEnv` 指定的 User 级变量里，然后
删掉这个字段。除 `GET /health` 之外的所有路由都要求其中之一，比较前先校验长度并使用恒定
时间比较，两个凭据相同则 Hub 拒绝启动。Agent 凭据只能以自己的 Agent 身份操作。

Hub 走明文 HTTP，本项目没有 TLS 监听，所以传输的私密程度完全取决于它所在的网络。
任何能访问该端口的人都能从流量中读到 token，并据此冒充对应主体。网络准入属于鉴权
边界的一部分，请按这个前提操作：

- 优先把 `bindHost` 设为主电脑的 VPN 网卡地址；只有需要多个可信私网接口时才监听
  `0.0.0.0`。
- 不要把 Hub 的裸 HTTP 端口直接映射到公网。
- worker 导出清单和 `.runtime\agent-tokens.json` 含凭据，必须保持 Git 忽略并私下传输；
  worker token 应放进 `credentialEnv` 指定的用户作用域环境变量，而不是提交进仓库的文件。
- Tailscale 账号、设备审批和 ACL 由网络所有者管理；离职、丢失或废弃设备应及时移除。
- Hub 的身份名册只存在内存中，重启会丢失所有已注册的飞书 `open_id`，需要各 Bridge
  重新连接后再注册。Hub 重启后出现“找不到 @ 目标”属于预期现象，不要当成身份故障。
- 正式公网部署仍需要 HTTPS、凭据轮换、限流、审计和可靠存储，这些目前都不存在。

Hub 管不住的事情不要假定它管得住：它限制了请求体大小（256 KiB），但没有 Artifact
大小限制、没有限流、除 JSONL 账本外没有审计，而且任何有效凭据都能通过
`GET /v1/agents` 列出全部 Agent 名册。

## 可替换方案

Tailscale 不是项目硬依赖。WireGuard、企业 VPN、同一可信局域网或配置完整的 HTTPS
入口都可以提供 Hub 可达性。无论选择哪种网络，项目协议仍保持一个逻辑中央 Hub、
每台电脑一个本地 Bridge、每 Agent 独立凭据。

## 常见排查顺序

1. 两台电脑是否都在线并能看到对方的 VPN 地址；
2. Hub 是否监听在预期地址：远程 worker 调用时 `bindHost` 不能仍是 `127.0.0.1`；
3. worker 能否访问 Hub `/health`；
4. 主电脑 Pilot 是否显示 `Hub health: True`；
5. worker 的 `publicUrl`、`tenantKey` 和 Agent 凭据是否来自同一个中心；
6. 对应 Bot 的飞书 profile 是否允许目标群，真实 `@` 是否能到达；
7. 再检查 dispatch、Agent 日志和模型端点，不把网络故障混同为模型登录故障。
