# 多电脑联网与 Tailscale

[返回中文 README](../README.zh.md) | [English](./NETWORKING.md) |
[Windows 运维](./WINDOWS_OPERATIONS.zh-CN.md) |
[跨电脑路线图](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md)

本文只解释不同电脑怎样安全访问同一个 Hub。Hub、Pilot、dispatch 等概念见
[概念入门](./COLLABORATION_CONCEPTS.zh-CN.md)，具体启动命令见
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

两台电脑均加入同一 Tailscale 网络后，先在 worker 上验证：

```powershell
Invoke-RestMethod http://100.x.y.z:17321/health
```

返回 `ok: true` 只证明网络和 Hub 可达；随后仍需通过 Pilot 预检和飞书真实 `@` 交接
验证 Agent 身份、群权限与 dispatch。

## 安全边界

- 优先把 `bindHost` 设为主电脑的 VPN 网卡地址；只有需要多个可信私网接口时才监听
  `0.0.0.0`。
- 不要把 Hub 的裸 HTTP 端口直接映射到公网。
- worker 导出清单和 `.runtime\agent-tokens.json` 含凭据，必须保持 Git 忽略并私下传输。
- Tailscale 账号、设备审批和 ACL 由网络所有者管理；离职、丢失或废弃设备应及时移除。
- 正式公网部署仍需要 HTTPS、凭据轮换、限流、审计和可靠存储。

## 可替换方案

Tailscale 不是项目硬依赖。WireGuard、企业 VPN、同一可信局域网或配置完整的 HTTPS
入口都可以提供 Hub 可达性。无论选择哪种网络，项目协议仍保持一个逻辑中央 Hub、
每台电脑一个本地 Bridge、每 Agent 独立凭据。

## 常见排查顺序

1. 两台电脑是否都在线并能看到对方的 VPN 地址；
2. worker 能否访问 Hub `/health`；
3. 主电脑 Pilot 是否显示 `Hub health: True`；
4. worker 的 `publicUrl`、`tenantKey` 和 Agent 凭据是否来自同一个中心；
5. 对应 Bot 的飞书 profile 是否允许目标群，真实 `@` 是否能到达；
6. 再检查 dispatch、Agent 日志和模型端点，不把网络故障混同为模型登录故障。
