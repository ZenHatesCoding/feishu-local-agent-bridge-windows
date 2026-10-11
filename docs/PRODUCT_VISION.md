# Feishu Multi-Agent Collaboration: Product Vision

[Back to README](../README.md) | [中文](./PRODUCT_VISION.zh-CN.md) |
[Concepts](./COLLABORATION_CONCEPTS.md) | [Design](./DESIGN.md) |
[Windows operations](./WINDOWS_OPERATIONS.md) |
[Distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md)

This document defines the experience the project must deliver. Architecture,
protocol and code may change, but not at the cost of what is written here. When
implementations disagree, this document decides.

## North Star

The user should work in Feishu as if leading a small agent team. One Feishu topic
is one conversation. Participants reply to each other naturally, and only a work
transfer or a consultation changes what the work means. Nobody copies the
previous agent's context by hand.

The user should not need to know about the Hub, the ledger, the dispatch API,
environment variables or model sessions.

## Example Roles

- **World**: deep analysis, complex reasoning and option design.
- **Justice**: review, verification, risk checks and dissent.
- **Chariot**: fast implementation of an agreed plan.
- **Fool**: carried by Hermes, keeping its existing abilities and memory.

Roles are not hard-coded capability limits, and the number of agents is a
deployment decision rather than a product limit. The user can address any
configured agent and give each one its own model, reasoning depth and speed.

## Core Experience

The user may ask a deep-thinking agent to analyze first, then mention a faster
agent in the same topic to implement. The second agent receives the original
task, the confirmed constraints, the accepted decisions, the evidence, what is
done and open, and the files. It does not receive private chain-of-thought,
secrets or unrelated runtime details.

For example, in a topic named after the work:

> @World analyze this first and focus on architectural risk; do not write code yet.

Then:

> @Chariot carry on. Implement per the conclusions above, prioritize speed, do
> not re-analyze.

Chariot should receive what it needs to continue:

- the original task and the requirements the user added later;
- confirmed conclusions and decisions;
- key evidence, file paths, commits and other artifacts;
- what is done, what is open, and the explicit next step;
- files created by the previous agent or supplied by the user, including PPT,
  documents, sheets, PDFs, images and archives.

The user does not copy World's answer or re-explain the background. Chariot must
not receive World's private chain-of-thought, transient tool output, secrets, or
runtime details unrelated to the task.

## One Conversation, Optional Work Semantics

- **Reply:** a normal agent-to-agent group turn. It grants one visible,
  authorized response without transferring ownership.
- **Handoff:** transfer ownership and the next objective.
- **Ask / return:** request focused help without transferring ownership; the
  answer goes back to the current owner.
- **Explicit parallel work:** wake several agents only when the user really
  mentions several agents.
- **Complete:** the current owner closes the task with results and artifacts.

A sequential flow may be described once:

> @World analyze deeply, hand the agreed plan to Chariot to implement, then have
> Justice review it.

Agent-to-agent mentions stay visible in Feishu, but only a matching formal
dispatch authorizes work. Ordinary replies and accidental mentions cannot create
loops or make every bot answer.

## Sequential, Consultative And Parallel Work

A user can describe a whole flow in one message:

> @World analyze deeply, hand the agreed plan to Chariot to implement, then have
> Justice review it.

The intended path:

1. World analyzes and answers in the topic.
2. World reports the handoff and mentions Chariot for real in the same topic.
3. Chariot receives the structured handoff and implements.
4. Chariot hands the result and artifacts to Justice.
5. Justice either returns the work to Chariot or reports completion to the user.

Showing a handoff state such as "handed to Chariot" in the topic is part of the
target experience, not something the bridge renders today.

A consultation keeps the current owner in place:

> @World keep this task, but have Justice check the security risk only.

Justice answers, the result goes back to World, and World is still the owner.

Broadcast and parallel work happen only when the user mentions several agents:

> @World @Justice evaluate this separately, one on architecture, one on risk.

A message without a mention only adds context to the topic. Several bots in one
group must not all answer every message.

## Context And Status

Users express scope in natural language: "treat this as a shared conclusion",
"this is only for Justice's security review", "Chariot only needs the final plan
and the file list".

