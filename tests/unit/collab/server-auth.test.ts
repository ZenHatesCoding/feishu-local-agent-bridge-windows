import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationClient } from '../../../src/collab/client';
import { CollaborationHub } from '../../../src/collab/hub';
import { JsonlLedger } from '../../../src/collab/ledger';
import { CollaborationHubServer } from '../../../src/collab/server';

const servers: CollaborationHubServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'collab-auth-'));
  const hub = new CollaborationHub(new JsonlLedger(join(dir, 'ledger.jsonl')), {
    agents: [
      { id: 'world', displayName: 'World' },
      { id: 'chariot', displayName: 'Chariot' },
    ],
  });
  await hub.initialize();
  const server = new CollaborationHubServer(hub, {
    host: '127.0.0.1', port: 0, token: 'admin-secret',
    agentTokens: { world: 'world-secret', chariot: 'chariot-secret' },
  });
  servers.push(server);
  const { port } = await server.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    world: new CollaborationClient({ baseUrl, token: 'world-secret' }),
    chariot: new CollaborationClient({ baseUrl, token: 'chariot-secret' }),
    admin: new CollaborationClient({ baseUrl, token: 'admin-secret' }),
  };
}

describe('Collaboration Hub per-agent authentication', () => {
  it('lets two independently authenticated nodes collaborate through one Hub', async () => {
    const { world, chariot } = await fixture();
    const assigned = await world.submit({
      type: 'message', idempotencyKey: 'remote-human',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      messageId: 'om_remote', actor: { type: 'human', id: 'user' },
      content: 'Design and hand off', targetAgentIds: ['world'],
    });
    const root = assigned.dispatches[0]!;
    await world.acknowledge(root.id, { agentId: 'world', status: 'accepted', idempotencyKey: 'accept-world' });
    const handedOff = await world.submit({
      type: 'handoff', idempotencyKey: 'remote-handoff', taskId: assigned.task.id,
      actorAgentId: 'world', causedByDispatchId: root.id, targetAgentId: 'chariot', content: 'Implement it',
    });
    const pending = await chariot.dispatches('chariot');
    expect(pending.dispatches).toMatchObject([{ id: handedOff.dispatches[0]!.id, objective: 'Implement it' }]);
    expect((await chariot.context(assigned.task.id, 'chariot')).entries.length).toBeGreaterThan(0);
  });

  it('prevents one agent credential from impersonating another', async () => {
    const { world, admin } = await fixture();
    await expect(world.registerIdentity('chariot', 'ou_fake')).rejects.toThrow('cannot act as another agent');
    await expect(world.dispatches('chariot')).rejects.toThrow('cannot act as another agent');
    await expect(world.submit({
      type: 'message', idempotencyKey: 'bad-route',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      messageId: 'om_bad', actor: { type: 'human', id: 'user' }, content: 'Wake other bot',
      targetAgentIds: ['chariot'],
    })).rejects.toThrow('only route an observed message to itself');
    await expect(admin.registerIdentity('chariot', 'ou_real')).resolves.toMatchObject({ agent: { id: 'chariot' } });
  });

  it('fans out one message when each authenticated bot reports its own real mention', async () => {
    const { world, chariot } = await fixture();
    const input = {
      type: 'message' as const,
      idempotencyKey: 'multi-mention',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      messageId: 'om_multi',
      actor: { type: 'human' as const, id: 'user' },
      content: 'Answer independently',
    };

    await world.submit({ ...input, targetAgentIds: ['world'] });
    const merged = await chariot.submit({ ...input, targetAgentIds: ['chariot'] });

    expect(merged.dispatches.map((item) => item.targetAgentId).sort()).toEqual(['chariot', 'world']);
    expect((await world.dispatches('world')).dispatches).toHaveLength(1);
    expect((await chariot.dispatches('chariot')).dispatches).toHaveLength(1);
  });
});
