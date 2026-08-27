# Distributed Deployment Status And Roadmap

[Back to README](../README.md) | [中文](./DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Design](./DESIGN.md) |
[Windows operations](./WINDOWS_OPERATIONS.md)

This document defines the correct target topology, capability status and
delivery order for multi-computer collaboration. Every capability is marked
Implemented or Planned P0/P1/P2 and moves to Implemented after its acceptance
criteria pass.

## Bottom Line

**Feishu already permits remote Bots to receive messages and visibly mention
one another. The missing work is in the local Hub, Pilot, authentication,
dispatch waiting and file sharing behind Feishu.**

The supported baseline is the single-machine Pilot. Bridge-to-Hub communication
already uses HTTP as the protocol foundation; the complete remote shape adds
remote workers, downloadable artifacts, per-Agent identity and secure transport.

## Capability Status And Target

| Capability | Status | Correct target |
| --- | --- | --- |
| Bots send/receive in one Feishu group | Implemented | Every Bridge connects to Feishu independently |
| Real Bot-to-Bot mentions | Implemented | Each app configures bot-message permission and group admission |
| Shared text task context | Planned P0 | Workers use `publicUrl` to reach one central Hub |
| Dispatch, ownership and visibility | Planned P0 hardening | Each authenticated principal operates only its Agent identity |
| PPT/PDF/Word artifact sharing | Planned P0 | Remote locator plus receiver-side materialization |
| Shared code workspace state | Planned P0 | Repository, branch and commit handoff |
| Secure remote deployment | Planned P0/P2 | Private-network MVP followed by TLS, rotation, limits and audit |
| Turnkey remote operations | Planned P0 | Explicit `hub`, `worker` and `all` Pilot roles |

## Foundation To Preserve

The project does not need a replacement orchestrator. Preserve topic-to-task
identity, Hub task truth, real-mention-plus-dispatch authorization, append-only
events, idempotency, owner leases, causal depth, visibility projections,
independent Bot credentials/models/workspaces and the optional silent
coordinator.

The change is to promote the local control plane into a central collaboration
service—not to turn the Hub into another LLM or merge model sessions.

## Target Topology

```mermaid
flowchart TB
  F["One Feishu group and topic"]
  H["Central Collaboration Hub\ntask / dispatch / context / identity"]
  S["Shared artifact storage\nHub storage / S3 / MinIO"]
  A["Computer A\nWorld Bridge + Agent + local workspace"]
  B["Computer B\nChariot Bridge + Agent + local workspace"]
  C["Optional silent coordinator"]

  A <-->|"visible messages and real @"| F
  B <-->|"visible messages and real @"| F
  C -->|"ordered topic events"| H
  A <-->|"HTTPS/VPN authorization and context"| H
  B <-->|"HTTPS/VPN authorization and context"| H
  H <--> S
  A <-->|"upload/download and SHA-256 verification"| S
  B <-->|"upload/download and SHA-256 verification"| S
```

Workers need no inbound Agent-to-Agent ports. They make outbound connections to
Feishu, the central Hub, artifact storage and their own model services.

## Planned Changes

### Separate Process Role, Bind Address And Public URL

Add `hub`, `worker` and backward-compatible `all` roles. A worker receives a
`publicUrl`, shared tenant key and its own credential; it must never create or
start a local Hub. A Hub receives distinct `bindHost`, `port` and `publicUrl`
settings.

### Bind Credentials To Agent Identity

Replace the shared bearer capability with credentials scoped to World,
Chariot, coordinator and administrator roles. The server derives the principal
from authentication instead of trusting `actorAgentId` in the request body.
Use Tailscale, WireGuard or an enterprise VPN for the first release; a public
endpoint additionally requires TLS, rotation, limits and audit.

### Replace The Fixed Dispatch Race With Recoverable Claiming

Coordinator and execution Bot events may arrive in either order. Replace the
short fixed polling window with atomic `claim`, execution heartbeat/lease and
completion endpoints plus long polling, SSE or a background dispatcher. Agent
registration should carry `nodeId`, `instanceId`, `lastSeenAt`, version and
capabilities so restart and duplicate instances are observable.

### Replace Shared Local Paths With Downloadable Artifacts

