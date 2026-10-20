# Autonomous Worker Topic Memory Proposal

[Project README](../../README.md) | [中文](./WORKER_TOPIC_MEMORY.zh-CN.md) |
[Product vision](../PRODUCT_VISION.md) | [Collaboration design](../DESIGN.md)

Status: implementation design contract. Core storage, budgeting, retrieval,
maintenance and host integration have landed; see [Worker memory](../WORKER_MEMORY.md)
for current operations and boundaries. Second-machine Feishu acceptance remains
separate from local tests. Date: 2026-10-20.
Scope: local memory for existing Feishu Workers, excluding the separate LAN workbench.

## 1. Required outcome

Each Worker retains its complete authorized records and maintains updatable,
traceable, bounded memory for each topic. Memory survives agent restarts, fresh
model sessions and an explicit machine migration. An agent can follow summary
references back to precise originals. Loading, budget checks, maintenance
scheduling and reliable publication are runtime responsibilities, rather than
optional habits encouraged by a prompt.

Complete means actually received, executed or permissibly obtained by that Worker.
Messages Feishu did not deliver remain unknown; gaps are recorded. Completeness
does not authorize collecting secrets, private reasoning or other agents' sessions.

The first complete release must provide all of the following:

1. Independent Worker installation without a local Hub or another Worker's files.
2. Complete local records and derived memory per Worker instance and topic;
   duplication across instances is acceptable.
3. Automatic task-memory loading, bounded historical context and retrieval tools.
4. Automatic maintenance under pressure, retaining originals on failure and never
   presenting mechanical truncation as a successful semantic summary.
5. Continued handling of corrections, revoked decisions, unfinished work and evidence.
6. Safe restart, replay, concurrency and interruption behavior.
7. Equivalent capabilities for arbitrary agent names and roles, with separately
   implemented and verified host integrations.

An arbitrary history cannot fit losslessly into a fixed token window. The promise
is recoverable originals, explicit retention rules, bounded active context,
visible coverage gaps and demonstrated recall and continuation behavior.

## 2. References and design decisions

This is a project-specific design informed by existing mechanisms. None of the
reference projects becomes a mandatory runtime dependency.

| Reference | Useful mechanism | Project-specific decision |
| --- | --- | --- |
| lossless-claw | Original/summary separation, hierarchical provenance, budgeted assembly, expansion | Stable Feishu topics span fresh sessions; failed summaries remain pending |
| memU | Host-agent synthesis, prepare/commit workflow, host adapters | Independent instance configuration, storage and installation |
| Claude-Mem | Lifecycle integration and progressive retrieval | Topic boundaries replace cwd/project grouping |
| Hermes / Letta | Bounded editable memory, maintenance runs, version recovery | Separate current task state, historical summaries and native global memory |

References and inspected commits appear in section 18. The modules, interfaces,
starting budgets and acceptance criteria below are new design choices, not claims
about these projects' existing behavior.

## 3. Deployment responsibilities

Hub and Worker are deployment responsibilities. `role: all` colocates both; its
Workers gain no special access to the Hub database, other profiles or other Workers.

A Worker installation can host multiple agent instances. Each memory instance
belongs to a stable logical execution identity, not a process or an adapter type
such as `codex`. Multiple Codex bots can have independent instances.

```text
Feishu and remote Hub
        | authorized events, dispatches, results, Artifact references
        v
Worker Bridge / Hermes Hook
        +-- existing agent runtime and login
        +-- local memory runtime
              +-- complete authorized ledger
              +-- current task state
              +-- historical summaries and source index
              +-- retrieval, budgets, maintenance queue and recovery
```

The Hub remains responsible for task identity, ownership, dispatches,
authorization and shared Artifacts. Memory introduces no Hub API and adds no
summary publication or maintenance scheduling to the central ledger.

Maintenance inference uses the Worker's own agent/model configuration and
authentication. Local data and tooling do not imply offline model inference:
the configured model provider may still be remote.

## 4. Identity and conversation boundaries

Identity has three levels:

