# LAN multi-agent collaboration proposal

[Project README](../../README.md) | [中文](./LAN_COLLABORATION_PROPOSAL.zh-CN.md)

Research date: 2026-10-06. Proposal only: no implementation, deployment or physical second-PC acceptance. Existing Feishu product invariants remain in force; adopting a LAN channel would require an explicit future product change.

## Recommendation

Validate self-hosted Zulip with the existing Hub and channel-adapted Workers first. Reuse accounts, topics, messaging, search and attachments before adding task dashboards. Keep the deterministic Hub rather than replacing it with an LLM orchestrator.

A small custom task-conversation web app is a viable alternative when only browser-based agent coordination is needed. It would require maintaining identity, messages, attachments and recovery, but need not reproduce a full office suite. Prefer existing enterprise Mattermost infrastructure over deploying another chat service. These are engineering judgments from source/document review, not measured deployment results.

## Repository alignment

`git fetch --all --prune` succeeded for origin and upstream. The original checkout was clean. Every pre-existing local branch matches its same-name origin branch by SHA. Fetch succeeded; pushing the research branch failed to retrieve existing credentials, so the authorized desktop git.txt token was used for this operation without committing or printing it. Alignment means matching remote references, not merging branches with different roles.

| Branch | SHA | Status |
| --- | --- | --- |
| develop/hub | 6f3ed4d | Latest Hub development: September 29 long-run progress heartbeat; node-local topic journal, marker repair and ask-return wake-up |
| release/hub | 371bb02 | Deployment baseline without subsequent development changes |
| develop/worker | d689d73 | September 22 ask-return work; distinct Worker operations and delegation CLI |
| release/worker | 50d8a03 | Deployment baseline; physical second-PC acceptance remains a release condition |
| archive/* | See snapshot | Frozen Hub milestones, pre-reorganization states and standalone bridges |
| upstream/main | 5898681 | Original bridge project: 23 exclusive commits, including Web UI, channel upgrades and Codex reply fixes; Hub has 59 exclusive commits |
| upstream feature branches | See snapshot | Register-source, mention configuration, Web UI, daemon, larkcli, quote cards, channel SDK and Windows stdin history |

[All fetched references](./BRANCH_SNAPSHOT.txt) preserve the branch inventory. Content and patch-equivalence comparisons show real Hub/Worker differences: group-scoped marker delegation versus global availableAgents/delegation CLI, different multi-target authorization, and missing latest Hub progress handling. Do not blindly merge or promote releases. A future LAN implementation must define a shared protocol baseline while retaining deployment role differences.

This isolated codex/lan-solution-research worktree starts at develop/hub. Only research documents change; runtime state, logins, Hook, ledger and agent workspaces remain intact.

## Network scope

LAN collaboration can keep approved external model endpoints while moving chat, Hub, files and Git inside. This is not fully offline. Strict disconnected operation additionally requires internal inference, weights, tools, dependency/install mirrors, authentication, DNS and certificates. Existing Codex/Claude/Antigravity logins do not establish offline support. Verify each runtime's internal-model compatibility; assess suitable Harness/Hermes configurations without assuming current compatibility or equivalent model capability.

The existing component is Tailscale, not Timescale. It supplies reachability, encrypted links and device admission. Hub Agent tokens independently constrain application identity. LAN can replace VPN reachability; removing Tailscale does not remove Feishu SaaS dependency. See [Networking](../NETWORKING.md) and [Design](../DESIGN.md).

## Open-source candidates

| Candidate | Verified foundation | Engineering assessment |
| --- | --- | --- |
| Zulip | Self-hosting, channel/topic, REST messages, event queues, uploads; Apache-2.0 | Closest topic model; mutable topic names require stable mapping; Bot events and download permissions need PoC; usually Linux/VM/container server |
| Mattermost | Official disconnected deployment and Bot integration documentation | Map tasks to channel/root-post threads; pin edition/version and verify licensing/features; best when already deployed |
| Matrix/Element/Synapse | Standard sync, threads, mentions and media; self-hosted homeserver | Federation, encryption and Bot key handling add complexity; eliminate unwanted external services and review component licenses |
| Custom web app | Can directly expose Hub state | Best for narrowly scoped task coordination; owns authentication, messaging, permissions, recovery and ongoing maintenance |

Primary sources: Zulip [self-hosting](https://zulip.com/self-hosting/), [license](https://github.com/zulip/zulip/blob/main/LICENSE), [send](https://zulip.com/api/send-message), [register events](https://zulip.com/api/register-queue), [receive events](https://zulip.com/api/get-events), [upload](https://zulip.com/api/upload-file). These establish integration primitives, not successful integration with this project.

Mattermost [air-gapped deployment](https://docs.mattermost.com/deployment-guide/deployment-scenarios/air-gapped-deployment), [Bot accounts](https://docs.mattermost.com/developers/integrate/reference/bot-accounts), and [licensing](https://github.com/mattermost/mattermost/blob/master/LICENSE.txt) distinguish compiled releases, source and directory-specific terms; do not label all enterprise capabilities or source as free MIT.

Matrix [client-server specification](https://spec.matrix.org/latest/client-server-api/) and [Synapse](https://github.com/element-hq/synapse) provide protocol/server evidence. Federation may offer little benefit for this single-center use case. AutoGen/A2A do not provide the human chat replacement. Rocket.Chat remains an extended candidate without sufficient verified offline evidence in this review to rank it.

## Topology and reuse

Internal browser/client connects to Zulip. Each node runs its own channel Bridge and Agent, connecting to one authoritative Hub, internal files/Git and, for disconnected use, internal inference. Chat and Hub may share an always-on host; a Linux VM can host Zulip while Workers stay on Windows. Preserve all/hub/worker roles and independent credentials. Internal DNS, HTTPS and role-scoped firewall rules replace remote reachability. Kubernetes, another broker, multiple Hubs and object storage are not MVP prerequisites.

| Existing module | Reuse and required work |
| --- | --- |
| collab/hub.ts, ledger.ts | Reuse task truth, ownership, action lifecycle, causality, idempotency and visibility |
| server.ts, client.ts | Reuse Agent-scoped authentication; add separate authenticated human ingress; never expose admin token to browsers |
| task-id.ts, types.ts | Reuse address concept; version provider namespace/stable conversation IDs; openId is Feishu-specific |
| bridge-adapter.ts, coordinator.ts, agent-roster.ts | Reuse semantics; abstract authenticated events, provider identity, membership, mention and delivery receipts |
| context.ts, local-topic-ledger.ts | Reuse current-dispatch prompts and locally observed history; namespace scopes and replace Feishu-specific instructions |
| artifact-store.ts and locators | Reuse digest/catalog semantics; add authorized LAN retrieval and receiving-node materialization |
| agent adapters, execution/session machinery | Reuse conditionally; disconnected runtime support requires independent verification |
| bot/channel.ts, cards/media/commands | Concentrated channel work: SDK, replies, reactions, cards, comments and files are coupled to Feishu |
| Pilot and Hermes Hook | Reuse process roles, environments and rollback; replace channel CLI/identity/file bindings without reinstalling Hermes |

No unmeasured reuse percentage is claimed. Progress heartbeat at 6f3ed4d is not distributed execution-lease heartbeat or atomic claim. Locator registration is not implemented automatic cross-node materialization. These remain roadmap work.

## Protocol boundaries

Proposed address: deployment/provider/tenant/channel/immutableConversationId. Zulip topic names are mutable; [message editing](https://zulip.com/api/update-message) permits topic changes/moves. Register a stable internal conversation at the first message and retain aliases/message mapping. Preserve task identity on rename. Initially pause affected tasks on split/merge/cross-channel moves pending explicit migration semantics. Version new addresses without changing legacy Feishu task IDs or schema compatibility.

Generalize real Feishu mention plus dispatch to an authenticated, visible, target-specific platform notification plus Hub authorization. Verify sender and mention evidence from server events; never authorize by a regex over text. Bridge-owned marker delivery retains independent sending identity and checks conversation, target, parent dispatch and idempotency.

Hub and chat have no shared transaction. A recorded dispatch with failed notification must remain unexecuted and report failure. Persistent delivery/outbox recovery and bounded waiting handle retry and notification-before-authorization. Restart replay must not repeat an executed dispatch. Atomic claim/execution leases must be implemented before promising single execution under duplicate Worker instances. Custom UI also retains distinct visible conversation events and Hub grants; SSE alone is not authority.

Hub visibility cannot retract publicly posted chat content. Targeted/handoff content and attachments must use matching access scopes or Hub-authorized endpoints. Validate participant access, size, filename, digest and path boundaries before materialization. An artifact URL alone must not grant access. Initially use central disk behind authenticated LAN HTTPS and Artifact-ID locators; only use chat file providers after cross-Bot permissions pass. Internal Git, optionally [Forgejo](https://forgejo.org/), carries repository/commit/path. Shared SMB workspaces are not portable protocol truth and can weaken isolation.

## Custom UI alternative

Limit scope to login, task conversations, structured agent selection, messages/notifications, owner/stage/next step, attachments, stop and node status. Keep private reasoning/tool traces out. Human sessions and Agent tokens are distinct; backend validates conversation access.

Frontend, authenticated ingress, event and attachment services form the messaging plane; existing Hub is the control plane and Workers the execution plane. SQLite messages/outbox is a possible single-instance starting point, not implemented functionality. Outbound long polling/SSE with cursors and heartbeat avoids inbound Worker ports. WebSocket alone does not solve persistence, authorization, replay or idempotency. Exclude meetings, calendars, approvals, collaborative documents, complex mobile clients and public federation.

## Future phases and acceptance — not executed

1. Validate one internal server, two physical Workers and distinct Bot accounts: human multi-mention, Bot mention, ask/return, files, topic rename and replay. Reject mentions without dispatch. If topic stability/Bot delivery fails, reconsider Mattermost/custom UI.
2. Abstract events, conversation addresses, identities, mention, send/file/history interfaces; preserve Feishu behavior, schema-v1, omitted-role and legacy addresses.
3. Add atomic claim, execution leases, presence, cursors, outbox and recovery. Every run ends completed/failed; stale parents cannot delegate.
4. Package internal inference/tools, dependencies/images/weights, CA/DNS and backup. Block external egress and run end to end, checking authentication refresh, CDN/fonts, telemetry, updates, previews and push. Ordinary APNs/FCM is not an internal-only service.

Test unauthorized Agents, forged actors, topic isolation, targeted files, duplicate events, Worker/Hub restart, network outage, notification failure, duplicate instances, long runs, digest mismatch and missing files. Record physical second-PC tests separately from simulations.

Estimate channel adaptation, identity migration, reliable dispatch, artifacts and offline models separately after PoC; do not promise a fixed schedule without it. Strict offline model capability may dominate effort.

Choose Zulip PoC for mature new team chat, existing Mattermost/Matrix for existing infrastructure, or custom UI for task-only browser coordination. All preserve the Hub/Worker mechanism. Before implementation decide strict offline scope, chat needs and available internal hosting/models. This proposal covers both scopes and authorizes no implementation.

