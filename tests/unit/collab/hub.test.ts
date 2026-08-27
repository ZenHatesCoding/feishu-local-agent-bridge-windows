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
  it('keeps connected bot identities available for deterministic delegation', async () => {
    const { hub } = await fixture();
    expect(hub.registerAgentIdentity('chariot', 'ou_chariot')).toEqual({
      id: 'chariot', displayName: 'Chariot', openId: 'ou_chariot',
      lastSeenAt: '2026-08-22T08:00:00.000Z',
    });
    hub.registerAgentIdentity('world', 'ou_world');
    expect(hub.listAgentIdentities()).toEqual([
      { id: 'chariot', displayName: 'Chariot', openId: 'ou_chariot', lastSeenAt: '2026-08-22T08:00:00.000Z' },
      { id: 'world', displayName: 'World', openId: 'ou_world', lastSeenAt: '2026-08-22T08:00:00.000Z' },
    ]);
  });

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
    await hub.acknowledge(assigned.dispatches[0]!.id, 'world', 'accepted', 'accept-assigned');
    const asked = await hub.submit({
      type: 'ask',
      idempotencyKey: 'ask-1',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      causedByDispatchId: assigned.dispatches[0]!.id,
      targetAgentId: 'justice',
      content: 'Check this assumption',
    });
    expect(asked.task.ownerAgentId).toBe('world');
    expect(asked.dispatches[0]).toMatchObject({ targetAgentId: 'justice', reason: 'ask' });
    await hub.acknowledge(asked.dispatches[0]!.id, 'justice', 'accepted', 'accept-asked');
    const returned = await hub.submit({
      type: 'return',
      idempotencyKey: 'return-1',
      taskId: assigned.task.id,
      actorAgentId: 'justice',
      causedByDispatchId: asked.dispatches[0]!.id,
      content: 'Assumption checked',
    });
    expect(returned.task.ownerAgentId).toBe('world');
    expect(returned.dispatches[0]).toMatchObject({ targetAgentId: 'world', reason: 'return' });
    await hub.acknowledge(returned.dispatches[0]!.id, 'world', 'accepted', 'accept-returned');

    const handedOff = await hub.submit({
      type: 'handoff',
      idempotencyKey: 'handoff-1',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      causedByDispatchId: returned.dispatches[0]!.id,
      targetAgentId: 'chariot',
      content: 'Implement from these conclusions',
    });
    expect(handedOff.task.ownerAgentId).toBe('chariot');
    await expect(hub.submit({
      type: 'handoff',
      idempotencyKey: 'stale-owner',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      causedByDispatchId: returned.dispatches[0]!.id,
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
    await hub.acknowledge(assigned.dispatches[0]!.id, 'world', 'accepted', 'accept-visible');
    await hub.submit({
      type: 'ask',
      idempotencyKey: 'ask-private',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      causedByDispatchId: assigned.dispatches[0]!.id,
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

  it('shares durable artifacts with later participants and replays them', async () => {
    const { hub, path, options } = await fixture();
    const assigned = await hub.submit(humanMessage());
    await hub.submit({
      type: 'artifact',
      idempotencyKey: 'artifact-1',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      artifact: {
        id: 'artifact_abc',
        name: 'architecture.pptx',
        kind: 'presentation',
        localPath: 'C:\\shared\\architecture.pptx',
        sha256: 'a'.repeat(64),
        size: 4096,
      },
    });
    await hub.submit(humanMessage({
      idempotencyKey: 'msg-chariot',
      messageId: 'om_chariot',
      content: 'Continue from the presentation',
      targetAgentIds: ['chariot'],
    }));

    expect(hub.getArtifacts(assigned.task.id, 'chariot')).toMatchObject([{
      name: 'architecture.pptx',
      localPath: 'C:\\shared\\architecture.pptx',
    }]);
    const replayed = new CollaborationHub(new JsonlLedger(path), options);
    await replayed.initialize();
    expect(replayed.getArtifacts(assigned.task.id, 'chariot')).toHaveLength(1);
  });

  it('filters targeted artifacts from unrelated participants', async () => {
    const { hub } = await fixture();
    const assigned = await hub.submit(humanMessage({ targetAgentIds: ['world', 'chariot'] }));
    await hub.submit({
      type: 'artifact',
      idempotencyKey: 'artifact-targeted',
      taskId: assigned.task.id,
      actorAgentId: 'world',
      visibility: { kind: 'targeted', agents: ['world'] },
      artifact: {
        id: 'artifact_private',
        name: 'world-only.txt',
        kind: 'document',
        localPath: 'C:\\shared\\world-only.txt',
        sha256: 'b'.repeat(64),
        size: 10,
      },
    });
    expect(hub.getArtifacts(assigned.task.id, 'world')).toHaveLength(1);
    expect(hub.getArtifacts(assigned.task.id, 'chariot')).toEqual([]);
  });

  it('accepts a portable Git artifact without treating a local path as shared truth', async () => {
    const { hub } = await fixture();
    const assigned = await hub.submit(humanMessage());
    await hub.submit({
      type: 'artifact', idempotencyKey: 'artifact-git', taskId: assigned.task.id,
      actorAgentId: 'world',
      artifact: {
        id: 'artifact_git', name: 'README.md', kind: 'document', sha256: 'c'.repeat(64), size: 42,
        locator: {
          provider: 'git', repository: 'https://github.com/example/project.git',
          commit: '0123456789abcdef', path: 'README.md',
        },
      },
    });
    const [artifact] = hub.getArtifacts(assigned.task.id, 'world');
    expect(artifact?.localPath).toBeUndefined();
    expect(artifact?.locator).toMatchObject({ provider: 'git', commit: '0123456789abcdef' });
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
      causedByDispatchId: assigned.dispatches[0]!.id,
      targetAgentId: 'justice',
      content: 'Too late',
    })).rejects.toThrow('current owner (none)');
  });

  it('resets causal depth for each human instruction in a long-lived topic', async () => {
    const { hub } = await fixture();
    for (let turn = 1; turn <= 12; turn++) {
      const assigned = await hub.submit(humanMessage({
        idempotencyKey: `human-${turn}`,
        messageId: `om_${turn}`,
        content: `Human instruction ${turn}`,
      }));
      await hub.acknowledge(assigned.dispatches[0]!.id, 'world', 'accepted', `accept-human-${turn}`);
      const asked = await hub.submit({
        type: 'ask',
        idempotencyKey: `ask-${turn}`,
        taskId: assigned.task.id,
        actorAgentId: 'world',
        causedByDispatchId: assigned.dispatches[0]!.id,
        targetAgentId: 'justice',
        content: `Review turn ${turn}`,
      });
      expect(asked.dispatches[0]!.hop).toBe(2);
      await hub.acknowledge(assigned.dispatches[0]!.id, 'world', 'completed', `complete-human-${turn}`);
    }
  });

  it('limits only a true causal delegation chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-causal-depth-'));
    const hub = new CollaborationHub(new JsonlLedger(join(dir, 'ledger.jsonl')), {
      agents,
      maxCausalDepth: 3,
    });
    await hub.initialize();
    const assigned = await hub.submit(humanMessage());
    const root = assigned.dispatches[0]!;
    await hub.acknowledge(root.id, 'world', 'accepted', 'accept-root');
    const ask = await hub.submit({
      type: 'ask', idempotencyKey: 'causal-ask', taskId: assigned.task.id,
      actorAgentId: 'world', causedByDispatchId: root.id, targetAgentId: 'justice', content: 'Review',
    });
    const review = ask.dispatches[0]!;
    await hub.acknowledge(review.id, 'justice', 'accepted', 'accept-review');
    const returned = await hub.submit({
      type: 'return', idempotencyKey: 'causal-return', taskId: assigned.task.id,
      actorAgentId: 'justice', causedByDispatchId: review.id, content: 'Reviewed',
    });
    const ownerReturn = returned.dispatches[0]!;
    expect(ownerReturn.hop).toBe(3);
    await hub.acknowledge(ownerReturn.id, 'world', 'accepted', 'accept-owner-return');
    await expect(hub.submit({
      type: 'ask', idempotencyKey: 'too-deep', taskId: assigned.task.id,
      actorAgentId: 'world', causedByDispatchId: ownerReturn.id, targetAgentId: 'chariot', content: 'Continue recursively',
    })).rejects.toThrow('maximum causal delegation depth exceeded (3)');
  });
});