- `deploymentId`: stable identity of this collaboration installation.
- `workerInstanceId`: persisted logical agent-instance identity, unchanged by restart.
- `conversationKey`: `channel + tenantKey + chatId + threadId`.

Hash their normalized combination into `memoryScopeId`. Display name, model,
cwd, PID and provider session ID do not define continuity. Renaming a bot,
switching models or changing workspace does not erase topic memory.

Topics use stable thread IDs. Ordinary groups use a coarser chat scope; DMs use
a separate scope. Topic continuity spans fresh provider sessions. Hub taskId and
dispatchId are associations; current control state always comes from the Hub.

Explicit backup/restore preserves identity during a move and rebinds local paths.
Cloning into a new bot creates a new instance identity and marks imported sources.
Concurrent copies of one identity still require execution authorization from
existing scheduling; local memory locking does not solve duplicate execution
across computers.

## 5. Three independently maintained data classes

### 5.1 Complete ledger

Persist authorized inbound messages, own final results, Artifact references,
necessary execution evidence, corrections and actual delivery outcomes. Retain
the permitted original text, rather than summarizing and discarding at ingestion.
Large text goes into content-addressed blobs with hashes and lengths. Attachments
retain hashes, source locators and local materializations; binaries are not
automatically injected into prompts.

Do not indiscriminately ingest thinking events, credentials or every tool dump.
Evidence may include a command, observed exit status, bounded result and log
reference. Agent-reported success differs from tool-observed success.

Allocate a monotonically increasing per-topic `seq`; also retain source event ID,
source time and observation time. Late events append at a new seq without
rewriting processed order. Source IDs provide idempotency. Edits/deletions append
corrections; identical text alone is not a duplicate-event key.

### 5.2 Current task state

Agents maintain structured entries and immutable revisions, rendered within a budget:

| Entry | Content |
| --- | --- |
| Goal | Current objective, phase and acceptance conditions |
| Constraint | User requirements, prohibitions and fixed parameters, with important exact text |
| Decision | Adopted choices and explicit replacement/revocation relationships |
| Progress | Completed work, verification and undelivered results |
| Open work | Next actions, blockers and parked work |
| Evidence | Files, commits, Artifacts and original-record references |
| Hypothesis | Unverified judgments and disputes |

Common fields: `itemId, kind, text, status, sourceRefs, evidenceLevel, supersedes`.
Statuses include active, resolved, superseded, disputed and parked. Changes add,
replace or close entries; they do not require rewriting a free-form document on
every turn or populating every category for a short exchange.

Evidence levels include human-explicit, agent-reported and tool-observed. They
describe origin, not truth. Another agent's test claim remains a report unless
supported by verification; the model cannot manufacture tool-observed evidence.

Parked work remains indexed rather than completed. Relevant open work is visible;
large unrelated backlogs use paginated phase/topic indexes with unexpanded counts.

### 5.3 Historical summaries

Leaf summaries cover completed event ranges and link to originals. Higher nodes
link to lower summaries. Nodes carry time/seq ranges, key content, expansion
hints, source children and generation versions. Originals remain available.

Merge adjacent event ranges rather than mixing stages by keywords alone. Current
state marks revoked decisions explicitly; historical summaries retain what was
decided then. Retrieval returns relevant later corrections alongside old evidence.

Task state tracks current effective facts; summaries preserve history and evidence
navigation. They are not one text repeatedly shortened. Rebuilding can return to
leaf summaries or originals instead of perpetually trusting a previous digest.

## 6. Local persistence

Each logical instance owns its root; no machine-global shared memory database:

```text
<worker-state>/memory/
  identity.json
  memory.sqlite
  blobs/<sha256>
  skills/<host-specific-install-assets>
  backups/
  jobs/<job-id>/
```

SQLite holds authoritative events, state revisions, summary links and maintenance
progress. FTS is rebuildable. Markdown/JSONL are exports, backups or inspection
surfaces, rather than multiple writable authorities needing cross-file transactions.
Redundant storage is acceptable; transactions are selected for correctness.