What the code enforces today is narrower than that intent. A message is
task-public by default, a `handoff` is visible to the two sides of the transfer,
and an `ask` is targeted at the agent being asked. `private-runtime` and `secret`
exist in the protocol and in the visibility check, but no agent-facing switch
produces them yet, and interpreting the user's wording as a scope instruction is
the target rather than an implemented control.

That authority is a collaboration-layer boundary. Agents running as the same
Windows user may still reach the same files at operating-system level; hard
isolation needs separate users or containers.

Each topic should expose a short, continuously updated task state instead of
making the user reconstruct it from a long conversation:

> Owner: Chariot
>
> Stage: implementing
>
> Last step: World finished the architecture analysis
>
> Next step: Justice review
>
> Shared artifacts: `design.md`, commit `abc123`

Status display serves judgement and action. It does not show internal protocol,
debug logs or chain-of-thought. The current cards show run progress; the
owner/stage/next-step view above is a target.

## Non-Negotiable Acceptance Criteria

1. A second mentioned agent can continue the first agent's work in the same topic.
2. It receives conclusions and artifacts, not private chain-of-thought.
3. Reply, handoff, ask, return and complete work without the user copying
   anything between agents.
4. Unauthorized agent mentions do not run and cannot form wake-up loops.
5. Messages without mentions do not make all bots race to answer; mentioning
   several agents explicitly is what enables parallel work.
6. The user can see owner, stage, next step and shared artifacts.
7. Complete history stays auditable while model prompts carry only bounded
   semantic context; files are fetched on demand when the current turn refers to
   them.
8. Collaboration can be disabled and the existing independent bridges restored.
9. Hermes is never reinstalled and retains its existing state and commands.
10. A file or code revision delivered by any agent becomes a shared artifact with
    a digest, a visibility and a durable locator, so later authorized agents
    retrieve it from GitHub, Feishu or a configured provider without another user
    upload.

## Distributed Deployment

Agents should be able to run on different computers, operating-system users or
isolated execution environments without changing the Feishu experience. Users
still mention bots, inspect handoffs and receive files in one topic; Hub
addressing, node identity, artifact download and reconnect recovery belong to the
deployment and protocol layers.

Parts of that direction already work. The `worker` role, per-agent credentials,
remote Hub addressing, node and instance identity, and the Hub's single task
truth are implemented, and a worker node is exercised against a Hub running on
another machine over a private network. What remains is hardening: automatic
artifact download on the receiving side, recovery after a long disconnect,
credential rotation, limits and audit. The
[distributed roadmap](./DISTRIBUTED_DEPLOYMENT_ROADMAP.md) tracks capability
status and acceptance phases, including the second-machine acceptance gate.

Remote deployment must preserve the existing invariants: one Hub task truth,
independent Feishu identities, real notifications matched to formal authority,
and traceable artifacts with visibility controls.

## Required Implementation Shape

- Users select, transfer and consult naturally in one Feishu topic while the
  system carries authorized context.
- The Hub stores filtered shared task state while Agents keep independent model
  sessions.
- Shared content holds task facts, conclusions and artifacts; private reasoning,
  tool noise and secrets stay out.
- Complete history remains auditable, while model prompts use bounded semantic
  context and retrieve file details only when the current request references them.
- Auditable ownership, dispatch and routing enforce authority; prompts explain
  the rules to Agents.
- The Hub maintains one task truth and every Bot works from its projection.
- Only a truly mentioned and authorized Bot responds; explicit multi-selection
  enables parallel work.
- Every agent keeps its own manifest, task, credential and local journal, so a
  remote worker is additive and single-PC use does not change.
- A removable adapter preserves Hermes installation, state, commands and gateway.
- Feishu remains the user interface while the system carries protocol details.

## How To Judge A Change

Every feature and refactor should answer three questions:

1. Does it remove work the user would otherwise do, such as moving context
   between agents or managing agents by hand?
2. Does it make ownership, visibility and the next step clearer?
3. Does it keep every agent usable on its own and reversible?

If any answer is no, reconsider the implementation.
