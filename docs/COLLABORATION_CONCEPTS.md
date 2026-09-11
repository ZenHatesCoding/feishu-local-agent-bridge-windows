# Multi-Agent Collaboration Concepts

[Back to README](../README.md) | [中文](./COLLABORATION_CONCEPTS.zh-CN.md) |
[Design](./DESIGN.md) | [Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) | [Networking](./NETWORKING.md)

This document explains Bot, Agent, Bridge, Hub, Pilot, dispatch, ledger,
context and artifact in plain language. See [Design](./DESIGN.md) for protocol
invariants and [Windows operations](./WINDOWS_OPERATIONS.md) for commands that
work today.

## Think Of The System As A Company

| Concept | Plain-language analogy | Responsibility |
| --- | --- | --- |
| Feishu group/topic | Office and project thread | Visible messages, files and real `@` notifications |
| Bot | An employee's Feishu account | Receives and sends as one explicit identity |
| Agent / LLM | The worker doing the job | Analyzes, codes, creates documents and uses tools |
| Bridge | The messenger between Feishu and the worker | Delivers messages to the Agent and returns results |
| Hub | A project clerk that cannot think | Records tasks, issues work orders, checks transfers and filters context |
| Pilot scripts | The operations manager | Starts/stops processes, injects config and keeps PIDs/logs |
| Ledger | The project journal | Records messages, ownership, work orders, results and files in order |
| Dispatch | A formal work order | Authorizes one Agent to perform one objective |
| Context | A handoff packet | Current objective, accepted conclusions and visible history |
| Artifact | A deliverable registration card | What it is, task ownership, location, integrity and retrieval |

## The Hub Is Not An LLM

The Hub never invokes a model, understands prose or chooses the “best” Agent.
It is a small TypeScript server with three parts:

1. HTTP APIs used by Bridges to submit events, receive work and read context;
2. deterministic rules and state machines that check ownership and visibility;
3. an append-only journal at `.runtime\collaboration.jsonl`.

For `@World analyze this project`, the Hub does not understand “analyze.” It
only sees a human message targeting World, assigns ownership and creates a
dispatch. The model behind World performs the reasoning.

Implementation entry points:

- HTTP routes: [`src/collab/server.ts`](../src/collab/server.ts)
- task rules and projections: [`src/collab/hub.ts`](../src/collab/hub.ts)
- JSONL ledger: [`src/collab/ledger.ts`](../src/collab/ledger.ts)
- context envelope: [`src/collab/context.ts`](../src/collab/context.ts)

## Dispatch Is A Formal Work Order

Feishu mention and Hub dispatch are separate keys:

```text
real Feishu @ = ring the doorbell so the Bot receives an event
Hub dispatch = the appointment proving that work is authorized
```

The target Bridge runs only when both match. A text-only mention has no work
authority, while a dispatch without a Feishu event does not physically wake a
Bot. This prevents accidental mentions and Bot wake-up loops.

```text
pending -> accepted -> completed
                    \-> failed
```

Ordinary code checks that the dispatch belongs to the Agent, its causal parent
is active and the current owner may transfer work.

## Ledger Is History; Context Is The Handoff Packet

The ledger preserves ordered facts. Context is not an unfiltered copy. The Hub
filters by task participation and visibility, then the Bridge builds a
`collaboration_context` containing the current objective, accepted decisions,
risks and artifacts. It excludes private reasoning, secrets and unrelated
tasks. One Feishu topic maps to one task, so another topic is not automatically
included in the prompt.

The current packet is bounded: the original requirement, up to eight recent
semantic events and a compact catalog of up to twenty artifacts. Mechanical
events are omitted. Catalog rows do not expose file paths or locators; full
Artifact records are selected only when the current request refers to the file.
An Agent resolves another exact item on demand with `collab-artifact.cmd
resolve`, instead of opening every historical deliverable.

## Artifact Is A Registration Card, Not A Required File Server

