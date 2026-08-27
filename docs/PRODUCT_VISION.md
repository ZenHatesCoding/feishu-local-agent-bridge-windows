# Feishu Multi-Agent Collaboration: Product Vision

[Back to README](../README.md) | [中文](./PRODUCT_VISION.zh-CN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Design](./DESIGN.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) | [Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

## North Star

The user should work in Feishu as if leading a small agent team. One Feishu
topic is one task. Mentioning an agent selects or transfers work to it, without
manually copying the previous agent's context.

The user should not need to understand the Hub, ledger, dispatch API,
environment variables or model sessions.

## Core Experience

The user may ask a deep-thinking agent to analyze first, then mention a faster
agent in the same topic to implement. The second receives the original task,
confirmed constraints, accepted decisions, evidence, completed/open work and
shared files. It does not receive private chain-of-thought, secrets or unrelated
runtime details.

Agent names and roles are user-configurable. Models, reasoning depth, speed,
tools and long-term memory remain agent-specific.

## Collaboration Modes

- **Handoff:** transfer ownership and the next objective.
- **Ask/return:** request focused help without transferring ownership.
- **Explicit parallel work:** wake multiple agents only when the user really
  mentions multiple agents.
- **Complete:** current owner closes the task with results and artifacts.

Agent-to-agent mentions remain visible in Feishu, but only a matching formal
dispatch can authorize work. Ordinary replies and accidental mentions cannot
create loops or cause every bot to answer.

## Context And Status

Users can mark information as task-shared, handoff-only or targeted. Private
runtime details stay local and secrets never enter the collaboration ledger.
The topic should expose a concise task state: current owner, stage, previous
result, next step and shared artifacts.

## Non-Negotiable Acceptance Criteria

1. A second mentioned agent can continue the first agent's work in the same topic.
2. It receives conclusions and artifacts, not private chain-of-thought.
3. Handoff, ask, return and complete work without user copy/paste.
4. Unauthorized agent mentions do not run and cannot form wake-up loops.
5. Messages without mentions do not make all bots race to answer.
6. The user can see owner, stage, next step and shared artifacts.
7. Collaboration can be disabled and independent bridges restored.
8. Hermes is never reinstalled and retains its existing state and commands.
9. Shared files have a durable path, hash and visibility, so later authorized
   agents can read them without another upload.

## Future Deployment Direction

Agents should eventually run on different computers, operating-system users or
isolated execution environments without changing the Feishu experience. Users
still mention Bots, inspect handoffs and receive files in one topic; Hub
addressing, node identity, artifact download and reconnect recovery belong to
deployment and protocol layers.

Remote deployment must preserve the existing invariants: one Hub task truth,
independent Feishu identities, real notifications matched to formal authority,
and traceable visibility-controlled artifacts. See the
[distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) for implementation
status and acceptance phases.

## Required Implementation Shape

- Users select, transfer and consult naturally in one Feishu topic while the
  system carries authorized context.
- The Hub stores filtered shared task state while Agents retain independent
  model sessions.
- Shared content contains task facts, conclusions and artifacts; private
  reasoning, tool noise and secrets remain isolated.
- Auditable ownership, dispatch and routing enforce authority; prompts explain
  the rules to Agents.
- The Hub maintains one task truth and every Bot works from its projection.
- Only a truly mentioned and authorized Bot responds; explicit multi-selection
  enables parallel work.
- A removable adapter preserves Hermes installation, state, commands and gateway.
- Feishu remains the user interface while the system carries protocol details.

Every change should reduce context carrying, clarify ownership/visibility and
preserve independent rollback. If it fails any of those tests, revisit it.
