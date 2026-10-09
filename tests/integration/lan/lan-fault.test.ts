import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LanSimTopology, type LanSimNodeSpec } from '../../../src/lan/sim';
import { LanFaultProxy } from '../../../src/lan/fault-proxy';
import { LanWorker } from '../../../src/lan/worker';
import type { Dispatch } from '../../../src/collab/types';

let dataDir: string;
let topology: LanSimTopology;
let proxy: LanFaultProxy;
let proxiedWorker: LanWorker | undefined;
let conversationId: string;

const nodes: LanSimNodeSpec[] = [
  { agentId: 'alpha', displayName: 'Alpha' },
  { agentId: 'beta', displayName: 'Beta' },
];

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  { timeoutMs = 30000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lan-fault-'));
  // Short heartbeat timeout so a claim whose response is eaten by the proxy
  // flips the orphaned attempt to uncertain quickly, making the dispatch
  // claimable again.
  topology = await LanSimTopology.start({ dataDir, nodes, heartbeatTimeoutMs: 1500 });
  // Stop beta's direct worker; a proxied one takes over its identity.
  await topology.pauseWorker('beta');
  // Half of the proxied requests are reset at random — after some have
  // already reached the center, which is the ambiguous-failure case.
  proxy = await LanFaultProxy.start({ targetUrl: topology.url, rules: { dropRate: 0.5 } });
  proxiedWorker = new LanWorker({
    centerUrl: proxy.url,
    agent: { id: 'beta', displayName: 'Beta' },
    token: topology.center.agentToken('beta'),
    runtime: { kind: 'fake' },
    nodeId: 'node-beta-fault',
    instanceId: `inst-beta-fault-${randomUUID().slice(0, 6)}`,
    pollIntervalMs: 150,
    heartbeatIntervalMs: 500,
  });
  await proxiedWorker.start();
  const created = await topology.api('POST', '/api/conversations', { title: 'Fault room' }) as {
    conversation: { id: string };
  };
  conversationId = created.conversation.id;
});

afterAll(async () => {
  await proxiedWorker?.stop();
  await proxy.stop();
  await topology.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('LAN worker resilience through a fault-injection proxy', () => {
  it('completes a dispatch while every second proxied request is dropped', async () => {
    const sent = await topology.api('POST', `/api/conversations/${conversationId}/messages`, {
      content: 'Survive the dropping proxy.',
      targetAgentIds: ['beta'],
    }) as { dispatches: Dispatch[] };
    const dispatch = sent.dispatches[0]!;

    // The proxy eats responses (after the center processed the request), so
    // the worker may lose its claim response, give up, and only re-claim
    // after the orphaned attempt times out to uncertain. Whatever the drop
    // pattern, the dispatch must end completed exactly once.
    const completed = await waitFor(() => {
      const latest = topology.center.hub.getDispatch(dispatch.id);
      return latest?.status === 'completed' ? latest : undefined;
    });
    expect(completed.status).toBe('completed');

    // Every attempt on this dispatch is terminal; at most one completed.
    const attempts = topology.center.store.attemptsForDispatch(dispatch.id);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.filter((attempt) => attempt.state === 'completed')).toHaveLength(1);
    expect(attempts.every((attempt) => attempt.state !== 'active')).toBe(true);
    expect(proxy.requestCount).toBeGreaterThan(3);
    expect(proxy.droppedCount).toBeGreaterThan(0);
  }, 45000);
});
