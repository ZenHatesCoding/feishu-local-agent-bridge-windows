import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeCollaborationAdapter } from '../../../src/collab/bridge-adapter';
import { CollaborationClient } from '../../../src/collab/client';
import { CollaborationHub } from '../../../src/collab/hub';
import { JsonlLedger } from '../../../src/collab/ledger';
import { CollaborationHubServer } from '../../../src/collab/server';

const openServers: CollaborationHubServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'collab-adapter-'));
  const hub = new CollaborationHub(new JsonlLedger(join(dir, 'ledger.jsonl')), {
    agents: [
      { id: 'world', displayName: 'World' },
      { id: 'chariot', displayName: 'Chariot' },
    ],
  });
  await hub.initialize();
  const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
  openServers.push(server);
  const address = await server.listen();
  const client = new CollaborationClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
  return { hub, client };
}

function message(input: {
  id: string;
  senderType: 'user' | 'app';
  senderId: string;
  content: string;
  threadId?: string;
}): NormalizedMessage {
  return {
    chatId: 'chat',
    chatType: 'group',
    threadId: input.threadId ?? 'topic',
    messageId: input.id,
    senderId: input.senderId,
    content: input.content,
    mentionedBot: true,
    resources: [],
    raw: { sender: { sender_type: input.senderType } },
  } as unknown as NormalizedMessage;
}

describe('BridgeCollaborationAdapter', () => {
  it('injects shared context for a human assignment', async () => {
    const { hub, client } = await fixture();
    const adapter = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const decision = await adapter.intake(message({
      id: 'human-1', senderType: 'user', senderId: 'user', content: 'Analyze deeply',
    }));
    expect(decision).toMatchObject({ managed: true, respond: true });
    expect(decision.promptContext).toContain('collaboration_context');
    expect(decision.promptContext).toContain('Analyze deeply');
    await adapter.recordResult(decision.taskId!, 'World accepted architecture A', 'run-1');
    expect(JSON.stringify(hub.getContext(decision.taskId!, 'world')))
      .toContain('World accepted architecture A');
  });

  it('requires a structured dispatch before accepting an agent mention', async () => {
    const { hub, client } = await fixture();
    const world = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const chariot = new BridgeCollaborationAdapter(client, 'chariot', 'tenant');
    const assigned = await world.intake(message({
      id: 'human-1', senderType: 'user', senderId: 'user', content: 'Design it',
    }));

    const unauthorized = await chariot.intake(message({
      id: 'bot-early', senderType: 'app', senderId: 'world-bot', content: 'Please continue',
      threadId: 'another-topic',
    }));
    expect(unauthorized).toMatchObject({ managed: true, respond: false });

    await hub.submit({
      type: 'handoff',
      idempotencyKey: 'handoff-1',
      taskId: assigned.taskId!,
      actorAgentId: 'world',
      targetAgentId: 'chariot',
      content: 'Implement the accepted design',
    });
    const authorized = await chariot.intake(message({
      id: 'bot-after-handoff', senderType: 'app', senderId: 'world-bot', content: '@Chariot continue',
    }));
    expect(authorized).toMatchObject({ managed: true, respond: true });
    expect(authorized.promptContext).toContain('Implement the accepted design');
  });

  it('leaves direct messages and non-topic groups on the original bridge path', async () => {
    const { client } = await fixture();
    const adapter = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const msg = message({ id: 'regular', senderType: 'user', senderId: 'u', content: 'hello' });
    delete (msg as { threadId?: string }).threadId;
    expect(await adapter.intake(msg)).toEqual({ managed: false, respond: true });
  });

  it('lets the silent coordinator be the only event writer', async () => {
    const { hub, client } = await fixture();
    const address = { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' };
    const routed = await hub.submit({
      type: 'message',
      idempotencyKey: 'feishu-message:coordinated',
      address,
      messageId: 'coordinated',
      actor: { type: 'human', id: 'user' },
      content: 'Coordinator saw this first',
      targetAgentIds: ['chariot'],
    });
    const adapter = new BridgeCollaborationAdapter(client, 'chariot', 'tenant', 'coordinator');
    const decision = await adapter.intake(message({
      id: 'coordinated', senderType: 'user', senderId: 'user', content: 'Coordinator saw this first',
    }));
    expect(decision).toMatchObject({
      managed: true,
      respond: true,
      taskId: routed.task.id,
    });
  });
});
