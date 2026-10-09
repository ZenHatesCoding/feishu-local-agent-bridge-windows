# LAN multi-agent collaboration plan

[Project entry](../../README.md) | [中文](./LAN_COLLABORATION.zh-CN.md)

## Goal and architecture choice

Deploy an independent LAN collaboration system. People use an internal web workspace to discuss, delegate and exchange files with Agents on different computers. Each Agent retains its own Codex, Claude, Antigravity or DeepSeek Harness runtime and external model connection. Hermes is outside scope.

Use a purpose-built collaboration frontend, internal conversation/file services, the existing Hub coordination kernel and existing execution bridges. Build the conversation experience and channel integration around our task semantics, while reusing mature UI, networking, database and file components. Zulip and Mattermost are capability sources and optional channels, rather than mandatory system architectures.

The existing Feishu deployment and current local Bots remain independent. New deployment identities, configuration, credentials, ports, data directories and execution workspaces keep the two systems separate. Do not migrate or read existing task/login/Bot state. LAN covers users, center, Workers, files and code exchange; models continue using external services.

## User experience

A workspace provides project/topic navigation, a conversation timeline and a task sidebar. Conversation IDs are immutable; titles can change. Structured mention selection identifies Agents and explicitly enables multiple replies. Ordinary discussion does not implicitly assign ownership.

Messages contain replies, references, filtered progress, results and files. Users can assign, hand off, consult, add constraints, pause future scheduling, stop a run and initiate a new attempt after failure. The sidebar exposes owner, active work, next step, participants and artifacts. Completed work remains traceable.

Agent names, models, runtime types and workspaces are configurable, unrelated to existing local Bot names. Multiple Agents may use the same runtime with separate identities and credentials. Shared state contains requirements, conclusions, evidence and deliverables; private reasoning, raw tool traces and secrets remain local.

### Desktop delivery

This release focuses on computers within one LAN and delivers a browser workspace. User computers, center and Workers communicate internally; Agents continue accessing external models. Mobile clients are outside the delivery scope and implementation commitments.

### Desktop chat

Wide layout has roughly 240px project/topic navigation, a flexible readable-width timeline and roughly 300px task sidebar. Narrow windows collapse the task sidebar first, then navigation into a drawer. Layout depends on width, not device labels.

Header shows title, participants, search and connection. Authorized task sidebar shows owner, steps, next action, artifacts and controls. Timeline entries show avatar, human/Agent identity, time, Markdown/code/tables/files. Handoff/consultation events link to results; progress updates merge into a run block instead of flooding messages.

Fixed composer displays selected targets, attachments and reply/assign/consult mode. Searchable structured mentions support multiple Agents and availability. Enter sends, Shift+Enter inserts a newline; IME composition cannot send accidentally. Images/PDF use a panel/dialog; code supports copy/diff/download; Office files use download/system apps rather than promised online editing.

Keep older-message reading position and show a new-message control; follow streaming only when already at the bottom. Long answers expand without progress updates shifting the view.

![Desktop chat planning wireframe](./assets/lan-chat-desktop.svg)

### Desktop connection behavior

Closing the browser does not stop Workers. Center persists results/state, and reopening catches up through cursors. Drafts remain browser-device-local and clearly unsent when disconnected; reconnect requires user confirmation to send. Timed-out submitted requests query their outcome before retrying with the same ID. Unread and completion/failure alerts stay inside the workspace without external push services.

The image is a planning wireframe, not an implemented screenshot; Agent names are configuration examples.

## System shape

The collaboration center hosts Web/user APIs, conversation/event services, the Hub, SQLite persistence and an authorized file service. These have distinct responsibilities but can share one Node.js service and persistence boundary. Workers initiate internal HTTPS/event connections; inbound Worker ports are unnecessary. Internal Git carries code revisions. Each Worker separately connects to external models.

The center may run on a computer, always-on server or VM. Reuse TypeScript/Node.js and existing Windows process management initially; platform-specific launch adapters allow other systems without making either Windows or Linux a product boundary. Avoid mandatory Kubernetes, brokers, object storage or multiple Hubs.

## Open-source reuse

Use independent components directly, adapt mature product designs, or connect complete platforms through a channel interface. Prefer reusable modules with explicit boundaries and independent tests/upgrades. AI-assisted migration can reduce implementation effort, but does not establish correct authorization, transaction or recovery semantics.

