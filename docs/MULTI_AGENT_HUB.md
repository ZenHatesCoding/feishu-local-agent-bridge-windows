# Feishu Multi-Agent Collaboration Hub (Experimental)

> Product north star: [飞书多 Agent 协作：产品目标](./PRODUCT_VISION.zh-CN.md).
> Architecture and implementation decisions must preserve that user experience.

This branch develops a control plane for sequential collaboration between the
World, Justice, Chariot, and Fool bridge bots. It is deliberately opt-in and
does not replace, stop, migrate, or rewrite any existing bridge installation.

## Safety boundary

- Branch: `feature/feishu-multi-agent-hub`
- Worktree: `C:\feishu-multi-agent-hub`
- Default state: disabled; existing bridge behavior is unchanged.
- Hub bind default: loopback only (`127.0.0.1:17321`).
- Hub storage: a separate append-only JSONL ledger.
- Activation requires all four `LARK_COLLAB_*` variables in a bridge process.
- Hermes source, virtual environment, configuration, sessions, memories, and
  command shims are untouched. The pilot installs one additive Hook under
  `HERMES_HOME\\hooks`; the stop script removes only that Hook.

Removing this worktree or unsetting the four variables is a complete rollback.

## Collaboration model

One Feishu topic is one task. Normal groups are intentionally not treated as a
shared task because unrelated work would otherwise share context and ownership.

The Hub is the authority for:

- task identity and lifecycle;
- current owner and lease;
- public, handoff, targeted, private-runtime, and secret visibility;
- durable event history and per-agent context filtering;
- dispatch authorization, idempotency, acknowledgements, and hop limits.

Feishu remains the human interface and visible audit trail. A real Feishu `@`
wakes a bot, but an agent-to-agent `@` is accepted only when the Hub already has
a matching structured dispatch.

## Routing rules

| Event | Hub behavior |
| --- | --- |
| Human `@` one agent | Assign owner lease and dispatch once |
| Human `@` multiple agents | Explicit fanout; no owner is invented |
| Message without `@` | Record context; wake nobody |
| Ordinary agent reply or `@` | Record only; no implicit dispatch |
| `handoff` | Transfer owner lease and dispatch target |
| `ask` | Dispatch target once; owner remains unchanged |
| `return` | Send the result back to the current owner |
| `complete` | Current owner closes the task |

Raw chain-of-thought is never a shared context type. Agents should share
conclusions, evidence, artifact paths, accepted decisions, and open questions.

## Run the isolated Hub

Provide a random token through the environment. The example already registers
the four Tarot bot identities.

```powershell
$env:LARK_COLLAB_HUB_TOKEN = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
pnpm build
node .\dist\cli.js hub run --config .\config\collaboration-hub.example.json
```

Health check (no token required):

```powershell
Invoke-RestMethod http://127.0.0.1:17321/health
```

## Opt in one experimental bridge

Do this only in a copied test launcher, not in an existing production launcher:

```powershell
$env:LARK_COLLAB_HUB_URL = 'http://127.0.0.1:17321'
$env:LARK_COLLAB_HUB_TOKEN = '<same-token>'
$env:LARK_COLLAB_AGENT_ID = 'world' # justice, chariot, or fool for the others
$env:LARK_COLLAB_TENANT_KEY = '<one-shared-stable-tenant-key>'
```

All four bridges must use the same tenant key. This is an installation-local
opaque identifier, not an App Secret and not a bot App ID.

## Structured agent actions

The bridge injects the task ID and dispatch into `collaboration_context`. An
agent records authorization before using a real Feishu mention:

```powershell
lark-channel-bridge hub handoff --task task_xxx --actor world --target chariot --content "Implement from the accepted design"
lark-channel-bridge hub ask --task task_xxx --actor world --target justice --content "Review the threat model"
lark-channel-bridge hub return --task task_xxx --actor justice --content "Review complete; findings attached"
lark-channel-bridge hub complete --task task_xxx --actor chariot --content "Implemented and verified"
```

For `handoff` and `ask`, the caller then really `@` mentions the target in the
same topic. For `return`, the callee really `@` mentions the current owner. The
target bridge consumes the pending dispatch exactly once.

## Current milestone and next boundary

Implemented in this branch:

- durable replayable task ledger;
- deterministic topic task IDs;
- owner leases, handoff, ask/return, completion, fanout, and hop limits;
- visibility-filtered context API;
- authenticated loopback HTTP server and client;
- optional bridge intake adapter and collaboration prompt injection;
- CLI actions and unit coverage.
- optional silent Feishu coordinator ingestion (one authoritative event stream).

For production rollout, create a fifth silent Feishu app, enable its group
message receive event, grant it permission to receive every message in the
collaboration group, and add it to that group. Put its App ID in the Hub config,
keep its App Secret in `LARK_COLLAB_COORDINATOR_SECRET`, set `enabled` to `true`,
and set every execution bridge to:

```powershell
$env:LARK_COLLAB_EVENT_SOURCE = 'coordinator'
```

This app never runs a model or replies. It normalizes all topic messages into
the Hub before execution bots consume their authorized dispatches. Display
names and configured aliases map structured Feishu mentions to agent IDs; add a
bot's coordinator-visible open ID to its aliases if its display name is not
stable.

Hard confidentiality is outside this process boundary. All four current agents
can access the local machine, so Hub visibility is logical routing, not an OS
security boundary. Separate Windows users or containers are required for hard
isolation.

## Rollback

1. Stop only the experimental Hub process.
2. Remove `LARK_COLLAB_HUB_URL`, `LARK_COLLAB_HUB_TOKEN`,
   `LARK_COLLAB_AGENT_ID`, and `LARK_COLLAB_TENANT_KEY` from test launchers.
3. Start the original launchers unchanged.

No ledger data is required by the existing bridges, and no existing session or
Hermes state is migrated.
