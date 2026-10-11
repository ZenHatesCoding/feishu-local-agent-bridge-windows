# Multi-Computer Networking And Tailscale

[Back to README](../README.md) | [中文](./NETWORKING.zh-CN.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) |
[Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

Only secure reachability between computers is covered here. Hub/Pilot/dispatch
background is in [Concepts](./COLLABORATION_CONCEPTS.md); commands are in
[Windows operations](./WINDOWS_OPERATIONS.md).

## Plain-Language Summary

Tailscale is an encrypted virtual LAN cable between computers in different
places. Devices in the same tailnet receive stable private addresses such as
`100.x.y.z` and can communicate as though they were behind one router.

For this project it provides only networking:

```text
Main PC: Hub + existing Bots  -- Tailscale private network --  another PC: added Bot
```

It is not the Hub or an LLM, it stores no task, context, or artifact data, and it
does not replace Feishu or GitHub.

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

The two addresses do different jobs, and mixing them up is the usual cause of a
worker that cannot connect:

- `hub.bindHost` is the local interface the Hub listens on. The default is
  `127.0.0.1`, which only accepts connections from the same machine, so a remote
  worker needs the VPN address written here (or `0.0.0.0` to accept every
  interface). `hub.host` is the legacy spelling of the same field.
- `hub.publicUrl` is the address every Bridge and CLI uses to call the Hub. When
  it is omitted the Pilot derives `http://<hub.host>:<hub.port>` and rewrites
  `0.0.0.0` to `127.0.0.1`, which is correct for a single machine and wrong for a
  worker. A worker manifest must always set `publicUrl`; `bindHost` alone is not
  enough.
- `hub.port` defaults to `17321` for both listening and the derived URL.

The derived URL reads `hub.host`, not `bindHost`. Setting `bindHost` to the VPN
address therefore opens the port without changing the address a Bridge uses, so
set both fields on a Hub that serves remote workers.

### What Must Be Reachable

| Direction | From | To | Why |
| --- | --- | --- | --- |
| Inbound TCP | worker nodes | Hub `publicUrl` host and port | `/health` probe, event submission, dispatch polling, context reads, acks |
| Outbound | Hub node | Feishu open API | receive group messages, send replies, register the coordinator if enabled |
| Outbound | every node | Feishu open API | each Bridge connects independently as its own app |
| Outbound | every node | its own model endpoint | agent inference |
| Outbound | publishing/receiving node | GitHub, Feishu file API, or object storage | Artifact upload and download when the task needs a file |
| Inbound | nobody | worker nodes | workers need no inbound port at all; a Bridge only makes outbound connections |

The Hub is a control and metadata channel. Artifact bytes travel through Feishu
or Git, never through the Hub, so the Hub port does not need to be sized for file
transfers.

Tailscale is not installed, upgraded, or configured by this project. It is one
way to obtain the address in `bindHost`/`publicUrl`; the project itself only
needs a private address that all nodes can reach.

After both devices join the same tailnet, test from the worker:

```powershell
Invoke-RestMethod http://100.x.y.z:17321/health
```

`ok: true` proves only network and Hub reachability; `/health` requires no
credential at all. Pilot validation and a real Feishu mention/handoff are what
verify identity, group access, and dispatch.

## Proxies And Loopback

A Windows machine behind an HTTP proxy can reach the Internet but not
necessarily its own Hub. The Pilot and Bridge keep those paths apart:

- `Test-CollabHubHealth` builds its HTTP client with `UseProxy = $false`, so the
  Hub health probe never goes through `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`.
- `LARK_CHANNEL_DISABLE_PROXY=1`, set in `commonEnvironment` by both example
  manifests, keeps the Feishu connection direct instead of honouring those
  variables.
- The pilot's Antigravity helper (`scripts/antigravity-proxy-env.ps1`) reads the
  Windows user proxy settings for the agent process and, when it sets proxy
  variables, adds `NO_PROXY=127.0.0.1,localhost` if `NO_PROXY` is still empty.
  It does nothing when `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` is already set, and
  it never overwrites an existing `NO_PROXY`.
- The Pilot launcher `unsetEnvironment` list removes `HTTP_PROXY`,
  `HTTPS_PROXY`, and `ALL_PROXY` before an agent starts.

If a worker can open Feishu but not the Hub, check the proxy variables and the
`bindHost` value before touching the VPN.

## Security Boundary

Authentication is a bearer token per principal: the Hub admin token in
`.runtime\hub-token.txt` and one Agent token per Agent in
`.runtime\agent-tokens.json`. The Hub reads each Agent token from
`LARK_COLLAB_AGENT_TOKEN_<SAFEID>`, where `<SAFEID>` is the Agent id uppercased
with every character outside `[A-Z0-9]` replaced by `_`. The worker export writes
the token into the manifest as an inline plaintext `credential`, which the
operator should move into the User-scope variable named by `credentialEnv` and
then delete. Every route except `GET /health` requires one of these tokens, the
comparison is length-checked and constant-time, and the server refuses to start if
two credentials are identical. An Agent credential can only act as its own Agent
id.

The Hub speaks plain HTTP; this project has no TLS listener, so the transport is
exactly as private as the network it runs on. Anyone who can reach the port can
also read the token out of the traffic and then act as that principal. Treat
network membership as part of the authentication boundary:

- Prefer binding the Hub to the VPN interface address. Use `0.0.0.0` only when
  multiple trusted private interfaces require it.
- Never port-forward the bare HTTP Hub to the public Internet.
- Worker exports and `.runtime\agent-tokens.json` contain credentials; keep
  them Git-ignored and transfer them privately. A worker token belongs in a
  User-scope environment variable named by `credentialEnv`, not in a committed
  file.
- The network owner manages device approval and ACLs and removes lost or
  retired devices.
- The Hub holds identity registrations in memory only, so a restart loses every
  registered Feishu `open_id` until each Bridge reconnects. Expect that after a
  Hub restart, and do not treat a missing mention target as an identity bug.
- A production public endpoint still needs HTTPS, credential rotation, request
  limits, audit, and reliable storage. None of those exist yet.

Know what the Hub cannot enforce: it limits request bodies (256 KiB) but has no
artifact size limit, no rate limit, no audit trail beyond the JSONL ledger, and
any valid credential may list the Agent roster through `GET /v1/agents`.

## Alternatives

Tailscale is not a project dependency. WireGuard, an enterprise VPN, one
trusted LAN, or a properly secured HTTPS endpoint can provide reachability.
The protocol remains one logical Hub, one local Bridge per computer, and an
independent credential per Agent.

## Troubleshooting Order

1. Confirm both devices are online and can see each other's VPN address.
2. Confirm the Hub is listening on the expected address: `bindHost` must not
   still be `127.0.0.1` when a worker calls it from another machine.
3. Confirm the worker can reach Hub `/health`.
4. Confirm the main Pilot reports `Hub health: True`.
5. Confirm worker `publicUrl`, `tenantKey`, and credential belong to one Hub.
6. Confirm the Bot profile allows the Feishu group and receives a real mention.
7. Then inspect dispatches, Agent logs, and the model endpoint separately.