| Source | Reuse | Boundary |
| --- | --- | --- |
| This project | Agent execution, authorization, ownership, handoff/consultation and shared state | Remove Feishu SDK/accounts/cards/CLI from the LAN execution dependency path |
| Zulip | Channel/topic organization, references/search and message event queues | Optional complete channel or design reference; mutable topic names are not task keys |
| Mattermost | Separate Bot identities, channels/threads and integration interfaces | Optional enterprise entry point; avoid inheriting a complete office platform |
| Matrix | Immutable event IDs, cursors, threads and explicit mention | Event/recovery design reference or existing deployment adapter; no federation/E2EE requirement for the first release |
| UI component systems | Accessible controls, layouts, menus/forms and status | React with mature components; custom conversation rows, Agent selection and task sidebar |
| Realtime components | Connections, reconnect, rooms and notifications | Plain WebSockets plus an event queue/cursor (modeled on Zulip event queues and Matrix sync cursors); Socket.IO optional — persistence, acknowledgment and authority belong to the center |
| Upload components | Chunking and resumable transfer | Ordinary HTTPS first; introduce a tus implementation when large files justify it |
| Internal Git | Revisions, branches and access | Existing Git or Forgejo; do not share whole Agent workspaces |

Primary references: [Zulip self-hosting](https://zulip.com/self-hosting/), [Mattermost Bot APIs](https://docs.mattermost.com/developers/integrate/reference/bot-accounts), [Matrix specification](https://spec.matrix.org/latest/client-server-api/). Candidate component entry points: [Fluent UI](https://github.com/microsoft/fluentui), [Socket.IO](https://github.com/socketio/socket.io), [tus Node implementation](https://github.com/tus/tus-node-server), [Forgejo](https://forgejo.org/).

API integration, interaction/design reuse and copying source are distinct decisions. When extracting code, retain module licenses, attribution and change provenance. [Zulip uses Apache-2.0](https://github.com/zulip/zulip/blob/main/LICENSE); [Mattermost licensing varies](https://github.com/mattermost/mattermost/blob/master/LICENSE.txt) across source/distributions/directories.

Complete chat platforms provide mature messaging quickly but still require our task, lease and artifact semantics, plus recovery across platform/Hub commit boundaries. A dedicated center can commit visible conversation events and Hub authority together. Combining existing core/bridges with mature components avoids rebuilding everything while delivering a task-oriented experience. Existing suitable chat infrastructure can still use the same channel contract.

## Hub and Worker reuse

Preserve reply/handoff/ask/return/complete/repair, explicit ownership, causal parent dispatch, idempotency, participation and visibility. Hub decisions remain deterministic.

Use deploymentId plus immutable conversationId for task addresses; channel, title and external links are metadata. External adapters maintain ID mappings. Normalize message ID, conversation ID, authenticated sender, explicit Agent targets, content, references and attachments. Register agentId/nodeId/instanceId/capabilities; external platform identity is optional rather than mandatory Feishu openId. No existing Feishu task migration is required for the separate LAN deployment.

Reuse runtime argument construction, subprocess/event parsing, stopping, concurrency and permissions for Codex, Claude, Antigravity and DeepSeek Harness. Add LanChannelAdapter and extract the common path as ChannelAdapter → CollaborationAdapter → RunExecutor → AgentAdapter. Feishu SDK, prompts, cards, membership APIs and lark-cli remain inside its own channel. LAN Workers require no Feishu App Secret.

Bridge consumes collaboration markers and submits formal actions. Authorized tools expose context, file retrieval and result publication without giving models administrator credentials.

| Existing area | Retained | LAN changes |
| --- | --- | --- |
| hub.ts | State machine, permissions, causality, idempotency | Channel-neutral identity and persistence/scheduling boundaries |
| ledger.ts/context.ts | Auditable events and filtered context | SQLite event store, current projection and on-demand history |
| server.ts/client.ts | Agent authentication and request semantics | LAN API, separate user ingress, claim/heartbeat/ack |
| bridge-adapter.ts | Actions, markers and run lifecycle | Normalized messages/channel interface |
| local-topic-ledger.ts | Locally observed records | Deployment/conversation scope; no private-session copying |
| agent adapters/RunExecutor | Model execution | New configuration, neutral prompt and identity adaptation |
| artifact-store.ts | Digests, snapshots and metadata | LAN provider, authenticated downloads and node-local materialization |
| Pilot | all/hub/worker roles and supervision | Independent manifests/data; no original Bot switching/restoration scripts |

## Messages and scheduling

Retain two keys: a persisted, visible, structured notification and Hub authorization. Structured mentions submit target IDs; server authenticates sender and scope. Text containing an Agent name alone grants nothing.

For a human message, validate conversation access and targets, then commit the message, all dispatches and notification outbox entries in one transaction. Acknowledge only after commit. Push tells Workers that work exists; they must claim it formally before retrieving objectives/context and running their own Agent.

For Agent collaboration, Bridge submits final result and marker under its active run identity. Hub validates owner, parent dispatch, target and causal depth, then records result, visible mention and next dispatch. Handoff moves ownership; ask keeps it. Consultation completion returns through Bridge/Hub to the current owner without another model-generated mention.

Persist cursors and delivery records; retry transport and process idempotently. Transactional claim binds Agent, instance and attempt; leases/heartbeats determine valid execution authority. Stale attempts cannot submit results or delegate.

Missing heartbeat marks uncertain execution first. Do not automatically repeat potentially side-effecting work after a network outage. Create a new attempt only after confirming the old process ended or an explicit user recovery decision. Fencing prevents stale center commits but cannot undo external tool actions already performed.

Cancellation blocks new delegation, asks Worker to stop its process tree and displays stopped only after acknowledgment; disconnected execution remains awaiting confirmation. Commit final output and terminal state together. Reconnect does not rerun completed work or duplicate visible results. Do not promise exactly-once arbitrary external side effects.

Use single-instance SQLite for messages, collaboration events, dispatches and outbox within one transaction boundary. Keep database and content on the center's local disk; NAS may back up data, not host the SQLite database over a shared filesystem. Preserve storage interfaces for future PostgreSQL migration.

## Context, files and code

Current dispatch governs each run. Project requirements, constraints, accepted conclusions, open work and relevant artifacts according to conversation membership/visibility. Read long history on demand through cursors. Conclusions carry provenance and supersession; never merge private model sessions.

Every upload/result is an Artifact with identity, conversation/task relationship, producer, visibility, name, size, MIME, SHA-256 and locator. Workers retrieve over internal HTTPS into local caches and verify digests. Publish temporary bytes, validate/create immutable content, then transactionally commit Artifact, message and dependent dispatch. Uncommitted uploads are not valid handoff references and may be cleaned up.

Authorize downloads every time; permanent public URLs cannot bypass targeted access. Center disk plus HTTPS is sufficient initially. Add resumable upload/object providers only when needed. Private results cannot also appear in a public timeline.

Code moves through internal Git repository/commit/path locators. Agents use independent workspaces/worktrees and explicit base commits; parallel work uses separate branches with an identified integrator. Artifacts carry temporary files, not login directories or entire machines.

## Identity and independent deployment

Separate user login/membership, Agent-scoped credentials and node enrollment. Browsers receive no Hub admin token. Local accounts, admin invitations and one-time enrollment can start the product; existing enterprise identity may later be adapted without mandatory external OAuth.

Use internal HTTPS for service traffic; prefer Tailscale HTTPS certificates (auto-issued for MagicDNS machine names) or DNS-01 issuance on an owned domain, and adopt an internal CA only when devices and staff are controllable. Expose only center ingress and scope firewalls. External model proxy settings apply only to the appropriate child runtime; LAN addresses bypass proxies.

Deploy a new all node, a hub-only always-on center with Workers, or a center with some Agents plus additional Workers. Each node receives a separate manifest and its own CLI setup/login. Configuration declares names, runtimes, models, workspaces, concurrency and permissions without assuming existing Bot rosters. Uninstall affects only the new deployment.

## Delivery and acceptance

The first complete release includes login, conversations, structured mentions, independent Agents, reply/handoff/ask/return, task status, progress/stop, files, internal Git locators and reconnect recovery. Use Codex and Claude on two new nodes as the reference combination; other existing bridges use the same interface. Names/models are configurable.

First release delivers the complete task loop in a desktop browser workspace. Exclude meetings, calendars, approvals, collaborative office editing and public federation. Complete chat channels may later share the same Hub/Workers.

### Development model: designed for AI execution

This plan is implemented by AI developers and does not follow the small-step,
risk-gated cadence of human teams:

- **Build the target form directly.** Code output is not the bottleneck; there
  are no transitional phases such as "polling first, push later" or
  "read-only first, complete later" that exist to cap human effort risk. If a
  direction proves wrong, rebuild it — that cost is acceptable.
- **Cut phases by verification environment, not by risk.** No multi-computer
  LAN exists at this stage, so phases are defined by "which verification
  needs which environment": everything that can be built and verified on one
  machine is completed there (see the verification ladder below), and the
  real-LAN day keeps only what the environment itself introduces.
- **Acceptance is a test suite.** Every acceptance scenario below becomes an
  automated test: integration tests for the Hub/Worker protocol and end-to-end
  tests for the browser experience. The quality gate is a green suite plus a
  real-machine smoke run, not staged human trials.
- **Contracts first, then parallel tracks.** Neutral channel contracts land
  first; the center, Workers and workbench then proceed in parallel, and the
  multi-Agent development itself runs on the existing Feishu collaboration
  system. Protocol invariants — authorization, visibility, idempotency and
  causal chains — are done right the first time, because they are the most
  expensive things to redo; UI and interaction may iterate or restart freely.
- **Verified baseline.** Feishu cross-machine collaboration, including the
  second physical-PC acceptance, is already a stable baseline; the new system
  builds directly on those collaboration semantics.

### Verification ladder: exhaust single-machine verification first

Phasing serves one goal: minimize the cost of debugging in a real LAN
environment. Three levels:

| Level | Environment | Coverage |
| --- | --- | --- |
| L0 single-machine simulation | Local multi-process: the center plus N simulated nodes (separate data directories, credentials and loopback address aliases), a fault-injection proxy (disconnect/latency/reordering), process-crash injection and browser end-to-end tests | **Every** protocol and product acceptance scenario: structured mentions, handoff/ask/return, ownership, visibility, idempotency, claim/lease/fencing, dual-instance races, reconnect recovery, file delivery and workbench UX (IME/resize/drafts). The original Feishu deployment runs on this machine, so "no impact on the existing deployment" is verified here too |
| L1 sandbox rehearsal (optional, recommended) | Windows Sandbox or Hyper-V as a stand-in second node: real network stack, firewall, certificate trust and clean-system install path | Environment differences loopback cannot expose: port opening, system-proxy interference, certificate trust chains and first runs of the installer on a clean system |
| L2 real-LAN day | Two physical computers | Environment-only items: real certificate issuance (e.g. Tailscale), hostname resolution, boot startup, physical disconnect behavior and CLI logins on the other machine |

Four hard constraints support the ladder:

1. **The simulation harness is a first-class deliverable, not an
   afterthought.** Track 1 builds the one-command multi-node topology
   skeleton, including fault-injection and crash-injection hooks; it grows
   with the center/worker/workbench tracks and runs in CI. Most acceptance
   scenarios are automated at L0.
2. **A simulated node and a real node differ only in manifest values.**
   Address, certificates and data directories are configuration differences,
   never code paths — otherwise L0 verification says nothing about L2.
3. **Install/start/stop/backup scripts are tested in final form at L0/L1**,
   including on a clean system; they never run for the first time on the LAN
   day.
4. **The LAN day runs from a pre-baked runbook** — acceptance checklist,
   diagnostic commands and log collection. The expected outcome is executing
   a checklist, not starting to debug.

This playbook has a precedent in this project: the Feishu distributed P0 was
first verified by the two-credential single-HTTP-Hub integration test on one
machine and then passed its second physical-PC acceptance in one run. The LAN
system scales the same pattern — the broader the simulation coverage (it adds
the web workbench, files and SSE), the cheaper the real-machine day.

### Implementation tracks

1. **Contracts and extraction** (first; unblocks every other track): extract
   the channel-neutral collaboration/execution interfaces, keep current
   Feishu behavior locked by contract tests, create the independent LAN
   configuration and deployment namespace, and build the single-machine
   simulation skeleton (one-command multi-node topology with fault-injection
   and crash-injection hooks). Align task-state names with the A2A TaskState
   machine and workbench event streams with the AG-UI event taxonomy.
2. **Center track**: transactional storage, user/node/Agent identity, stable
   conversation IDs, messages/dispatch/outbox, claim/lease/heartbeat, SSE
   event streams, and the file service with authorized downloads.
3. **Worker track**: claim/recovery/stop, result submission, marker
   delegation and run progress streaming; reuse the existing Agent adapters
   and evaluate implementing the unified Agent tool entry as an MCP server
   (mainstream coding CLIs ship MCP clients, so access needs no adapter).
4. **Workbench track**: desktop three-pane workspace, structured mentions,
   task panel, streaming rendering, reconnect recovery and file cards.
5. **Integration and operations**: install/backup/recovery packages tested in
   final form at L0/L1, diagnostics and run metrics, and the real-LAN-day
   runbook; add Zulip/Mattermost adapters through the same channel interface
   when a mature chat entry is needed. Real-machine acceptance on two new
   nodes happens after the L1 sandbox rehearsal passes.

Tracks 2-4 run in parallel once track 1's contracts land, and together they
deliver the complete task loop; there is no intermediate deliverable such as a
chat shell that cannot complete tasks. Each track is done when its acceptance
scenarios pass automatically at L0. The delivery gate is every acceptance
scenario in this section passing the L0 automated suite plus real-machine
acceptance on new nodes and instances only, executed from the runbook.

Acceptance covers explicit multi-target execution, no unmentioned runs, analysis-to-implementation handoff with authorization/files, ordinary replies preserving ownership, ask/return exactly one owner notification, forged actors/unrelated Agents rejected, topic and file visibility consistency, reconnect/restarts/duplicates/duplicate instances, uncertain execution without silent side-effect retries, persistent results/ownership/files, title changes preserving conversation identity, external model access with internal collaboration/file/code traffic, and startup/stop/backup/recovery without affecting the existing Feishu deployment.

Additional desktop acceptance covers IME/window resizing, Worker continuation after closing the page, reopening catch-up, unsent offline drafts and idempotent timeout recovery.

## Implementation status (L0, automated validation only)

Tracks 1-4 are implemented and green on the single-machine ladder; none of
this constitutes real second-PC or real-LAN acceptance.

**Shipped (branch `codex/lan-collaboration`)**

- Channel-neutral collaboration core: `TaskAddress` covers both the Feishu
  (`tenantKey/chatId/threadId`) and LAN (`deploymentId/conversationId`)
  worlds with byte-compatible task ids; the Hub takes a
  `CollaborationLedger` interface and lists task dispatches/identities.
- LAN center (`src/lan/center.ts` + `src/lan/sqlite.ts`): the same
  CollaborationHub state machine over SQLite (node:sqlite, WAL), user
  sessions (scrypt password hashes, hashed session tokens), per-agent token
  credentials, structured-mention message API, claim/heartbeat/release/
  complete with fenced attempts and the uncertain timeout scan, requeue,
  cancellation, SSE with dual-cursor catch-up, and content-addressed
  authorized file delivery.
- LAN worker (`src/lan/worker.ts`): poll/claim loop, prompt-context
  assembly, fake/codex/claude agent adapters, batched run-event streaming,
  marker-driven handoff/ask/reply/return submission, attempt finalization
  and heartbeat-carried cancellation.
- Simulation harness (`src/lan/sim.ts`): one-command multi-node L0 topology
  with worker pause/resume for race-free protocol tests.
- Browser workbench (`web/`): three-pane React SPA (conversations, timeline
  with streaming run blocks, task panel with dispatch statuses and file
  cards), login, structured mention composer, file upload, SSE reconnect
  with dual cursors. The center serves the built bundle from `webDir`.
- CLI: `lan center`, `lan worker`, `lan sim` (see below).

**How to run (L0)**

```
# workbench (once): cd web && pnpm install && pnpm build
node dist/cli.js lan sim -c <sim-config.json>   # loopback center + fake workers
node dist/cli.js lan center -c <center-config.json>
node dist/cli.js lan worker -c <worker-config.json>
```

The sim command prints the workbench URL and a generated owner password.

**Automated L0 suites (all green)**

`tests/integration/lan/` covers mention-only routing with visibility
fencing, dual-instance claim races, structured handoff waking the new
owner, idempotent submissions, center restart recovery, SSE catch-up, file
delivery with digest verification and anonymous rejection, heartbeat
timeout to uncertain with fencing and requeue recovery, full ask/return
consultation cycles, task cancellation, run-progress streaming, and static
workbench serving with traversal rejection. `web/` carries unit tests for
the timeline merge logic plus a headless-browser E2E smoke that skips
cleanly when no browser is installed.

**Not done yet (next on the ladder)**

- Fault-injection proxy (drop/delay/reorder) and crash injection at L0.
- Windows Sandbox L1 rehearsal from the real runbook, including the
  install/backup/recovery package and diagnostics/metrics.
- Real-LAN (L2) acceptance on new nodes and instances.
- Codex/Claude real runtimes on the worker track are wired but not yet
  exercised end-to-end beyond the fake adapter at L0.


Build a LAN Agent collaboration product with pluggable channels: a dedicated workspace, center-side transactional conversation/authority storage, the existing Hub rules and existing model execution bridges. Reuse, adapt or connect mature open-source capabilities as appropriate. Keep deployment independent of Feishu and keep external model access. Continue development on codex/lan-collaboration.
