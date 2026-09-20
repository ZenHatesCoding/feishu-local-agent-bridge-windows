import { describe, expect, it } from 'vitest';
import { buildCollaborationContext } from '../../../src/collab/context';
import type { ContextEntry, Dispatch, SharedArtifact, TaskProjection } from '../../../src/collab/types';

const task: TaskProjection = {
  id: 'task-1', address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
  status: 'open', ownerAgentId: 'world', participants: ['world', 'justice'], lastSequence: 30,
};
const dispatch: Dispatch = {
  id: 'dispatch-1', taskId: 'task-1', targetAgentId: 'world', reason: 'mention',
  objective: 'Coordinate the work', sourceSequence: 30, sequence: 31, hop: 1, status: 'accepted',
};

describe('collaboration context', () => {
  it('supplies the current dispatch and local query entry point without historical content', () => {
    const entries: ContextEntry[] = [{
      sequence: 1, recordedAt: '2026-09-01T00:00:00.000Z',
      event: {
        kind: 'message', messageId: 'old', actor: { type: 'human', id: 'user' }, content: 'old private history',
        targetAgentIds: ['world'], visibility: { kind: 'task-public' }, references: [], occurredAt: '2026-09-01T00:00:00.000Z',
      },
    }];
    const context = buildCollaborationContext({
      task, dispatch, entries,
      agents: [{ id: 'justice', displayName: 'Justice', openId: 'ou_private' }],
    });

    expect(context).toContain('"objective":"Coordinate the work"');
    expect(context).toContain('local-context search');
    expect(context).toContain('"scope":"chat:topic"');
    expect(context).toContain('collaboration_reply target=\\"TARGET_ID\\"');
    expect(context).not.toContain('old private history');
    expect(context).not.toContain('ou_private');
  });

  it('does not expose Hub artifact paths from another computer', () => {
    const artifact: SharedArtifact = {
      id: 'ppt', name: 'deck.pptx', kind: 'file', localPath: 'C:\\other-node\\deck.pptx', sha256: 'abc', size: 1,
    };
    const context = buildCollaborationContext({ task, dispatch, entries: [], artifacts: [artifact] });
    expect(context).not.toContain('other-node');
    expect(context).toContain('never invent a remote local path');
  });
});