| Table | Contract |
| --- | --- |
| topics | Unique scope, nextSeq, observed gaps, activity |
| events | `(topicId, seq)` primary key, unique source ID, text/blob references |
| source_links | External origins, Artifacts and corrections |
| state_revisions / state_items | Immutable revisions and structured entries |
| summaries / summary_sources | Nodes and event/child provenance |
| context_projections | Actual run inputs, versions, ranges, budgets and omissions |
| maintenance_jobs | Target range, baseRevision, input hash, status and retries |
| topic_leases | Local cross-process coordination and fencing generation |
| search_index | Rebuildable original/state/summary index |

Same text or filenames do not merge scopes. Blobs may be reused inside one Worker
root while their references retain topic visibility. The database resides on local
disk; network shares are not the mechanism for autonomous operation.

The selected SQLite driver must support the repository's Node baseline and Windows
installation, with a CI-verified pinned version. This feature must not silently
upgrade agents or global Node. Driver selection cannot weaken transaction contracts.

## 7. Lifecycle and precise coverage

### 7.1 Ingest

Capture observed events inside existing admission/authorization boundaries, with
source-ID idempotency. Copy authorized Hub material with provenance and visibility;
never read the Hub's filesystem or other agents' provider sessions. Recording an
unmentioned message does not wake the agent.

### 7.2 Prepare a business run

1. Bind instance, topic, run, dispatch and local access capability.
2. Capture `inputFence`. Later arrivals belong to a later preparation.
3. Read a consistent state revision, summary coverage, unprocessed events,
   corrections and Artifact metadata.
4. Assemble a bounded raw tail when sufficient; otherwise perform bounded necessary
   maintenance or enter an explicit degraded state.
5. Supply the memory packet, tool entry points and budget before starting work.

Deduplicate the current message, dispatch and recent ledger entries by origin ID,
preserving the user's actual current instruction in its priority location.

### 7.3 Checkpoint during execution

After meaningful decisions, corrections, verification or stage completion, the
agent submits structured changes and sources. Tools stage a candidate and cannot
target another instance/database, advance beyond inputFence, or perform Hub
handoff/complete actions.

New evidence is first recorded as a run-associated event. Sources may reference
read inputs up to inputFence and newly persisted evidence bound to this runId;
the latter must not mark intervening, unread arrivals as processed. Unfinished actions
remain plans/in-progress. Candidates carry `baseRevision`, `runId`, `inputFence` and source
IDs. Validate and commit atomically. A stale revision requires rereading/revising;
last-writer-wins replacement is forbidden.

### 7.4 Finalize

Reliably record actual result and termination status, associate valid candidates,
then follow the existing Bridge delivery/collaboration lifecycle. Distinguish work
completion, Feishu delivery and Hub finalization; creating a file is not delivery.

New output, missing checkpoints or delivery failures mark maintenance debt. A memory
failure does not relabel successful business work as failed; retain original output,
failure details and recovery work. An extra complete-model summary is not required
after every turn.

### 7.5 Coverage fields

- `observedThrough`: reliably persisted frontier.
- `stateThrough`: contiguous processed prefix; new run evidence beyond it has an
  explicit coverage set and cannot advance the prefix across unread gaps.
- `summaryCoverage`: covered ranges and explicit nonsemantic exclusions.
- `inputFence`: maximum inputs available to one run.

Persisted does not mean summarized; a raw tail may cover unprocessed content. Every
projection identifies the state, summaries and originals carrying its ranges, plus
remaining unexpanded material. One summary must not advance a universal cursor
over content it did not process.

## 8. Budgets and context assembly

### 8.1 Separate runtime budgets

Workers bound generated memory packets, attachment excerpts and retrieval results.
The host controls native system prompts, schemas, tool loops and provider-session
growth during one invocation. Measuring one memory string cannot prove the entire
agent invocation is bounded.

HostAdapters report known context capacity, input usage, compression/reset support
and usage telemetry. Unknown overhead receives conservative reserves and explicit
diagnostics; unknown capacity is not unlimited. Hermes retains ownership of native
session compression; topic memory remains an independent recovery layer.

Available input is model capacity minus output, host, tool/multimodal and safety
reserves. Allocate the remainder between the current input and memory. Count final
rendering/wrappers. Use model tokenizers where available; otherwise use conservative
byte bounds and structural reserves, never a fixed four-characters-per-token Chinese
estimate.