An Artifact binds a file or code revision to task semantics: task, producer,
version, visibility, digest and retrieval location. Its content can use
different providers:

| Content | Preferred provider | Example locator |
| --- | --- | --- |
| Source, Markdown and configuration | GitHub / Git | repository + branch + commit + path |
| PPT, Word, Excel, PDF and images | Feishu message or Drive | messageId + fileKey, or Drive token |
| Large generated data or archives | Optional object storage | bucket + objectKey |
| Current single-machine runtime | Local snapshot | localPath + SHA-256 |

The project needs one Artifact abstraction, but it does not require a separate
Artifact server. GitHub, Feishu, object storage and the current local directory
are all possible backends.

### Current Implementation

The current single-machine Pilot snapshots files under:

```text
.runtime\artifacts\<taskId>\<sha256>\<file-name>
```

The Hub records name, type, local cache path, size, SHA-256, and a provider
locator. Feishu attachments use `messageId + fileKey`; committed code and
Markdown can be registered with `collab-artifact.cmd register-git` using a
repository, commit, and path. A `C:\...` path from computer A is meaningless on
computer B, so locator is shared truth and local path is only a node cache.
Automatic receiver-side retrieval remains roadmap work. See the
[distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md).

## Pilot Is Operations, Not Reasoning

Pilot is the PowerShell collection under `scripts\collab-pilot`. It reads the
Git-ignored local manifest, creates runtime configuration, starts/checks/stops
the Hub and Bridges, injects identities and environment, keeps PIDs and logs,
and can restore original independent Bridges.

```text
Pilot: starts and stops the system correctly
Hub: manages tasks and handoffs while the system is running
```

Pilot defaults to `all`, keeping the Hub and all local Agents on one Windows
computer. It also supports `worker` for Bots that connect to a remote Hub and
`hub` for a center-only node. The main PC can therefore remain both the center
and an execution node while other computers are added later.

## Why A Logically Central Hub Still Exists

Feishu is excellent for visible conversation, real mentions and ordinary file
transport. GitHub is excellent for code versions. The system still needs one
deterministic answer for current owner, valid dispatch, idempotency and context
visibility. That is the Hub's role.

If every Bot derives those facts independently from its event stream, delivery
order and retries can produce conflicting answers. The Hub makes them an
auditable state machine. It is logically central, not necessarily a dedicated
physical computer: an MVP can colocate it with Bot A; stable operation can use
a NAS or always-on internal server; a cloud deployment can split Hub API and
database while retaining one task truth.

Distributed deployment therefore has a local Bridge on every Bot computer and
one network-reachable Hub shared by them. File content can primarily remain in
Feishu and GitHub while the Hub stores task state and Artifact locators.

## One Complete Run

```text
user mentions World in Feishu
  -> World Bridge receives the event
  -> Bridge records it with the Hub
  -> Hub journals it, assigns ownership and creates a dispatch
  -> Bridge receives the dispatch and filtered context
  -> World's LLM reasons and works
  -> Bridge records the final result with the Hub
  -> Bridge replies in Feishu as World
```

A transfer first records `handoff` with the Hub, then sends a real mention in
the same topic. Chariot runs only after its Bridge matches the notification to
its authorized dispatch.

Only the LLM work step uses a model. Hub, Pilot and ledger are ordinary code.

## Growth Of Ledger, Memory And Tokens

The current implementation grows in three different ways:

- **disk:** JSONL and artifact snapshots have no automatic retention yet;
- **Hub memory:** startup replays the whole ledger and hot indexes remain loaded;
- **Bot tokens:** topics are isolated and the Hub packet is bounded to the
  original requirement plus recent semantic events and on-demand Artifacts.

An Agent's own resumed session may still retain earlier turns independently of
the Hub packet. Source-sequenced summary checkpoints, native-session compaction
and archival of cold completed tasks remain Planned P1 roadmap capabilities.
