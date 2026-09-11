# Multi-Computer Networking And Tailscale

[Back to README](../README.md) | [中文](./NETWORKING.zh-CN.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) |
[Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

This document covers only secure reachability between computers. See
[Concepts](./COLLABORATION_CONCEPTS.md) for Hub/Pilot/dispatch and
[Windows operations](./WINDOWS_OPERATIONS.md) for commands.

## Plain-Language Summary

Tailscale is an encrypted virtual LAN cable between computers in different
places. Devices in the same tailnet receive stable private addresses such as
`100.x.y.z` and can communicate as though they were behind one router.

For this project it provides only networking:

```text
Main PC: Hub + existing Bots  -- Tailscale private network --  another PC: added Bot
```

It is not the Hub or an LLM, and it stores no task, context, or artifact data.

## Why Use It First

A remote Bot must reach the main Hub to obtain the same task ID, its dispatch,
visibility-filtered context, and Artifact locators. Ordinary computers sit
behind routers and firewalls. A traditional public deployment also needs a
public IP, port forwarding, DNS, TLS certificates, and firewall maintenance.

Tailscale reduces the initial operations surface:

- normally no public IP or router port forwarding;
- encrypted device-to-device links;
- access limited to approved devices and network policy;
- the Hub can bind to a VPN interface instead of the public Internet.

The current recommendation is private-network HTTP plus independent per-Agent
credentials. Network membership protects reachability; Agent credentials
constrain application identity. Neither replaces the other.

## Project Configuration

The main PC remains `all`, running both the Hub and existing Bots:

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

An added computer uses `worker` with the same `publicUrl` and `tenantKey`.
`Export-CollabWorkerConfig.ps1` creates a private manifest containing that
registered Agent's credential.

After both devices join the same tailnet, test from the worker:

```powershell
Invoke-RestMethod http://100.x.y.z:17321/health
```

`ok: true` proves only network and Hub reachability. Pilot validation and a
real Feishu mention/handoff still verify identity, group access, and dispatch.

## Security Boundary

- Prefer binding the Hub to the VPN interface address. Use `0.0.0.0` only when
  multiple trusted private interfaces require it.
- Never port-forward the bare HTTP Hub to the public Internet.
- Worker exports and `.runtime\agent-tokens.json` contain credentials; keep
  them Git-ignored and transfer them privately.
- The network owner manages device approval and ACLs and removes lost or
  retired devices.
- A production public endpoint still needs HTTPS, credential rotation, rate
  limits, audit, and reliable storage.

## Alternatives

Tailscale is not a project dependency. WireGuard, an enterprise VPN, one
trusted LAN, or a properly secured HTTPS endpoint can provide reachability.
The protocol remains one logical Hub, one local Bridge per computer, and an
independent credential per Agent.

## Troubleshooting Order

1. Confirm both devices are online and can see each other's VPN address.
2. Confirm the worker can reach Hub `/health`.
3. Confirm the main Pilot reports `Hub health: True`.
4. Confirm worker `publicUrl`, `tenantKey`, and credential belong to one Hub.
5. Confirm the Bot profile allows the Feishu group and receives a real mention.
6. Then inspect dispatches, Agent logs, and the model endpoint separately.