### 8.2 Starting policy

These are tunable starting values requiring workload validation:

| Allocation | Initial maximum |
| --- | --- |
| Memory per business run | 12,000 tokens, further limited by remaining model capacity |
| Current task state | 3,000 tokens |
| Historical summaries | 4,000 tokens |
| Recent originals | 3,000 tokens |
| Cumulative retrieval reserve | 2,000 tokens |

Categories borrow unused capacity within the total. Retrieval is cumulative per
run, not a fresh allowance per call. Current messages/images/attachments consume
their input allocation first; optional history shrinks when needed. Large
attachments use references and paginated excerpts.

### 8.3 Selection

Prioritize current instructions, active critical constraints, goals, relevant open
work and corrections; then recent originals; then relevant historical summaries
and evidence navigation. Avoid triplicating facts across state, summaries and tail.
Exact parameters required for execution must remain precise.

Packets include revision, coverage, remaining retrieval allowance, gaps and
unexpanded indexes as internal metadata, not visible chat content.

### 8.4 Critical information exceeding capacity

An arbitrary amount of simultaneously required detail cannot fit a fixed window.
Merge equivalent entries, remove obsolete constraints, reclaim optional history
and retrieve applicable originals. If still too large, retain data and execute
explicit dependent stages or report the need to narrow the current objective.
Never silently truncate requirements and claim completeness. Pinned entries cannot
be silently evicted; an over-budget pin returns a capacity conflict and retains
its candidate and source.

## 9. Automatic maintenance

### 9.1 Triggers

- After results: missing state updates, significant goals/decisions, stage transitions,
  handoffs and corrections.
- Before execution: backlog cannot fit the raw tail or the packet approaches budget.
- While idle: existing pending work; no new content means no model calls.
- Explicit operations: rebuild ranges, correct memory and inspect integrity.

Triggers use new-content size, state transitions, coverage and actual budgets,
not message counts alone or periodic whole-ledger rereading.

### 9.2 Jobs and publication

`update-state` proposes structured changes from current state/new events;
`summarize-range` creates leaf summaries; `condense-nodes` merges adjacent summaries;
`rebuild-range` returns to lower sources after an error. These are local maintenance
jobs, not Hub dispatches or Feishu mentions.

Fix bounded inputs/output budget and persist input hash/version before inference.
Do not hold database write locks during inference. Validate sources, coverage,
length, revision and fencing before atomic publication.

Oversized output may receive a bounded repair attempt. Empty output, fabricated
sources, discontinuous coverage or lost critical constraints reject publication.
Retain old state/debt; do not present a substring fallback as semantic success.

### 9.3 Scheduling and failure

Business checkpoints normally update state; idle work fills historical summaries.
Foreground preparation and small necessary consolidation take precedence over
unrelated maintenance. Limit maintenance concurrency, input/output, timeouts,
calls and cost per instance. Exhaustion leaves visible debt, not infinite retries.

If bounded raw context covers missing consolidation, normal work continues. If
critical state is stale and uncovered material cannot fit, defer dependent work
and explain the blocker. Independent new requests may proceed without pretending
to know complete history. Maintenance failure grants no collaboration authority.

### 9.4 Model execution

Default to the Worker's existing agent configuration; allow an explicit maintenance
model without requiring a new API key. Prefer host-supported tool-free inference
with only selected records, state and an output schema. Maintenance output is data:
it never enters Feishu output, marker parsing, Artifact publishing or business
completion paths.

Probe tool-free/structured-output/model-selection capabilities on real CLIs.
Hosts without a reliable independent maintenance invocation must fulfill the same
contract through native hooks/in-turn tools, or be marked unaccepted. Installing a
Skill alone is insufficient. Same-user filesystem permissions are not strong
isolation, and prompts cannot guarantee prevention of all unauthorized access.

## 10. Retrieval and expansion

The baseline does not require an external vector service. Provide exact ID,
date/range, status/type and keyword retrieval with Chinese-capable full text.
Index Chinese short terms/character groups and English identifiers; test short
Chinese queries, numbers, error codes and paths rather than assuming English
tokenization works. Semantic retrieval can later be a local optional enhancement.

