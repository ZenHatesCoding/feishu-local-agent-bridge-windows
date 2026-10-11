# Multi-Agent Collaboration Concepts

[Back to README](../README.md) | [中文](./COLLABORATION_CONCEPTS.zh-CN.md) |
[Design](./DESIGN.md) | [Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) | [Networking](./NETWORKING.md)

Bot, Agent, Bridge, Hub, Pilot, dispatch, ledger, context and artifact, explained
in plain language. Protocol invariants are in [Design](./DESIGN.md); the commands
that work today are in [Windows operations](./WINDOWS_OPERATIONS.md).

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
| Context | A handoff packet | Current objective, dispatch contract, rules and a local query entry point |
| Artifact | A deliverable registration card | What it is, task ownership, location, integrity and retrieval |

## The Hub Is Not An LLM

The Hub never invokes a model, understands prose or chooses the “best” Agent.
It is a small TypeScript server with three parts:

1. HTTP APIs used by Bridges to submit events, receive work and read context;
2. deterministic rules and state machines that check ownership and visibility;
3. an append-only JSONL ledger, stored at the `ledgerPath` the Hub config names
   (the example config uses `../data/collaboration.jsonl` relative to the config
   file, and the generated single-machine Pilot config keeps
   `.runtime\collaboration.jsonl`).

For `@World analyze this project`, the Hub does not understand “analyze.” It
only sees a human message targeting World, writes an owner lease and creates a
dispatch. The model behind World performs the reasoning.

Code entry points:

- HTTP routes: [`src/collab/server.ts`](../src/collab/server.ts)
- task rules and projections: [`src/collab/hub.ts`](../src/collab/hub.ts)
- JSONL ledger: [`src/collab/ledger.ts`](../src/collab/ledger.ts)
- context envelope: [`src/collab/context.ts`](../src/collab/context.ts)
- local observed-topic journal:
  [`src/collab/local-topic-ledger.ts`](../src/collab/local-topic-ledger.ts)
- content-addressed artifact snapshot:
  [`src/collab/artifact-store.ts`](../src/collab/artifact-store.ts)

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

A dispatch has one reason: `mention` or `fanout` for a human assignment,
`reply`, `handoff`, `ask` or `return` for an agent action. `reply` is the
lightest: it wakes another participant for a single group turn and does not
transfer ownership. Ordinary code checks that the dispatch belongs to the Agent,
its causal parent is active and the current owner may transfer work.

## Ledger Is History; Context Is The Handoff Packet

The ledger preserves ordered facts. Context is not an unfiltered copy. The Hub
filters by task participation and visibility, then the Bridge builds a
`collaboration_context` containing the current objective, the dispatch contract,
the agent roster, the fixed rules and a local-journal query entry point. It
excludes private reasoning, secrets, the conversation transcript, the artifact
catalog and unrelated tasks. One Feishu topic maps to one task, so another topic
is not automatically included in the prompt.

The packet carries no running history. The model that takes over reads the
current objective and the current triggering message, and asks for older local
records explicitly with `lark-channel-bridge local-context read` or `search`
when it needs them. An Agent resolves a specific deliverable on demand with
`collab-artifact.cmd resolve` instead of opening every historical deliverable.

Two stores, split by plane. The Hub ledger is the control-plane source of truth
(tasks, ownership, dispatches, causality and idempotency, replayed when the Hub
starts). The local journal is a data-plane observation log: each agent keeps its
own, one file per topic, holding only the messages it received, the attachments
it downloaded and its own results. The journal is never sent to the Hub, never
copied to another computer, and cannot answer who owns a task.

## Artifact Is A Registration Card, Not A Required File Server

An Artifact binds a file or code revision to task semantics: task, producer,
version, visibility, digest and retrieval location. Its content can use
different providers:

| Content | Preferred provider | Example locator |
| --- | --- | --- |
| Source, Markdown and configuration | GitHub / Git | repository + commit + optional path |
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
locator. The Artifact ID is `artifact_` plus the first 24 hex characters of the
SHA-256, so identical content is one record in one task. Feishu attachments use
`messageId + fileKey`; committed code and Markdown can be registered with
`collab-artifact.cmd register-git` using a repository, commit, and path. A
`C:\...` path from computer A is meaningless on computer B, so locator is shared
truth and local path is only a node cache. Automatic receiver-side retrieval is
still roadmap work. See the
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

Feishu handles visible conversation, real mentions and ordinary file transport.
GitHub handles code versions. The system still needs one deterministic answer
for current owner, valid dispatch, idempotency and context visibility, and that
is the Hub's role.

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

On disk, the Hub JSONL ledger and the artifact snapshots have no automatic
retention yet, and each agent's local journal also grows by topic. Hub memory
grows as well: startup replays the whole ledger and hot indexes stay loaded. Bot
tokens stay bounded, because Hub prompts contain the current dispatch and the
fixed rules rather than a topic transcript. A Bot can query only its own journal
(one file per topic under `<agentRoot>/collaboration/topics/<chatId>/`) when it
needs older local records, with a bounded result count.

The Hub ledger and the local journals grow independently: two agents on one
computer keep two journals and never append to a shared file, so adding an agent
does not multiply another agent's records. Neither store is copied to another
computer. Standard group/topic bridges start fresh model work, so they do not
implicitly resume an ever-growing provider session. Hermes retains ownership of
its native session; its provider-side retention remains independent of the Hub
and local journal. Retention, native-session compaction and archival of cold
completed tasks remain roadmap work; the phases and their acceptance criteria
are in the [distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md).
