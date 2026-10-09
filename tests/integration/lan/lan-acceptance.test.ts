import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LanSimTopology, type LanSimNodeSpec } from '../../../src/lan/sim';
import type { Dispatch, LedgerRecord, SharedArtifact } from '../../../src/collab/types';
import type { LanRunEventRecord } from '../../../src/lan/types';

let dataDir: string;
let topology: LanSimTopology;
let conversationId: string;

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

const nodes: LanSimNodeSpec[] = [
  { agentId: 'alpha', displayName: 'Alpha' },
  {
    agentId: 'beta',
    displayName: 'Beta',
    // Long-running answer so cancellation has time to propagate through the
    // heartbeat channel before the fake agent finishes on its own.
    script: [
      { delayMs: 800, status: 'starting the analysis' },
      { delayMs: 1200, text: 'Working through the data set...' },
      { delayMs: 1200, text: 'Beta finished the consultation with the final answer.' },
    ],
  },
];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lan-acceptance-'));
  // Short heartbeat timeout so the uncertain-scan test runs fast.
  topology = await LanSimTopology.start({ dataDir, nodes, heartbeatTimeoutMs: 1500 });
  const created = await topology.api('POST', '/api/conversations', { title: 'Delivery room' }) as {
    conversation: { id: string };
  };
  conversationId = created.conversation.id;
});

