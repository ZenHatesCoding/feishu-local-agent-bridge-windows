import { describe, expect, it } from 'vitest';
import {
  buildRunItems,
  buildTimeline,
  ConversationState,
} from './timeline';
import type { LanCatchUp, LanRunEventRecord, LedgerRecord } from './api';

function ledgerRecord(sequence: number, event: LedgerRecord['event'], occurredAt: string): LedgerRecord {
  return { sequence, taskId: 'task-1', event: { ...event, occurredAt } };
}

function runRecord(streamId: number, runId: string, type: LanRunEventRecord['type'], createdAt: string, extra: Record<string, unknown> = {}): LanRunEventRecord {
  return {
    streamId,
    conversationId: 'conv-1',
    taskId: 'task-1',
    runId,
    type,
    createdAt,
    ...extra,
  };
}

describe('buildTimeline', () => {
  it('turns user messages and agent actions into ordered items', () => {
    const ledger = [
      ledgerRecord(1, { kind: 'message', content: '请分析报告', targetAgentIds: ['alpha'], actor: { type: 'human', id: 'owner', name: 'Owner' } }, '2026-01-01T00:00:01Z'),
      ledgerRecord(2, { kind: 'action', action: 'handoff', actorAgentId: 'alpha', targetAgentId: 'beta', content: '移交数据库检查' }, '2026-01-01T00:00:03Z'),
    ];
    const items = buildTimeline(ledger, []);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'userMessage', username: 'Owner', mentions: ['alpha'] });
    expect(items[1]).toMatchObject({ kind: 'agentAction', action: 'handoff', actor: 'alpha', target: 'beta' });
  });

  it('aggregates run events into one block with streamed text and tools', () => {
    const runs = [
      runRecord(1, 'run-1', 'RUN_STARTED', '2026-01-01T00:00:02Z', { agentId: 'alpha' }),
      runRecord(2, 'run-1', 'TEXT_MESSAGE_CONTENT', '2026-01-01T00:00:02Z', { delta: '第一段。' }),
      runRecord(3, 'run-1', 'TOOL_CALL_STARTED', '2026-01-01T00:00:04Z', { id: 'tool-1', name: 'read_file' }),
      runRecord(4, 'run-1', 'TOOL_CALL_RESULT', '2026-01-01T00:00:05Z', { id: 'tool-1', output: 'contents' }),
      runRecord(5, 'run-1', 'TEXT_MESSAGE_CONTENT', '2026-01-01T00:00:06Z', { delta: '第二段。' }),
      runRecord(6, 'run-1', 'RUN_FINISHED', '2026-01-01T00:00:07Z'),
    ];
    const items = buildRunItems(runs);
    expect(items).toHaveLength(1);
    const run = items[0]!;
    expect(run.text).toBe('第一段。第二段。');
    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0]).toMatchObject({ id: 'tool-1', name: 'read_file', output: 'contents' });
    expect(run.finished).toBe(true);
    expect(run.status).toBe('finished');
  });

  it('marks a run errored and keeps partial text', () => {
    const runs = [
      runRecord(1, 'run-2', 'RUN_STARTED', '2026-01-01T00:00:01Z', { agentId: 'beta' }),
      runRecord(2, 'run-2', 'TEXT_MESSAGE_CONTENT', '2026-01-01T00:00:02Z', { delta: '进行中' }),
      runRecord(3, 'run-2', 'RUN_ERROR', '2026-01-01T00:00:03Z', { message: 'stopped' }),
    ];
    const [run] = buildRunItems(runs);
    expect(run?.error).toBe('stopped');
    expect(run?.status).toBe('error');
    expect(run?.text).toBe('进行中');
  });
});

describe('ConversationState', () => {
  it('deduplicates catch-up and live records and tracks cursors', () => {
    const state = new ConversationState();
    const record = ledgerRecord(1, { kind: 'message', content: 'hi', targetAgentIds: [], actor: { type: 'human', id: 'owner' } }, '2026-01-01T00:00:01Z');
    const batch: LanCatchUp = {
      ledger: [record],
      runs: [runRecord(10, 'run-1', 'RUN_STARTED', '2026-01-01T00:00:02Z')],
      cursor: { ledger: 1, runs: 10 },
    };
    state.applyCatchUp(batch);
    // Replays below the cursor are ignored.
    state.applyLedgerRecord(record);
    expect(state.cursor).toEqual({ ledger: 1, runs: 10 });
    expect(state.timeline()).toHaveLength(2);

    const next = ledgerRecord(2, { kind: 'action', action: 'return', actorAgentId: 'alpha', content: 'done' }, '2026-01-01T00:00:03Z');
    state.applyLedgerRecord(next);
    expect(state.cursor.ledger).toBe(2);
    expect(state.timeline()).toHaveLength(3);
  });

  it('derives dispatch statuses from dispatch and ack ledger events', () => {
    const state = new ConversationState();
    state.applyCatchUp({
      ledger: [
        ledgerRecord(1, { kind: 'dispatch', dispatchId: 'd-1', targetAgentId: 'alpha', reason: 'mention', objective: '分析', sourceSequence: 0, hop: 1 }, '2026-01-01T00:00:01Z'),
        ledgerRecord(2, { kind: 'ack', dispatchId: 'd-1', agentId: 'alpha', status: 'accepted' }, '2026-01-01T00:00:02Z'),
        ledgerRecord(3, { kind: 'ack', dispatchId: 'd-1', agentId: 'alpha', status: 'completed' }, '2026-01-01T00:00:03Z'),
      ],
      runs: [],
      cursor: { ledger: 3, runs: 0 },
    });
    expect(state.dispatches()).toEqual([
      { id: 'd-1', targetAgentId: 'alpha', reason: 'mention', objective: '分析', status: 'completed' },
    ]);
  });
});