1. `search`: bounded cards with source ID, time, type, snippet and corrections.
2. `inspect`: neighboring events or summary structure and available expansion hints.
3. `expand/read`: originals by ID/range/child, paginated against cumulative run budget.

Default tools bind the current topic; scope filtering is not a model habit.
Cross-topic reads require a separate explicit authorization. Missing evidence
returns no match and available coverage, not invention. Scans, result sets and
serialization remain bounded.

File references distinguish locator, hash, historical local path and current
materialization. Validate paths before use. Memory uses existing Artifact
transport rather than silently introducing another remote-download subsystem.

## 11. Runtime and tool contracts

Proposed local interface, not an existing API:

```ts
interface WorkerMemoryRuntime {
  ingest(binding: WorkerBinding, events: ObservedEvent[]): Promise<IngestResult>;
  prepare(binding: RunBinding, budget: ContextBudget): Promise<PreparedMemory>;
  checkpoint(binding: RunBinding, change: MemoryChange): Promise<CheckpointResult>;
  query(binding: RunBinding, request: MemoryQuery): Promise<BoundedMemoryResult>;
  finalize(binding: RunBinding, result: ObservedRunResult): Promise<void>;
  maintain(binding: WorkerBinding, limits: MaintenanceLimits): Promise<MaintenanceResult>;
}
```

The CLI exposes the same implementation:

```text
lark-channel-bridge memory status
lark-channel-bridge memory read
lark-channel-bridge memory search --query "constraint changes"
lark-channel-bridge memory inspect --id <id>
lark-channel-bridge memory expand --id <id>
lark-channel-bridge memory checkpoint --file <candidate.json>
```

Normal agent calls supply no agentId, topic directory or database path. The Bridge
binds them through the run environment/local binding file. Preserve existing
`local-context read/search --scope` as compatibility read views. Unbound local
administration may explicitly select instance/topic, not infer authority from text.

Checkpoint outcomes include accepted, no_change, stale_revision, invalid_sources
and over_budget, with actionable revision/details. A model's claim to have saved
memory is not a successful write.

Persist cumulative retrieval usage by run across CLI subprocesses. Exhaustion
returns pagination handles and allowance. Reallocation requires prepare to build
a new packet, rather than model-selected bypasses.

## 12. Host integration and Skills

The behavioral contract is common; host engineering is separate and never names
World, Justice or other roles:

| Host | Lifecycle | Tools/instructions | Acceptance focus |
| --- | --- | --- | --- |
| Codex | Node prepare/finalize, fresh group sessions retained | Profile-specific Skill/rules and CLI | Fresh-session continuity, scrubbed environment |
| Claude Code | Same Bridge lifecycle, optional native hooks | Its own Skill/instruction installation | Headless tools, no duplicate hook writes |
| Antigravity | Automatic packet, actual agy capabilities | Supported instructions/Skills/commands | Batch output, genuine headless mode |
| DeepSeek Harness | Independent adapter preparation/finalization | Current headless profile tools/Skills | Entry point, profile, maintenance invocation |
| Hermes | Removable Hook/provider, existing memory preserved | Native directories/hooks | Global versus topic memory, no duplicate injection |

Each host may ship its own SKILL.md, installation guide and lifecycle scripts.
Necessary duplication is acceptable. Installation records owned files/versions;
updates/removal affect only those assets, never overwrite user instructions,
native memory or logins globally.

Skills explain current-state reading, conflict verification, facts versus hypotheses,
ID-based updates, stage checkpoints, consolidation and failed-write handling.
Runtime supplies mandatory loading/triggers. Agents need not know their bot nicknames.

New hosts implement capabilities, binding, tools, maintenance, installation/removal
and contract tests. Retrieval-only integration is not full support and must be
reported as partial.

Configuration inherits optional per-instance defaults; two instances of the same
adapter may override independently. Proposed minimum configuration, valid only
after implementation:

