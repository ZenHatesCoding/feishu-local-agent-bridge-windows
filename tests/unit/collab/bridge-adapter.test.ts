import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeCollaborationAdapter, extractCollaborationHandoff } from '../../../src/collab/bridge-adapter';
import { stripRawFeishuMentionTokens } from '../../../src/collab/mentions';
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
  mentions?: Array<{ openId?: string; name?: string }>;
}): NormalizedMessage {
  return {
    chatId: 'chat',
    chatType: 'group',
    threadId: input.threadId ?? 'topic',
    messageId: input.id,
    senderId: input.senderId,
    content: input.content,
    mentionedBot: true,
    mentions: input.mentions ?? [],
    resources: [],
    raw: { sender: { sender_type: input.senderType } },
  } as unknown as NormalizedMessage;
}

describe('BridgeCollaborationAdapter', () => {
  it('extracts a bridge-owned handoff without exposing its control marker', () => {
    expect(extractCollaborationHandoff('Finding\n<collaboration_handoff target="chariot">Please rebut point 2</collaboration_handoff>'))
      .toEqual({ visibleContent: 'Finding', handoff: { targetAgentId: 'chariot', content: 'Please rebut point 2' } });
  });
  it('extracts a normal reply invitation without turning it into a handoff', () => {
    expect(extractCollaborationHandoff('Argument\n<collaboration_reply target="chariot">Please rebut point 2</collaboration_reply>'))
      .toEqual({ visibleContent: 'Argument', reply: { targetAgentId: 'chariot', content: 'Please rebut point 2' } });
  });

  it('extracts a consultation without transferring ownership', () => {
    expect(extractCollaborationHandoff('Finding\n<collaboration_ask target="chariot">Review the risk</collaboration_ask>'))
      .toEqual({ visibleContent: 'Finding', ask: { targetAgentId: 'chariot', content: 'Review the risk' } });
  });

  it('flags an unclosed terminal marker for correction instead of delegating it', () => {
    expect(extractCollaborationHandoff('Finding\n<collaboration_handoff target="chariot">Please rebut point 2'))
      .toEqual({
        visibleContent: 'Finding',
        malformed: { kind: 'handoff', targetAgentId: 'chariot', content: 'Please rebut point 2' },
      });
  });

  it('does not treat an unclosed marker embedded in ordinary text as a correction request', () => {
    expect(extractCollaborationHandoff('Explain <collaboration_handoff target="chariot"> as a literal example.'))
      .toEqual({ visibleContent: 'Explain <collaboration_handoff target="chariot"> as a literal example.' });
  });

  it('never lets raw Feishu IDs leak into visible collaboration text', () => {
    expect(stripRawFeishuMentionTokens('请 @ou_abc123 Star 接手')).toBe('请 Star 接手');
  });

  it('drops a hand-written @open_id address before the bridge emits its real mention', async () => {
    const { hub, client } = await fixture();
    const chariotOpenId = 'ou_ae9b3ab812ab5380a4a58b888b2e9985';
    hub.registerAgentIdentity('chariot', chariotOpenId, {});
    const world = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const assigned = await world.intake(message({
      id: 'human-address', senderType: 'user', senderId: 'user', content: 'Keep going',
    }));

    const target = await world.createHandoff({
      taskId: assigned.taskId!,
      dispatchId: assigned.dispatchId!,
      targetAgentId: 'chariot',
      content: `@${chariotOpenId} Chariot，第 2 页交付完成，请继续第 3 页。`,
      runId: 'run-address',
    });

    expect(target.content).toBe('第 2 页交付完成，请继续第 3 页。');
    const context = JSON.stringify(hub.getContext(assigned.taskId!, 'world'));
    expect(context).toContain('第 2 页交付完成，请继续第 3 页。');
    expect(context).not.toContain(chariotOpenId);
  });
  it('injects shared context for a human assignment', async () => {
    const { hub, client } = await fixture();
    const adapter = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const decision = await adapter.intake(message({
      id: 'human-1', senderType: 'user', senderId: 'user', content: 'Analyze deeply',
    }));
    expect(decision).toMatchObject({ managed: true, respond: true });
    expect(decision.promptContext).toContain('collaboration_context');
    expect(decision.promptContext).toContain('Analyze deeply');
    await adapter.finishRun(decision.taskId!, 'World accepted architecture A', 'run-1', decision.dispatchId!, true);
    expect(JSON.stringify(hub.getContext(decision.taskId!, 'world')))
      .toContain('World accepted architecture A');
  });

  it('asks the Hub for one generic marker-repair prompt, without creating a delegation', async () => {
    const { hub, client } = await fixture();
    const adapter = new BridgeCollaborationAdapter(client, 'world', 'tenant');
    const decision = await adapter.intake(message({
      id: 'repair-1', senderType: 'user', senderId: 'user', content: 'Get Justice to review this',
    }));

    const prompt = await adapter.requestMarkerRepair({
      taskId: decision.taskId!,
      dispatchId: decision.dispatchId!,
      runId: 'run-repair-1',
      kind: 'ask',
      targetAgentId: 'chariot',
      content: 'Review the risks.',
    });

    expect(prompt).toContain('SYSTEM VALIDATION ERROR');
    expect(prompt).toContain('<collaboration_ask target="chariot">');
    expect(hub.listDispatches('chariot')).toHaveLength(0);
    await expect(adapter.requestMarkerRepair({
      taskId: decision.taskId!,
      dispatchId: decision.dispatchId!,
      runId: 'run-repair-2',
      kind: 'ask',
      targetAgentId: 'chariot',
      content: 'Review the risks.',
    })).rejects.toThrow('only once per run');
  });

  it('preserves all structured human mentions when one bridge reports the event', async () => {
    const { hub, client } = await fixture();
    const roster = [
      { id: 'world', displayName: 'World' },
      { id: 'chariot', displayName: 'Chariot' },
    ];
    const world = new BridgeCollaborationAdapter(client, 'world', 'tenant', 'distributed', undefined, roster);
    const decision = await world.intake(message({
      id: 'human-fanout', senderType: 'user', senderId: 'user', content: 'Review independently',
      mentions: [{ name: 'World' }, { name: 'Chariot' }],
    }));

    expect(decision.respond).toBe(true);
    expect(hub.listDispatches('world')).toHaveLength(1);
    expect(hub.listDispatches('chariot')).toHaveLength(1);
  });

  it('snapshots accepted inbound attachments into shared task context', async () => {
    const { hub, client } = await fixture();
    const root = await mkdtemp(join(tmpdir(), 'collab-inbound-artifact-'));
    const source = join(root, 'input.pdf');
    await writeFile(source, 'pdf bytes');
    const adapter = new BridgeCollaborationAdapter(client, 'world', 'tenant', 'distributed', join(root, 'shared'));
    const decision = await adapter.intake(message({
      id: 'human-file', senderType: 'user', senderId: 'user', content: 'Review this file',
    }));
    await adapter.recordAttachments(decision.taskId!, [{
      absPath: source,
      path: source,
      kind: 'file',
      size: 9,
      mime: 'application/pdf',
      hash: 'input-hash',
      source: 'lark',
      sourceMessageId: 'human-file',
      sourceFileKey: 'file_key',
      originalName: 'input.pdf',
      requiredness: 'optional',
      decision: 'accepted',
    }]);
    expect(hub.getArtifacts(decision.taskId!, 'world')).toMatchObject([{
      name: 'input.pdf',
      sourceMessageId: 'human-file',
      sourceFileKey: 'file_key',
    }]);
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
      causedByDispatchId: assigned.dispatchId!,
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
