import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollaborationHub } from '../../../src/collab/hub';
import { JsonlLedger } from '../../../src/collab/ledger';
import type { MessageInput } from '../../../src/collab/types';

const agents = [
  { id: 'world', displayName: 'World' },
  { id: 'justice', displayName: 'Justice' },
  { id: 'chariot', displayName: 'Chariot' },
  { id: 'fool', displayName: 'Fool' },
];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'collab-hub-'));
  const path = join(dir, 'ledger.jsonl');
  let id = 0;
  const options = {
    agents,
    now: () => new Date('2026-08-22T08:00:00.000Z'),
    idFactory: () => String(++id),
  };
  const hub = new CollaborationHub(new JsonlLedger(path), options);
  await hub.initialize();
  return { hub, path, options };
}

function humanMessage(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    type: 'message',
    idempotencyKey: 'msg-1',
    address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic-1' },
    messageId: 'om_1',
    actor: { type: 'human', id: 'user-1' },
    content: 'Analyze this deeply',
    targetAgentIds: ['world'],
    ...overrides,
  };
}

describe('CollaborationHub', () => {
  it('assigns one mentioned agent and creates a durable dispatch', async () => {
    const { hub, path } = await fixture();
    const result = await hub.submit(humanMessage());

    expect(result.task.ownerAgentId).toBe('world');
    expect(result.task.participants).toEqual(['world']);
    expect(result.dispatches).toMatchObject([
      { targetAgentId: 'world', reason: 'assign', status: 'pending', hop: 1 },
    ]);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('records undirected messages without waking any agent', async () => {
    const { hub } = await fixture();
    const result = await hub.submit(humanMessage({ targetAgentIds: [] }));
    expect(result.dispatches).toEqual([]);
    expect(result.task.ownerAgentId).toBeUndefined();
  });

  it('treats multiple mentions as explicit fanout without inventing an owner', async () => {
    const { hub } = await fixture();
    const result = await hub.submit(humanMessage({ targetAgentIds: ['world', 'chariot'] }));
    expect(result.task.ownerAgentId).toBeUndefined();
    expect(result.dispatches.map((item) => [item.targetAgentId, item.reason])).toEqual([
      ['world', 'fanout'],
      ['chariot', 'fanout'],
    ]);
  });

  it('moves the lease on handoff and keeps ask ownership unchanged', async () => {
    const { hub } = await fixture();
    const assigned = await hub.submit(humanMessage());
    const asked = await hub.submit({
      type: 'ask',
      idempotencyKey: 'ask-1',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      targetAgentId: 'justice',
      content: 'Check this assumption',
    });
    expect(asked.task.ownerAgentId).toBe('world');
    expect(asked.dispatches[0]).toMatchObject({ targetAgentId: 'justice', reason: 'ask' });
    const returned = await hub.submit({
      type: 'return',
      idempotencyKey: 'return-1',
      taskId: assigned.task.id,
      actorAgentId: 'justice',
      content: 'Assumption checked',
    });
    expect(returned.task.ownerAgentId).toBe('world');
    expect(returned.dispatches[0]).toMatchObject({ targetAgentId: 'world', reason: 'return' });

    const handedOff = await hub.submit({
      type: 'handoff',
      idempotencyKey: 'handoff-1',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      targetAgentId: 'chariot',
      content: 'Implement from these conclusions',
    });
    expect(handedOff.task.ownerAgentId).toBe('chariot');
    await expect(hub.submit({
      type: 'handoff',
      idempotencyKey: 'stale-owner',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      targetAgentId: 'fool',
      content: 'This stale owner must not route work',
    })).rejects.toThrow('only the current owner');
  });

  it('enforces context visibility and rejects secrets', async () => {
    const { hub } = await fixture();
    const fanout = await hub.submit(humanMessage({ targetAgentIds: ['world', 'chariot'] }));
    const assigned = await hub.submit(humanMessage({
      idempotencyKey: 'msg-2',
      messageId: 'om_2',
      targetAgentIds: ['world'],
      content: 'World owns the next step',
    }));
    expect(assigned.task.id).toBe(fanout.task.id);
    await hub.submit({
      type: 'ask',
      idempotencyKey: 'ask-private',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      targetAgentId: 'justice',
      content: 'Targeted question',
    });
    const justice = hub.getContext(assigned.task.id, 'justice');
    const chariot = hub.getContext(assigned.task.id, 'chariot');
    expect(JSON.stringify(justice)).toContain('Targeted question');
    expect(JSON.stringify(chariot)).not.toContain('Targeted question');
    expect(JSON.stringify(chariot)).not.toContain('reason":"ask');

    await expect(hub.submit(humanMessage({
      idempotencyKey: 'secret',
      visibility: { kind: 'secret' },
    }))).rejects.toThrow('must not be submitted');
  });

  it('is idempotent and rebuilds projections by replaying the ledger', async () => {
    const { hub, path, options } = await fixture();
    const first = await hub.submit(humanMessage());
    const duplicate = await hub.submit(humanMessage());
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.task).toEqual(first.task);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);

    const replayed = new CollaborationHub(new JsonlLedger(path), options);
    await replayed.initialize();
    expect(replayed.getTask(first.task.id)).toEqual(first.task);
    expect(replayed.listDispatches('world')).toHaveLength(1);
  });

  it('rejects actions after the owner lease expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-hub-expiry-'));
    let now = new Date('2026-08-22T08:00:00.000Z');
    const hub = new CollaborationHub(new JsonlLedger(join(dir, 'ledger.jsonl')), {
      agents,
      leaseMs: 1_000,
      now: () => now,
    });
    await hub.initialize();
    const assigned = await hub.submit(humanMessage());
    now = new Date('2026-08-22T08:00:02.000Z');
    await expect(hub.submit({
      type: 'handoff',
      idempotencyKey: 'expired-handoff',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      targetAgentId: 'justice',
      content: 'Too late',
    })).rejects.toThrow('current owner (none)');
  });
});
