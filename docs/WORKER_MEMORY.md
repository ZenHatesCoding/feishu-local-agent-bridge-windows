# Worker Topic Memory: Usage and Operations

[Project README](../README.md) | [中文](./WORKER_MEMORY.zh-CN.md) |
[Design and acceptance contract](./plans/WORKER_TOPIC_MEMORY.md) | [Windows operations](./WINDOWS_OPERATIONS.md)

## Capability and boundaries

Each logical bot instance owns a SQLite ledger, current task state, historical
summaries and source links. Feishu topics span fresh model sessions; model, name
and cwd do not define identity. The Hub neither synthesizes nor stores local
memory and grants no colocated-Worker filesystem privileges.

Implemented mechanisms include automatic loading, checkpoints, background and
foreground consolidation, hierarchical provenance, expansion, cumulative retrieval,
pinned constraints, parked work, retries, revisions and legacy import. Local
automation and host verification do not constitute second-machine Feishu acceptance;
older Workers must update to the same code version.

Complete means permitted observations, not every group message. Undelivered and
unattributed historical records remain unknown. Private reasoning and credentials
are not collected as task memory.

## Enablement and configuration

Pilot enables local memory by default. all/worker share the same implementation;
Worker memory never starts a Hub. Roots are `<pilot-state>/worker-memory/<agent-id>`;
new JSONL journals are per-instance and the old shared ledger remains unchanged.
Standalone bridges opt in with LARK_MEMORY_ENABLED=1; LARK_MEMORY_ROOT overrides
the profile-derived root.

Roots contain identity.json, memory.sqlite, blobs, host skills, bindings and jobs.
Do not share roots across bots. Preserve identity for a move; use a new root for a
new bot. Keep runtime state out of Git.

Optional global/per-agent Pilot configuration:

```json
{
  "memory": {
    "enabled": true,
    "maxMemoryTokens": 12000,
    "maintenance": { "backgroundEnabled": true }
  }
}
```

The allowed total is 4000–128000, bounding memory plus retrieval rather than the
entire native model window. Accounting conservatively uses UTF-8 bytes including
wrappers, never Chinese characters divided by four. Defaults reserve roughly
3000/4000/3000/2000 for state/summaries/recent/cumulative retrieval. Wrappers count;
optional summaries may be omitted. Effective critical constraints are not truncated.

Background-disabled instances skip idle/post-result synthesis; foreground may
still consolidate to cover history. Maintenance uses the existing model/login,
defaults to eight persisted model calls/hour and one structural repair per job,
and backs off five minutes on failure without losing originals.

## Agent tools

Every run receives worker_topic_memory containing state, recent records,
summaries, source IDs, parked counts and coverage. Host-specific SKILL.md assets
live in the Worker root and their path is provided. Minimal rules are always
injected. Global user instructions and native memory are not overwritten.

```text
lark-channel-bridge memory read
lark-channel-bridge memory search --query "report length"
lark-channel-bridge memory inspect --id <source-id>
lark-channel-bridge memory expand --id <source-id> --offset 0
lark-channel-bridge memory checkpoint --file candidate.json
```

Node inherits the run binding. Hermes adds the Hook-provided --binding file to
each command rather than racing over a global environment binding. Bound Node
local-context read/search calls forward to the same controlled views. Search
returns cards before expansion; pagination/cumulative budgets survive subprocesses.
Long originals are bounded parts with a complete text blob.

Checkpoint structure:

```json
{
  "baseRevision": 1,
  "through": 4,
  "items": [{
    "itemId": "report-length", "kind": "constraint", "text": "Three-page report",
    "status": "active", "sourceRefs": ["<actual-event-id>"],
    "evidenceLevel": "human-explicit", "pinned": true
  }],
  "summary": "User explicitly corrected the page count; originals remain available."
}
```

Source IDs must exist; advancing coverage requires a summary. Revisions, sources,
budgets and pins are checked. User decisions, agent claims and tool observations
have separate provenance. Changing/revoking pins requires new user evidence.
Dropped unfinished todos become searchable parked entries, not completed work.

## Failure and host boundaries

Empty/malformed output, fabricated sources, encoding damage, stale versions and
overflow reject publication rather than substituting truncation. Maintenance data
never enters Feishu/Hub action parsing. Claude/Hermes disable tools; Codex uses a
read-only sandbox; agy/Harness retain host permission boundaries, not OS-isolation
guarantees. Maintenance omits collaboration credentials and business Bridge prompts.

Execution continues when the raw tail covers unconsolidated history. Otherwise
consolidate first, then explicitly block dependent work if coverage remains
insufficient. Node marks the accepted dispatch failed and retains the message.
Native tool loops and session compression remain host responsibilities.

## Diagnosis, migration and recovery

Run administration outside a bound agent shell:

```powershell
node .\dist\cli.js memory status --root <instance-root> --owner <agent-id> --tenant <tenant-key>
node .\dist\cli.js memory doctor --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread>
node .\dist\cli.js memory migrate --root <instance-root> --owner <agent-id> --tenant <tenant-key> --file <legacy.jsonl>
node .\dist\cli.js memory export --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread> --file <new-export.jsonl>
node .\dist\cli.js memory backup --root <instance-root> --owner <agent-id> --tenant <tenant-key> --file <new-snapshot.sqlite>
node .\dist\cli.js memory rollback --root <instance-root> --owner <agent-id> --tenant <tenant-key> --scope <chat:thread> --revision 0
```

Status reports coverage, revisions, error/backoff, parked work and
legacyUnattributed, not content/credentials. Private jobs retain maintenance inputs
and candidates for diagnosis.

Default imports accept attributable records only; unknown rows remain in the old
file and are counted. Use --confirmed-owner only after confirming ownership and
visibility, never infer these from a shared directory. Reimport is idempotent;
damaged rows do not become facts.

Rollback creates a new revision, retaining originals and Hub ownership. Revision
zero clears derived state for rebuilding. Database backup uses a consistent SQLite
snapshot; a complete move also retains identity and blobs.

```powershell
.\scripts\collab-pilot\Restart-CollabAgent.ps1 -Agent <agent-id>
```

This restarts the real instance. Hermes stops the configured detached gateway,
confirms exit, installs the Hook and starts again instead of keeping old Python
modules loaded. No reinstall/login reset/native-memory replacement occurs.
Disable memory and restart to restore local-context behavior while retaining data.
Node 22.13+ uses built-in SQLite; Node 20 requires the pinned optional better-sqlite3
driver installed successfully.
