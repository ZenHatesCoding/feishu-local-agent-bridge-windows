import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  coordinatorInputForMessage,
  resolveMentionedAgents,
} from '../../../src/collab/coordinator';

const agents = [
  { id: 'world', displayName: 'World', aliases: ['codex', 'ou_world'] },
  { id: 'chariot', displayName: 'Chariot', aliases: ['deepseek', 'ou_chariot'] },
];

function fakeMessage(overrides: Record<string, unknown> = {}): NormalizedMessage {
  return {
    chatId: 'chat',
    chatType: 'group',
    threadId: 'topic',
    messageId: 'message',
    senderId: 'user',
    content: 'do the task',
    resources: [],
    mentions: [],
    raw: { sender: { sender_type: 'user' } },
    ...overrides,
  } as unknown as NormalizedMessage;
}

describe('Feishu coordinator normalization', () => {
  it('maps structured mentions by display name, alias, or configured open id', () => {
    const msg = fakeMessage({
      mentions: [
        { key: '@_user_1', name: 'World', openId: 'unknown' },
        { key: '@_user_2', name: 'different', openId: 'ou_chariot' },
        { key: '@_user_3', name: 'World', openId: 'unknown-duplicate' },
      ],
    });
    expect(resolveMentionedAgents(msg, agents)).toEqual(['world', 'chariot']);
  });

  it('builds one canonical topic event and recognizes known bot senders', () => {
    const input = coordinatorInputForMessage(fakeMessage({
      senderId: 'ou_world',
      senderName: 'World',
      mentions: [{ key: '@_user_1', name: 'Chariot' }],
      raw: { sender: { sender_type: 'app' } },
    }), { tenantKey: 'tenant', agents });
    expect(input).toMatchObject({
      idempotencyKey: 'feishu-message:message',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      actor: { type: 'agent', id: 'world' },
      targetAgentIds: ['chariot'],
    });
  });

  it('ignores direct messages and non-topic groups', () => {
    expect(coordinatorInputForMessage(fakeMessage({ chatType: 'p2p' }), {
      tenantKey: 'tenant', agents,
    })).toBeUndefined();
    expect(coordinatorInputForMessage(fakeMessage({ threadId: undefined }), {
      tenantKey: 'tenant', agents,
    })).toBeUndefined();
  });
});
