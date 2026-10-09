import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LanSimTopology, type LanSimNodeSpec } from '../../../src/lan/sim';
import type { Dispatch, LedgerRecord } from '../../../src/collab/types';

let dataDir: string;
let topology: LanSimTopology;
let conversationId: string;

const nodes: LanSimNodeSpec[] = [
  {
    agentId: 'alpha',
    displayName: 'Alpha',
    script: [
      { delayMs: 10, status: 'reading the task' },
      { delayMs: 10, text: 'Alpha analyzed the request and produced the summary.' },
    ],
  },
  { agentId: 'beta', displayName: 'Beta' },
];

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  { timeoutMs = 8000, intervalMs = 80 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false && value !== null) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out${lastError ? `: ${(lastError as Error).message}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function agentApi(
  agentId: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = topology.center.agentToken(agentId)!;
  return fetch(`${topology.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function events(): Promise<LedgerRecord[]> {
  const state = await topology.api('GET', `/api/conversations/${conversationId}/events`) as { ledger: LedgerRecord[] };
  return state.ledger;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lan-core-'));
  topology = await LanSimTopology.start({ dataDir, nodes });
  const created = await topology.api('POST', '/api/conversations', { title: 'Acceptance room' }) as {
    conversation: { id: string };
  };
  conversationId = created.conversation.id;
});

afterAll(async () => {
  await topology.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('LAN center + worker core loop', () => {
  it('routes a user message to the mentioned agent only and hides the task from others', async () => {
    const result = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Summarize the quarterly report.',
      targetAgentIds: ['alpha'],
    }) as { task: { participants: string[]; id: string }; dispatches: Dispatch[] };
    expect(result.task.participants).toContain('alpha');
    expect(result.dispatches.map((dispatch) => dispatch.targetAgentId)).toEqual(['alpha']);

    // Alpha's worker completes the run (fake agent echo).
    await waitFor(async () => {
      const dispatch = topology.center.hub.getDispatch(result.dispatches[0]!.id);
      return dispatch?.status === 'completed' ? dispatch : undefined;
    });

    // Beta was never dispatched and cannot read this task's context.
    const betaDispatches = await agentApi('beta', 'GET', '/api/agent/dispatches')
      .then((response) => response.json() as Promise<{ dispatches: Dispatch[] }>);
    expect(betaDispatches.dispatches).toEqual([]);
    const foreign = await agentApi('beta', 'GET', `/api/agent/tasks/${result.task.id}/context?agentId=beta`);
    expect(foreign.ok).toBe(false);
  }, 15000);

  it('rejects a second claim of the same dispatch (dual-instance race)', async () => {
    await topology.pauseWorker('beta');
    const result = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Draft the migration plan.',
      targetAgentIds: ['beta'],
    }) as { dispatches: Dispatch[] };
    const dispatch = result.dispatches[0]!;
    const claim = (instanceId: string) =>
      agentApi('beta', 'POST', `/api/agent/dispatches/${dispatch.id}/claim`, { instanceId });
    const [first, second] = await Promise.all([claim('inst-race-1'), claim('inst-race-2')]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    // Release, then let the resumed worker finish the dispatch.
    const winner = first.ok ? first : second;
    const body = await winner.json() as { attemptId: string };
    const release = await agentApi('beta', 'POST', `/api/agent/dispatches/${dispatch.id}/release`, {
      attemptId: body.attemptId,
    });
    expect(release.ok).toBe(true);
    await topology.resumeWorker('beta');
    await waitFor(() => {
      const latest = topology.center.hub.getDispatch(dispatch.id);
      return latest?.status === 'completed' ? latest : undefined;
    });
  }, 20000);

  it('hands work off through a structured action and wakes the new owner', async () => {
    await topology.pauseWorker('alpha');
    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Prepare the deployment checklist.',
      targetAgentIds: ['alpha'],
    }) as { task: { id: string }; dispatches: Dispatch[] };
    const dispatch = sent.dispatches[0]!;
    const claim = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/claim`, {
      instanceId: 'manual-alpha',
    });
    expect(claim.ok).toBe(true);
    const { attemptId } = await claim.json() as { attemptId: string };

    // Alpha delegates to beta through the authorized Hub action.
    const handoff = await agentApi('alpha', 'POST', '/api/agent/events', {
      type: 'handoff',
      idempotencyKey: `lan-handoff:${dispatch.id}`,
      taskId: sent.task.id,
      actorAgentId: 'alpha',
      causedByDispatchId: dispatch.id,
      targetAgentId: 'beta',
      content: 'Prepare the deployment checklist for the staging server.',
    });
    expect(handoff.ok).toBe(true);
    const completed = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/complete`, {
      attemptId,
      runId: 'run-manual-alpha',
      status: 'completed',
    });
    expect(completed.ok).toBe(true);

    // Beta's live worker claims the handoff dispatch and finishes it.
    const handoffDispatch = await waitFor((): Dispatch | undefined => {
      const dispatches = topology.center.hub.listTaskDispatches(sent.task.id);
      return dispatches.find((item) => item.reason === 'handoff' && item.status === 'completed');
    });
    expect(handoffDispatch.targetAgentId).toBe('beta');
    await topology.resumeWorker('alpha');

    const records = await events();
    expect(records.some((record) =>
      record.event.kind === 'action' && record.event.action === 'handoff' && record.event.actorAgentId === 'alpha',
    )).toBe(true);
  }, 20000);

  it('is idempotent for duplicate user submissions', async () => {
    const first = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Repeat-proof question.',
      targetAgentIds: ['alpha'],
      idempotencyKey: 'dup-key-1',
    }) as { duplicate: boolean; dispatches: Dispatch[] };
    expect(first.duplicate).toBe(false);
    const second = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Repeat-proof question.',
      targetAgentIds: ['alpha'],
      idempotencyKey: 'dup-key-1',
    }) as { duplicate: boolean; dispatches: Dispatch[] };
    expect(second.duplicate).toBe(true);
    expect(second.dispatches.map((dispatch) => dispatch.id)).toContain(first.dispatches[0]!.id);
  });

  it('recovers full state after a center restart', async () => {
    const before = await topology.api('GET', '/api/conversations') as {
      conversations: Array<{ id: string }>;
    };
    await topology.stop();

    topology = await LanSimTopology.start({ dataDir, nodes });
    const after = await topology.api('GET', '/api/conversations') as {
      conversations: Array<{ id: string }>;
    };
    expect(after.conversations.map((conversation) => conversation.id).sort())
      .toEqual(before.conversations.map((conversation) => conversation.id).sort());
    const records = await events();
    expect(records.length).toBeGreaterThan(0);
  }, 20000);

  it('streams live events over SSE with catch-up cursors', async () => {
    const token = await topology.ownerToken();
    const controller = new AbortController();
    const stream = await fetch(
      `${topology.url}/api/conversations/${conversationId}/stream?token=${token}`,
      { signal: controller.signal },
    );
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const seenEvents = new Set<string>();
    const readChunk = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
        if (eventLine) seenEvents.add(eventLine.slice(7).trim());
        separator = buffer.indexOf('\n\n');
      }
    };
    await readChunk();
    await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'SSE probe message.',
      targetAgentIds: [],
    });
    await waitFor(async () => {
      await readChunk();
      return seenEvents.has('ledger') ? true : undefined;
    });
    controller.abort();
    expect(seenEvents.has('cursor')).toBe(true);
  }, 15000);
});