```json
{
  "memory": {
    "enabled": true,
    "maxMemoryTokens": 12000,
    "maintenance": {
      "backgroundEnabled": true,
      "useAgentModel": true
    }
  }
}
```

Derive and persist state root/identity from the current profile; users need not
configure databases, indexes or summary trees. After complete acceptance, enable
new installations; existing installations first complete reversible migration
and attribution checks. Advanced model choices are optional, and neither new keys
nor uniform host directories are prerequisites.

## 13. Consistency and recovery

- Serialize short writes per topic; database uniqueness replaces process-local Sets.
- Use local cross-process topic leases/fencing so expired jobs cannot publish.
- Check baseRevision for business and maintenance candidates; conflicts do not
  roll back original ingestion.
- Never hold long locks during inference. Publish provenance and state atomically.
- Write/check blobs before references; orphan blobs are cleanable after crashes.
- Recover pending/running jobs by checking hashes/revisions, not trusting stale outputs.
- Publish idempotently without duplicate summaries or coverage advancement.
- Rollback creates a new derived revision and rechecks subsequent events; it never
  rolls back source facts or Hub ownership.
- Back up using consistent SQLite snapshots and blob manifests, not arbitrary copies
  of active WAL files.

Retain source/trust classification. Historical commands remain historical content,
not system instructions. Current Hub authority overrides old remembered permissions.
Provide explicit export, forgetting and cleanup operations; deletion of authorized
source data rebuilds affected derived nodes.

## 14. Migration, compatibility and rollback

Preserve the shared legacy JSONL unchanged. New imports record file fingerprints,
line origins and attribution evidence. Copy confidently attributable records into
instances, allowing N copies. Existing bot-result entries may omit authors: do
not infer ownership from directories. Uncertain records remain read-only legacy
archives until explicit visibility confirmation; never invent personal completion.

Import a bounded file snapshot, then its appended delta, so running bots do not
cause missed records. File/source identities make retries idempotent. Version and
back up schema migrations.

Keep schema-v1, omitted-role and all-role compatibility. Memory configuration is
additive. Worker mode configures its own state and existing Hub connection; it does
not start a Hub for memory. Disabling memory restores existing local-context views
and retains databases, originals, credentials and Artifacts.

## 15. Observability

Local status/doctor shows revision, event/summary coverage, pending size, last
maintenance, input/retrieval tokens, calls/cost, retries, gaps and degradation.
Default diagnostics omit content and credentials.

Projection manifests record selected state/summary/original IDs, budgets, omissions,
capacity and telemetry support. Diagnose not received, unprocessed, summary omission,
retrieval miss and model error separately.

Routine maintenance stays quiet in Feishu. Report only blockers, consequential gaps
or required user tradeoffs. Operators can inspect sources, mark errors, rebuild,
restore revisions and export a complete topic.

## 16. Code boundaries and implementation order

Add `src/memory/` modules for scope, store, events, state, summaries, projection,
budget, retrieval, maintenance, migration and host contracts. Add
`src/cli/commands/memory.ts`; route old local-context reads through the same layer.
Node channel/run-flow performs lifecycle integration. Hermes uses the local CLI
or equivalent bindings rather than a second summary/budget implementation.

Pilot adds instance roots, host-owned installation assets and maintenance startup
options, not summary semantics. Hub state machine/APIs remain unchanged. Update
paired documentation and capability status with implementation. Existing roadmap
prompt-projection descriptions partly differ from code and must be reconciled;
they are not evidence that summaries already exist.

Engineering order for one complete delivery:

1. Contracts/fixtures, durable records, scopes, idempotency, migration and queries.
2. Structured state, source validation, revisions, checkpoint and recovery.
3. Summary lineage, assembly, expansion and cumulative retrieval accounting.
4. Maintenance queue, model adapter, retries and foreground/background coordination.
5. All maintained host integrations, instance installation/removal and operations.
6. Fault testing, real hosts and independent-machine acceptance, then evidence-based
   default enablement.

Do not label a system without automatic maintenance complete. Do not estimate AI
coding effort by calendar days; assess completion against the following contracts.

## 17. Acceptance

### 17.1 Deterministic contracts