afterAll(async () => {
  await topology.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('LAN file delivery and worker lifecycle acceptance', () => {
  it('delivers a user-uploaded file to the dispatched agent with a verified digest', async () => {
    const payload = Buffer.from('quarterly,report,rows\n1,alpha,42\n', 'utf8');
    const upload = await fetch(`${topology.url}/api/files`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await topology.ownerToken()}`,
        'content-type': 'text/csv',
        'x-file-name': 'quarterly.csv',
        'x-conversation-id': conversationId,
      },
      body: payload,
    });
    expect(upload.ok).toBe(true);
    const uploaded = await upload.json() as { file: { id: string; sha256: string } };

    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Analyze the attached quarterly report.',
      targetAgentIds: ['alpha'],
    }) as { task: { id: string }; dispatches: Dispatch[] };

    // The dispatched agent's prompt context includes the conversation file.
    const promptContext = await agentApi(
      'alpha',
      'GET',
      `/api/agent/tasks/${sent.task.id}/prompt-context?dispatchId=${sent.dispatches[0]!.id}`,
    ).then((response) => response.json() as Promise<{ promptContext: string }>);
    expect(promptContext.promptContext).toContain('quarterly.csv');

    // The agent downloads through its own credential and verifies the digest.
    const download = await agentApi('alpha', 'GET', `/api/agent/files/${uploaded.file.id}`);
    expect(download.ok).toBe(true);
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
    expect(download.headers.get('x-file-sha256')).toBe(uploaded.file.sha256);

    // An anonymous download is rejected.
    const anonymous = await fetch(`${topology.url}/api/files/${uploaded.file.id}`);
    expect(anonymous.status).toBe(401);

    await waitFor(() => {
      const dispatch = topology.center.hub.getDispatch(sent.dispatches[0]!.id);
      return dispatch?.status === 'completed' ? dispatch : undefined;
    });
  }, 15000);

  it('marks a stalled attempt uncertain after heartbeat timeout and recovers via requeue', async () => {
    await topology.pauseWorker('alpha');
    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Stall this one.',
      targetAgentIds: ['alpha'],
    }) as { dispatches: Dispatch[] };
    const dispatch = sent.dispatches[0]!;
    const claim = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/claim`, {
      instanceId: 'stalled-instance',
    });
    expect(claim.ok).toBe(true);
    const { attemptId } = await claim.json() as { attemptId: string };

    // No heartbeats: the center's scan flips the attempt to uncertain.
    await waitFor(() => {
      const attempt = topology.center.store.getAttempt(attemptId);
      return attempt?.state === 'uncertain' ? attempt : undefined;
    }, { timeoutMs: 5000 });

    // The stalled instance is fenced out of completing.
    const fenced = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/complete`, {
      attemptId,
      runId: 'run-stalled',
      status: 'completed',
    });
    expect(fenced.status).toBe(409);

    // The user requeues; the resumed worker claims a fresh attempt and completes.
    const requeue = await topology.api('POST', `/api/dispatches/${dispatch.id}/requeue`);
    expect(requeue).toEqual({ ok: true });
    await topology.resumeWorker('alpha');
    await waitFor(() => {
      const latest = topology.center.hub.getDispatch(dispatch.id);
      return latest?.status === 'completed' ? latest : undefined;
    });
  }, 20000);

  it('runs a full ask/return consultation cycle and wakes the owner', async () => {
    await topology.pauseWorker('alpha');
    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Decide the rollout strategy.',
      targetAgentIds: ['alpha'],
    }) as { task: { id: string }; dispatches: Dispatch[] };
    const dispatch = sent.dispatches[0]!;
    const claim = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/claim`, {
      instanceId: 'ask-owner',
    });
    const { attemptId } = await claim.json() as { attemptId: string };
    // Keep the manual attempt alive while beta runs (short heartbeat timeout).
    const heartbeat = setInterval(() => {
      void agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/heartbeat`, { attemptId });
    }, 400);

    // Alpha consults beta through the structured ask action.
    const ask = await agentApi('alpha', 'POST', '/api/agent/events', {
      type: 'ask',
      idempotencyKey: `lan-ask:${dispatch.id}`,
      taskId: sent.task.id,
      actorAgentId: 'alpha',
      causedByDispatchId: dispatch.id,
      targetAgentId: 'beta',
      content: 'Which database migration window is safest?',
    });
    expect(ask.ok).toBe(true);

    // Beta's live worker answers; the return action wakes alpha with a return dispatch.
    const returnDispatch = await waitFor((): Dispatch | undefined => {
      const dispatches = topology.center.hub.listTaskDispatches(sent.task.id);
      return dispatches.find((item) => item.reason === 'return' && item.status === 'pending')
        ?? dispatches.find((item) => item.reason === 'return' && item.status === 'completed');
    });
    expect(returnDispatch.targetAgentId).toBe('alpha');
    expect(returnDispatch.reason).toBe('return');

    // Alpha finishes its own dispatch once consulted.
    const completed = await agentApi('alpha', 'POST', `/api/agent/dispatches/${dispatch.id}/complete`, {
      attemptId,
      runId: 'run-ask-owner',
      status: 'completed',
    });
    clearInterval(heartbeat);
    expect(completed.ok).toBe(true);
    await topology.resumeWorker('alpha');

    // The ledger shows the ask and return actions as structured events.
    const state = await topology.api('GET', `/api/conversations/${conversationId}/events`) as { ledger: LedgerRecord[] };
    const actions = state.ledger
      .map((record) => record.event)
      .filter((event) => event.kind === 'action');
    expect(actions.some((event) => event.action === 'ask' && event.actorAgentId === 'alpha')).toBe(true);
    expect(actions.some((event) => event.action === 'return' && event.actorAgentId === 'beta')).toBe(true);
  }, 20000);

  it('cancels a running task and fences late results', async () => {
    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Long analysis for cancellation.',
      targetAgentIds: ['beta'],
    }) as { task: { id: string }; dispatches: Dispatch[] };
    const dispatch = sent.dispatches[0]!;

    // Wait until beta is actively running, then cancel from the workbench.
    await waitFor(() => {
      const attempts = topology.center.store.attemptsForDispatch(dispatch.id);
      return attempts.some((attempt) => attempt.state === 'active') ? true : undefined;
    });
    const cancel = await topology.api('POST', `/api/conversations/${conversationId}/cancel`);
    expect(cancel).toEqual({ ok: true });

    // The worker observes the cancel through its heartbeat (interval 500ms)
    // and stops the run; the attempt ends failed and the task reads canceled.
    await waitFor(() => {
      const latest = topology.center.hub.getDispatch(dispatch.id);
      return latest?.status === 'failed' ? latest : undefined;
    }, { timeoutMs: 15000 });
    const conversations = await topology.api('GET', '/api/conversations') as {
      conversations: Array<{ id: string; state: string }>;
    };
    const current = conversations.conversations.find((item) => item.id === conversationId)!;
    expect(current.state).toBe('canceled');
  }, 20000);

  it('streams run progress events through the workbench event feed', async () => {
    // Fresh conversation: the previous one was canceled and stays canceled.
    const created = await topology.api('POST', '/api/conversations', { title: 'Streaming room' }) as {
      conversation: { id: string };
    };
    const streamConversation = created.conversation.id;
    const sent = await topology.api('POST', `/api/conversations/${streamConversation}/messages`, {
      content: 'Stream the progress please.',
      targetAgentIds: ['beta'],
    }) as { task: { id: string } };
    const runs = await waitFor((): LanRunEventRecord[] | undefined => {
      const events = topology.center.store.runEventsAfter(streamConversation, 0, 500);
      return events.some((event) => event.type === 'RUN_STARTED')
        && events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT')
        ? events
        : undefined;
    });
    expect(runs.some((event) => event.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    await waitFor(() => {
      const events = topology.center.store.runEventsAfter(streamConversation, 0, 500);
      return events.some((event) => event.type === 'RUN_FINISHED') ? events : undefined;
    });
    // Run events carry the task binding for the workbench timeline.
    expect(runs.every((event) => event.taskId === sent.task.id || event.type === 'RUN_STARTED')).toBe(true);
  }, 15000);
});
