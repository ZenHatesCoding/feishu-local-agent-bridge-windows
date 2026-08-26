import { describe, expect, it } from 'vitest';
import { buildCollaborationContext } from '../../../src/collab/context';

describe('collaboration context projection', () => {
  it('advertises stable agent ids and the atomic delegation command', () => {
    const context = buildCollaborationContext({
      task: {
        id: 'task-1', address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
        status: 'open', ownerAgentId: 'world', participants: ['world'], lastSequence: 2,
      },
      dispatch: {
        id: 'dispatch-1', taskId: 'task-1', targetAgentId: 'world', reason: 'assign',
        objective: 'Coordinate the work', sourceSequence: 1, sequence: 2, hop: 1, status: 'accepted',
      },
      entries: [],
      agents: [
        { id: 'justice', displayName: 'Justice', openId: 'ou_private' },
        { id: 'chariot', displayName: 'Chariot', openId: 'ou_private_2' },
      ],
    });

    expect(context).toContain('collab-delegate.cmd handoff|ask');
    expect(context).toContain('"id":"justice"');
    expect(context).toContain('"displayName":"Chariot"');
    expect(context).not.toContain('ou_private');
  });
});