| Scenario | Required behavior |
| --- | --- |
| Same-type bots, cwd and topic names | Correct instance/topic binding without nickname inference |
| Interleaved topics, late/duplicate events | No leakage/duplicate ingestion; preserve corrections |
| Kill during publication | Originals intact, no partial nodes or skipped coverage |
| Old maintenance versus new checkpoint | Revision/fence blocks stale publication |
| Empty/long/fabricated model output | Reject, retain debt, never fake success by truncation |
| Chinese, numbers, paths, large results | Bounded assembly/retrieval and exact ID lookup |
| Repeated CLI subprocess queries | Shared cumulative run allowance |
| Replayed migration and rollback | Idempotent, original state/login unchanged |
| Hub down or absent locally | Local read/search/checkpoint/maintenance independent |
| Collaboration markers inside memory | No dispatch, Feishu output or business completion |

### 17.2 Real-model behavior

Use versioned Chinese long-topic fixtures, not only mocked summarizers:

- Early constraints later referenced and explicitly changed: latest requirement
  applies with correct evidence.
- Conflicting agent judgments: retain disputes, do not turn consensus into user decisions.
- Exact numbers, paths, commits and attachments hundreds of turns earlier: expand to originals.
- Many completed tasks and a few persistent open items: continue correctly.
- Nearly identical topics: no imported decisions from another topic.
- Large messages/files: preserve references and retrieve necessary detail.
- Critical requirements over capacity: explicit resolution rather than silent loss.
- Incorrect first summary: identify, trace and rebuild rather than compound errors.

All specified critical constraints must pass; evidence lookup returns correct event/
Artifact IDs. Other tasks use inspectable expected answers, sources and actual work
results, not model grades alone. Record repeated trials and failures per model.

### 17.3 Scale, cost and deployment

Exercise topics many times larger than context capacity and multiple topics. Memory
injection must not grow linearly with total history; retrieval stays bounded and
turns do not load the entire installation's history. Test 10,000- and 100,000-record
datasets and report measured latency, RAM and disk rather than invented millisecond
promises. Record additional inference/cost and verify zero maintenance calls without
new data.

For every supported host verify headless load, update, retrieval, consolidation,
restart, failure recovery and removal. Perform a real independent Worker-machine
test without a local Hub or central-ledger copy, collaborating through a remote
Hub while maintaining local memory. Colocated Workers use identical assets and
interfaces. Automated isolation tests do not replace second-machine Feishu acceptance.

Implementation must pass relevant authorization, visibility, idempotency, Pilot and
navigation tests plus `pnpm test`, `pnpm typecheck`, `pnpm build` and
`git diff --check`. Pilot changes additionally require PowerShell parsing and safe
configuration validation.

## 18. Mechanism references

- [lossless-claw architecture](https://github.com/Martian-Engineering/lossless-claw/blob/15fc9d6156817d165c49eeb6e1a9316abb73b0c6/docs/architecture.md): lineage, ingestion, assembly and expansion; failure truncation is not adopted.
- [lossless-claw assembler](https://github.com/Martian-Engineering/lossless-claw/blob/15fc9d6156817d165c49eeb6e1a9316abb73b0c6/src/assembler.ts): actual budget/native-message complexity.
- [memU HostSpec](https://github.com/NevaMind-AI/memU/blob/42ef9fa3a8034f5817684cba23ef69fa70a58197/src/memu/hosts/host_cli.py): host-specific paths, Skills and scheduling.
- [memU MemoryService](https://github.com/NevaMind-AI/memU/blob/42ef9fa3a8034f5817684cba23ef69fa70a58197/src/memu/app/service.py): agent synthesis versus deterministic storage/retrieval.
- [Claude-Mem host integration](https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/docs/native-harness-integrations.md): capture/recall seams.
- [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md): bounded resident memory and history search.
- [Letta memory lifecycle](https://github.com/letta-ai/letta-docs-md/blob/main/configuration/memory/index.md): editable memory and background consolidation.

These are architectural references. Any later code reuse requires checking exact
files, versions, notices and dependencies; architectural inspiration is not an
already-reviewed third-party integration.
