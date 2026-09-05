# Repository Guide For Coding Agents

This file is the machine-oriented entry point for Codex and other coding
agents. The human-oriented entry points are [README.md](./README.md) and
[README.zh.md](./README.zh.md).

## Product Invariants

- Share task state, not private model sessions or chain-of-thought.
- One Feishu topic is one task boundary.
- Agent-to-Agent work requires both a real Feishu mention and a Hub dispatch.
- The Hub is deterministic coordination code, not an LLM.
- Preserve the default one-PC experience: `role: all` runs the Hub and all
  local Bots. Remote workers are additive; they must not make single-PC use
  harder or silently start another Hub.
- Keep Bot credentials, model sessions, workspaces, and Feishu profiles
  independent. Never commit `.runtime`, tokens, App Secrets, or worker exports.

## Read Progressively

Start with the README, then open only the documents relevant to the change:

| Need | Source of truth |
| --- | --- |
| Intended user experience and product tradeoffs | [Product vision](./docs/PRODUCT_VISION.md) / [中文](./docs/PRODUCT_VISION.zh-CN.md) |
| Plain-language meanings of Hub, Pilot, dispatch, ledger, context, Artifact | [Concepts](./docs/COLLABORATION_CONCEPTS.md) / [中文](./docs/COLLABORATION_CONCEPTS.zh-CN.md) |
| Protocol invariants, visibility, routing, context and Artifact design | [Design](./docs/DESIGN.md) / [中文](./docs/DESIGN.zh-CN.md) |
| Agent-specific bridge and profile integration | [Agent bridges](./docs/AGENT_BRIDGES.md) / [中文](./docs/AGENT_BRIDGES.zh-CN.md) |
| Windows manifests, roles, startup, logs, rollback and worker export | [Windows operations](./docs/WINDOWS_OPERATIONS.md) / [中文](./docs/WINDOWS_OPERATIONS.zh-CN.md) |
| Step-by-step bring-up of a new Windows worker box | [Worker deployment recipe](./docs/WINDOWS_WORKER_DEPLOYMENT.md) / [中文](./docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md) |
| Specific failures hit on real Windows worker installs (and how the pilot scripts were hardened) | [Windows worker pitfalls](./docs/WINDOWS_WORKER_PITFALLS.md) / [中文](./docs/WINDOWS_WORKER_PITFALLS.zh-CN.md) |
| Tailscale, VPN reachability and network security boundary | [Networking](./docs/NETWORKING.md) / [中文](./docs/NETWORKING.zh-CN.md) |
| Implemented distributed capabilities and remaining phases | [Distributed roadmap](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md) / [中文](./docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md) |
| Pilot script-local command summary | [Pilot README](./scripts/collab-pilot/README.md) / [中文](./scripts/collab-pilot/README.zh-CN.md) |

For a protocol change, read Product Vision and Design before editing. For an
operations-only change, read Windows Operations and the Pilot README. For a
distributed change, also read Networking and the Distributed Roadmap.

## Documentation Rules

- Document the correct architecture and behavior. If part of it is not built,
  label it as a target, TODO, phase, or pending acceptance; do not preserve a
  growing catalogue of obsolete wrong behavior.
- State capability status separately from the durable target. When code lands,
  update status and operational instructions in the same change.
- Use progressive disclosure: README answers “what is this and where do I go,”
  this file routes coding agents, and detailed documents own explanations and
  procedures. Link instead of copying long sections across files.
- Keep maintained English/Chinese document pairs aligned in meaning. Update
  navigation and link-contract tests when adding a maintained document.
- Prefer plain language first, followed by exact configuration, commands, or
  protocol details. Explain project terms before relying on them.
- Never put machine-specific IPs, credentials, user paths, or temporary runtime
  observations into tracked documentation. Use placeholders such as
  `100.x.y.z` and keep real deployment values in Git-ignored manifests.

## Engineering Workflow

- Preserve unrelated user changes and runtime state. Do not reset Agent logins,
  profiles, workspaces, the collaboration ledger, or artifacts.
- Keep schema-v1 and omitted-`role` compatibility unless a migration is
  explicitly designed and documented.
- Add focused tests for authorization, context visibility, idempotency, Pilot
  contracts, and documentation navigation when those areas change.
- Before handoff, run `pnpm test`, `pnpm typecheck`, `pnpm build`, and
  `git diff --check` in proportion to the change. For Pilot changes, also parse
  the PowerShell scripts and run `Test-CollabPilotConfig.ps1` when safe.
- Do not claim multi-computer acceptance from simulation alone. Distinguish
  automated two-client validation from a real second-PC Feishu test.
