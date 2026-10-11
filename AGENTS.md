# Repository Guide For Coding Agents

Coding agents start here. The human entry points are [README.md](./README.md)
and [README.zh.md](./README.zh.md).

## Product Invariants

- Share task state, not private model sessions or chain-of-thought.
- One Feishu topic is one task boundary.
- Agent-to-agent work needs both a real Feishu mention and a Hub dispatch.
- The Hub is deterministic coordination code, not an LLM.
- Keep the default one-PC experience working: `role: all` runs the Hub and all
  local Bots. Remote workers are additive. They must not make single-PC use
  harder and must not start a second Hub.
- On a machine that runs several agents, treat them as if they were on separate
  machines. Each agent gets its own manifest, scheduled task, credential,
  profile root (unless they share one) and observed-topic journal. Only the Hub
  is shared, and stopping or reconfiguring one agent must not touch a sibling.
- The local journal is per agent and per topic: see
  `<root>/collaboration/topics/<chatId>/<threadId>.jsonl`, or `_chat.jsonl` for
  a chat message outside a topic. It holds only what that agent's bridge
  observed, and it never leaves the machine.
- Keep Bot credentials, model sessions, workspaces and Feishu profiles
  independent. Never commit `.runtime`, tokens, App Secrets or worker exports.

## Read Progressively

Start with the README, then open only the documents the change touches:

| Need | Source of truth |
| --- | --- |
| Intended user experience and product tradeoffs | [Product vision](./docs/PRODUCT_VISION.md) / [中文](./docs/PRODUCT_VISION.zh-CN.md) |
| Plain-language meanings of Hub, Pilot, dispatch, ledger, context, Artifact | [Concepts](./docs/COLLABORATION_CONCEPTS.md) / [中文](./docs/COLLABORATION_CONCEPTS.zh-CN.md) |
| Protocol invariants, visibility, routing, context and Artifact design | [Design](./docs/DESIGN.md) / [中文](./docs/DESIGN.zh-CN.md) |
| Agent-specific bridge and profile integration | [Agent bridges](./docs/AGENT_BRIDGES.md) / [中文](./docs/AGENT_BRIDGES.zh-CN.md) |
| Windows manifests, roles, startup, logs, rollback and worker export | [Windows operations](./docs/WINDOWS_OPERATIONS.md) / [中文](./docs/WINDOWS_OPERATIONS.zh-CN.md) |
| Step-by-step bring-up of a new Windows worker box | [Worker deployment recipe](./docs/WINDOWS_WORKER_DEPLOYMENT.md) / [中文](./docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
| Failures hit on real Windows worker installs, and how the pilot scripts were hardened | [Windows worker pitfalls](./docs/WINDOWS_WORKER_PITFALLS.md) / [中文](./docs/WINDOWS_WORKER_PITFALLS.zh-CN.md) |
| Tailscale, VPN reachability and the network security boundary | [Networking](./docs/NETWORKING.md) / [中文](./docs/NETWORKING.zh-CN.md) |
| Implemented distributed capabilities and remaining phases | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) / [中文](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
| Pilot script-local command summary | [Pilot README](./scripts/collab-pilot/README.md) / [中文](./scripts/collab-pilot/README.zh-CN.md) |

A protocol change needs Product Vision and Design first. An operations-only
change needs Windows Operations and the Pilot README. A distributed change also
needs Networking and the Distributed Roadmap.

## Documentation Rules

- Describe the architecture and behaviour as they are. When part of it is not
  built, say so: label it a target, a phase or pending acceptance. Do not keep a
  growing catalogue of behaviour that no longer exists.
- Keep capability status separate from the durable target, and update the status
  and the operational instructions in the same change that lands the code.
- Link instead of copying. The README answers "what is this and where do I go",
  this file routes coding agents, and the detailed documents own the explanations
  and procedures.
- Keep each English/Chinese pair aligned in meaning, and update the navigation
  and link contracts when you add a maintained document.
- `tests/unit/docs` is part of the documentation. `readme-contract`,
  `navigation-contract`, `collab-design-contract` and
  `product-vision-contract` pin required phrases, counterpart links and the
  README/AGENTS routing. Run them after any documentation change:
  `node node_modules\vitest\vitest.mjs run tests\unit\docs`.
- Write for a person: plain language first, then the exact configuration,
  commands or protocol details. Explain a term before relying on it.
- Never put machine-specific IPs, credentials, user paths or temporary runtime
  observations into tracked documentation. Use placeholders such as `100.x.y.z`
  and keep real deployment values in Git-ignored manifests.

## Engineering Workflow

- Preserve unrelated user changes and runtime state. Do not reset Agent logins,
  profiles, workspaces, the collaboration ledger, journals or artifacts.
- The two manifest formats behave differently. The bridge profile config is
  `schemaVersion: 2`, and legacy v1 is upgraded by the migration path
  (`src/config/migrate-v2.ts`, `lark-channel-bridge migrate`). The pilot and
  worker manifest is v2 only; anything else is rejected with
  `Unsupported pilot config schemaVersion.`, so a v1 manifest has to be migrated
  on purpose. An omitted `role` still means `all`, an omitted `enabled` still
  means enabled, and an omitted `runOnThisNode` still means this machine.
- Add focused tests for authorization, context visibility, idempotency, Pilot
  contracts and documentation navigation when those areas change.
- Before handoff, run `pnpm test`, `pnpm typecheck`, `pnpm build` and
  `git diff --check`, in proportion to the change. For Pilot changes, also parse
  the PowerShell scripts and run `Test-CollabPilotConfig.ps1` when that is safe.
- Do not claim multi-computer acceptance from simulation alone. Say whether a
  result came from automated two-client validation or from a real second-PC
  Feishu test.
