import type { LanCatchUp, LedgerRecord, LanRunEventRecord } from './api';

/**
 * Merge the ledger stream and the run-event stream into one ordered
 * timeline. Pure logic — unit-tested without a DOM.
 */

export interface UserMessageItem {
  kind: 'userMessage';
  key: string;
  sequence: number;
  ts: string;
  username: string;
  content: string;
  mentions: string[];
}

export interface AgentActionItem {
  kind: 'agentAction';
  key: string;
  sequence: number;
  ts: string;
  action: string;
  actor: string;
  target?: string;
  content: string;
}

export interface RunItem {
  kind: 'run';
  key: string;
  runId: string;
  agentId?: string;
  ts: string;
  status: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; output?: string; isError?: boolean }>;
  error?: string;
  finished: boolean;
}

export type TimelineItem = UserMessageItem | AgentActionItem | RunItem;

function recordTs(record: LedgerRecord): string {
  const occurredAt = record.event.occurredAt;
  return typeof occurredAt === 'string' ? occurredAt : '';
}

/** Aggregate run events per runId into a single expanding block. */
export function buildRunItems(runs: LanRunEventRecord[]): RunItem[] {
  const byRun = new Map<string, RunItem>();
  const toolOutput = new Map<string, string>();
  for (const record of runs) {
    const existing = byRun.get(record.runId);
    if (!existing) {
      byRun.set(record.runId, {
        kind: 'run',
        key: `run-${record.runId}`,
        runId: record.runId,
        agentId: record.agentId,
        ts: record.createdAt,
        status: '',
        text: '',
        toolCalls: [],
        finished: false,
      });
    }
    const item = byRun.get(record.runId)!;
    if (record.agentId) item.agentId = record.agentId;
    switch (record.type) {
      case 'RUN_STARTED':
        item.status = 'running';
        break;
      case 'RUN_STATUS': {
        const status = record.status;
        if (typeof status === 'string') item.status = status;
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const delta = record.delta;
        if (typeof delta === 'string') item.text += delta;
        break;
      }
      case 'TOOL_CALL_STARTED': {
        const id = typeof record.id === 'string' ? record.id : `tool-${item.toolCalls.length}`;
        item.toolCalls.push({ id, name: String(record.name ?? 'tool') });
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const id = typeof record.id === 'string' ? record.id : undefined;
        const call = id ? item.toolCalls.find((entry) => entry.id === id) : item.toolCalls.at(-1);
        if (call) {
          if (typeof record.output === 'string') toolOutput.set(call.id, record.output);
          call.output = typeof record.output === 'string' ? record.output : call.output;
          call.isError = record.isError === true;
        }
        break;
      }
      case 'RUN_FINISHED':
        item.finished = true;
        item.status = 'finished';
        break;
      case 'RUN_ERROR':
        item.error = typeof record.message === 'string' ? record.message : 'run error';
        item.finished = true;
        item.status = 'error';
        break;
    }
  }
  return [...byRun.values()];
}

export function buildTimeline(ledger: LedgerRecord[], runs: LanRunEventRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const record of ledger) {
    if (record.event.kind === 'message') {
      const actor = record.event.actor as { type: string; id: string; name?: string } | undefined;
      const targets = record.event.targetAgentIds;
      items.push({
        kind: 'userMessage',
        key: `ledger-${record.sequence}`,
        sequence: record.sequence,
        ts: recordTs(record),
        username: actor?.name ?? actor?.id ?? 'user',
        content: String(record.event.content ?? ''),
        mentions: Array.isArray(targets) ? (targets as string[]) : [],
      });
    } else if (record.event.kind === 'action') {
      items.push({
        kind: 'agentAction',
        key: `ledger-${record.sequence}`,
        sequence: record.sequence,
        ts: recordTs(record),
        action: String(record.event.action ?? 'action'),
        actor: String(record.event.actorAgentId ?? 'agent'),
        target: typeof record.event.targetAgentId === 'string' ? record.event.targetAgentId : undefined,
        content: String(record.event.content ?? ''),
      });
    }
  }
  items.push(...buildRunItems(runs));
  items.sort((a, b) => {
    const ta = Date.parse(a.ts || '1970-01-01T00:00:00Z') || 0;
    const tb = Date.parse(b.ts || '1970-01-01T00:00:00Z') || 0;
    if (ta !== tb) return ta - tb;
    const sa = 'sequence' in a ? a.sequence : Number.MAX_SAFE_INTEGER;
    const sb = 'sequence' in b ? b.sequence : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });
  return items;
}

/**
 * Live state accumulator for one conversation: appends catch-up batches and
 * stream frames while tracking the dual cursors and deduplicating by ids.
 */
export class ConversationState {
  private ledger = new Map<number, LedgerRecord>();
  private runs = new Map<number, LanRunEventRecord>();
  cursor = { ledger: 0, runs: 0 };
  task: { id: string; status: string; participants: string[]; ownerAgentId?: string } | undefined;

  applyCatchUp(batch: LanCatchUp): void {
    for (const record of batch.ledger) this.ledger.set(record.sequence, record);
    for (const record of batch.runs) this.runs.set(record.streamId, record);
    this.cursor = batch.cursor;
  }

  applyLedgerRecord(record: LedgerRecord): void {
    if (record.sequence <= this.cursor.ledger) return; // already seen
    this.ledger.set(record.sequence, record);
    this.cursor = { ...this.cursor, ledger: record.sequence };
  }

  applyRunRecord(record: LanRunEventRecord): void {
    if (record.streamId <= this.cursor.runs) return;
    this.runs.set(record.streamId, record);
    this.cursor = { ...this.cursor, runs: record.streamId };
  }

  applyTask(task: ConversationState['task']): void {
    this.task = task;
  }

  timeline(): TimelineItem[] {
    return buildTimeline([...this.ledger.values()], [...this.runs.values()]);
  }

  dispatches(): Array<{ id: string; targetAgentId: string; reason: string; status: string; objective: string }> {
    const latest = new Map<string, { id: string; targetAgentId: string; reason: string; status: string; objective: string }>();
    for (const record of [...this.ledger.values()].sort((a, b) => a.sequence - b.sequence)) {
      const event = record.event;
      if (event.kind === 'dispatch' && typeof event.dispatchId === 'string') {
        latest.set(event.dispatchId, {
          id: event.dispatchId,
          targetAgentId: String(event.targetAgentId ?? ''),
          reason: String(event.reason ?? 'mention'),
          objective: String(event.objective ?? ''),
          status: 'pending',
        });
      } else if (event.kind === 'ack' && typeof event.dispatchId === 'string' && typeof event.status === 'string') {
        const dispatch = latest.get(event.dispatchId);
        if (dispatch) dispatch.status = event.status;
      }
    }
    return [...latest.values()];
  }
}
