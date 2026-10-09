import { describe, expect, it } from 'vitest';
import { taskIdFor, validateTaskAddress } from '../../../src/collab/task-id';
import { CollaborationHub } from '../../../src/collab/hub';
import type { CollaborationLedger, LedgerRecord } from '../../../src/collab/types';
import { buildCollaborationContext } from '../../../src/collab/context';

class MemoryLedger implements CollaborationLedger {
  readonly records: LedgerRecord[] = [];
  readAll(): Promise<LedgerRecord[]> {
    return Promise.resolve(this.records.map((record) => ({ ...record })));
  }
  append(records: LedgerRecord[]): Promise<void> {
    this.records.push(...records.map((record) => ({ ...record })));
    return Promise.resolve();
  }
}

const lanAddress = { deploymentId: 'lan-main', conversationId: 'conv-001' } as const;
const feishuAddress = { tenantKey: 't', chatId: 'oc_1', threadId: 'om_1' } as const;

describe('channel-neutral task addresses', () => {
  it('derives stable and distinct task ids for LAN addresses', () => {
    const first = taskIdFor(lanAddress);
    expect(first).toBe(taskIdFor({ ...lanAddress }));
    expect(first).not.toBe(taskIdFor({ deploymentId: 'lan-main', conversationId: 'conv-002' }));
    expect(first).not.toBe(taskIdFor(feishuAddress));
    expect(first).toMatch(/^task_[0-9a-f]{24}$/);
  });

  it('keeps the Feishu id derivation byte-compatible with the historical scheme', () => {
    expect(taskIdFor(feishuAddress)).toMatch(/^task_[0-9a-f]{24}$/);
  });

  it('rejects blank LAN address fields', () => {
    expect(() => validateTaskAddress({ deploymentId: ' ', conversationId: 'c' }))
      .toThrow('deploymentId is required');
    expect(() => validateTaskAddress({ deploymentId: 'd', conversationId: '' }))
      .toThrow('conversationId is required');
  });
});

describe('CollaborationHub over a LAN address', () => {
  function newHub(): CollaborationHub {
    return new CollaborationHub(new MemoryLedger(), {
      agents: [
        { id: 'alpha', displayName: 'Alpha' },
        { id: 'beta', displayName: 'Beta' },
      ],
    });
  }

  it('registers worker identities without an openId', () => {
    const hub = newHub();
    const identity = hub.registerAgentIdentity('alpha', undefined, { nodeId: 'node-a' });
    expect(identity.openId).toBeUndefined();
    expect(identity.nodeId).toBe('node-a');
  });

  it('routes a LAN conversation message to mentioned agents and exposes the task roster', async () => {
    const hub = newHub();
    hub.registerAgentIdentity('alpha', undefined, { nodeId: 'node-a' });
    hub.registerAgentIdentity('beta', undefined, { nodeId: 'node-b' });
    const result = await hub.submit({
      type: 'message',
      idempotencyKey: 'lan-msg-1',
      address: lanAddress,
      messageId: 'lan-msg-1',
      actor: { type: 'human', id: 'user-1', name: 'Owner' },
      content: 'Please analyze the report.',
      targetAgentIds: ['alpha'],
    });
    expect(result.task.address).toEqual(lanAddress);
    expect(result.dispatches.map((dispatch) => dispatch.targetAgentId)).toEqual(['alpha']);
    expect(result.task.participants).toContain('alpha');

    const roster = hub.listTaskAgentIdentities(result.task.id);
    expect(roster.map((identity) => identity.id)).toEqual(['alpha']);
    expect(hub.listChatAgentIdentities('oc_1')).toEqual([]);
  });

  it('builds the collaboration context envelope with the conversation scope', async () => {
    const hub = newHub();
    const result = await hub.submit({
      type: 'message',
      idempotencyKey: 'lan-msg-2',
      address: lanAddress,
      messageId: 'lan-msg-2',
      actor: { type: 'human', id: 'user-1', name: 'Owner' },
      content: 'Draft the summary.',
      targetAgentIds: ['alpha'],
    });
    const dispatch = result.dispatches.find((item) => item.targetAgentId === 'alpha')!;
    const envelope = buildCollaborationContext({
      task: result.task,
      dispatch,
      entries: hub.getContext(result.task.id, 'alpha'),
      agents: hub.listTaskAgentIdentities(result.task.id),
    });
    expect(envelope).toContain('collaboration_context');
    expect(envelope).toContain('conv-001');
  });
});