The shared record uses an artifact ID, digest, size and remote locator (`hub`,
`s3` or verified `feishu` reference) as cross-node truth. A receiver downloads into
its own cache and verifies SHA-256. Start with Hub upload/download endpoints or
an object-store adapter. Treat Feishu files as visible copies unless cross-app
resource-download permissions have been proven in a real group.

### Hand Off Workspaces Through Git

Use repository/branch/commit references for code, artifact storage for ordinary
files, and ownership or branch-per-agent for concurrent edits. A local absolute
path may be a node cache path, never shared truth.

## Context, Memory And Token Scaling

JSONL currently grows indefinitely, startup replays it and hot task/dispatch/
idempotency indexes stay in memory. Topics are isolated, but all visible events
in one long-lived topic are currently sent again to the Agent. Disk and Hub
memory therefore grow with all tasks; prompt tokens mainly grow with the active
topic. A resumed native Agent session may duplicate Hub history.

The target projection is:

```text
complete append-only source ledger
  -> source-sequenced summary checkpoint
  -> recent original events
  -> current dispatch and active artifacts
  -> Agent prompt
```

Add task cursors, explicit prompt limits, checkpoint provenance and cold-task
archival. Mechanical projection can omit unhelpful repeated runtime events, but
must not delete the source ledger. Semantic summaries record producer, covered
sequence range and source cursor. JSONL remains sufficient for a single-Hub
MVP; SQLite or PostgreSQL later provides transactions and uniqueness constraints.

## Delivery Phases

### P0: Text-Only Remote MVP

- split `bindHost`, `publicUrl` and process role;
- prevent workers from starting a local Hub;
- provision a common tenant key and per-Agent credentials;
- run over a private VPN, not bare public HTTP;
- add a two-isolated-node handoff integration test.

Acceptance: World on computer A transfers through Feishu, Chariot on computer B
receives the same task ID, filtered conclusions and its own dispatch, while an
unauthorized Agent cannot read them.

### P0: Remote Artifacts

- add upload/download or an object-storage backend;
- share locator and integrity metadata only;
- materialize a local cache path on the receiving node;
- test retry, duplicate upload, digest failure, authorization and size limits.

Acceptance: a PPT created on computer A can be downloaded without a shared
filesystem, verified, modified on computer B and sent back by B's Bot identity.

### P1: Reliable Dispatch And Presence

Add atomic claim, heartbeat, lease expiry, safe retry, long polling/SSE,
persistent identity/presence and coordinator-order/restart tests.

### P1: Context Checkpoints And Archival

Add cursors, summary checkpoints, recent-event windows, prompt-token metrics,
cold-task unloading and protection against duplicate native-session history.

### P2: Production Hardening

Add SQLite/PostgreSQL adapters and migrations, TLS, credential rotation, audit,
backup/recovery and non-Windows worker/container operation. Multi-Hub high
availability is optional and should not block the two-node MVP.

## GitHub References

- [`iamkentzhu/lark-bot2bot`](https://github.com/iamkentzhu/lark-bot2bot)
  demonstrates a local orchestrator calling a remote Hermes HTTP endpoint. It
  lacks this project's ledger, dual-key authorization and visibility projection.
- [`a2aproject/A2A`](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
  is useful for Task/Message/Artifact separation, asynchronous lifecycle, push
  notification, Agent Card and authentication concepts. Compatibility can be
  incremental; a rewrite is unnecessary.
- [`microsoft/autogen` distributed group chat sample](https://github.com/microsoft/autogen/tree/main/python/samples/core_distributed-group-chat)
  demonstrates multiple workers connecting to a central runtime host.
- [`larksuite/channel-sdk-node`](https://github.com/larksuite/channel-sdk-node)
  documents the Feishu channel foundation and the `im:message.group_at_msg` /
  `include_bot` requirement for Bot-to-Bot mentions.
- [`aws-samples/sample-lark-mcp-on-agentcore`](https://github.com/aws-samples/sample-lark-mcp-on-agentcore)
  is heavier than this project needs, but is a useful reference for HTTPS
  gateways, token validation, secret storage, persistent state and audit.

## Maintaining This Roadmap

The capability table is the single progress entry point. When a phase ships:

1. pass the acceptance criteria defined here;
2. move the capability from Planned to Implemented;
3. move operational configuration and commands into Windows operations;
4. retain the target architecture and remaining plans while removing obsolete
   transitional notes.

The documentation then always answers: what is the correct shape, how much is
implemented, and what comes next.
