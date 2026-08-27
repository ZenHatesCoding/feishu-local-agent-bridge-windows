# Multi-Agent Collaboration Concepts

[Back to README](../README.md) | [中文](./COLLABORATION_CONCEPTS.zh-CN.md) |
[Design](./DESIGN.md) | [Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) |
[Windows operations](./WINDOWS_OPERATIONS.md)

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
| Artifact | A deliverable in the shared cabinet | A file plus integrity and visibility metadata |

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

## Artifacts Are Deliverables, Not Path Prose

The current single-machine Pilot snapshots files under:

```text
.runtime\artifacts\<taskId>\<sha256>\<file-name>
```

The Hub records name, type, local path, size, SHA-256 and available Feishu
message/file identifiers. This is durable on one machine, but a `C:\...` path
from computer A is meaningless on computer B. Distributed deployment therefore
needs downloadable artifact IDs/locators and a per-node cache. See the
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

Today Pilot assumes the Hub and all Agents live on one Windows computer. That
assumption—not Feishu—is why remote workers are not yet a supported deployment.

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
- **Bot tokens:** topics are isolated, but a long-lived topic currently sends
  all visible events again, so that topic becomes progressively more expensive.

An Agent's own resumed session may duplicate part of Hub history. The planned
answer is a complete source ledger plus source-sequenced summary checkpoints,
recent events and archival of cold completed tasks—not silent truncation. These
are Planned P1 roadmap capabilities.
