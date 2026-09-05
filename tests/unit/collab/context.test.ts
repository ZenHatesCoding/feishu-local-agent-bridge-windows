import { describe, expect, it } from 'vitest';
import { buildCollaborationContext } from '../../../src/collab/context';
import type { ContextEntry, Dispatch, SharedArtifact, TaskProjection } from '../../../src/collab/types';

const task: TaskProjection = {
  id: 'task-1', address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
  status: 'open', ownerAgentId: 'world', participants: ['world', 'justice'], lastSequence: 30,
};

const dispatch: Dispatch = {
  id: 'dispatch-1', taskId: 'task-1', targetAgentId: 'world', reason: 'assign',
  objective: 'Coordinate the work', sourceSequence: 30, sequence: 31, hop: 1, status: 'accepted',
};

describe('collaboration context projection', () => {
  it('advertises stable agent ids and the atomic delegation command', () => {
    const context = buildCollaborationContext({
      task,
      dispatch,
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
    expect(context).toContain('Do not claim the delivery channel is unbound');
  });

  it('keeps only the original and recent semantic history and drops mechanical events', () => {
    const entries: ContextEntry[] = [message(1, 'original requirement')];
    for (let sequence = 2; sequence <= 12; sequence += 1) {
      entries.push(action(sequence, `semantic-${sequence}`));
      entries.push({
        sequence: sequence + 100,
        recordedAt: '2026-09-01T00:00:00.000Z',
        event: { kind: 'ack', dispatchId: `d-${sequence}`, agentId: 'world', status: 'completed' },
      });
    }
    entries.push(message(30, 'current prompt is already carried by the dispatch'));

    const projected = readContext(buildCollaborationContext({ task, dispatch, entries }));
    expect(projected.entries.map((entry) => entry.sequence)).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(JSON.stringify(projected)).not.toContain('current prompt is already carried');
    expect(JSON.stringify(projected)).not.toContain('"kind":"ack"');
  });

  it('publishes only compact artifact metadata until the objective mentions a file', () => {
    const ppt = artifact('ppt-old', 'World-v1.pptx', 'C:\\private\\World-v1.pptx');
    const entries = [message(1, 'build a deck'), artifactEntry(10, 'world', ppt), message(30, 'change the title')];

    const projected = readContext(buildCollaborationContext({ task, dispatch, entries, artifacts: [ppt] }));
    expect(projected.artifactCatalog).toMatchObject([{ id: 'ppt-old', name: 'World-v1.pptx' }]);
    expect(projected.selectedArtifacts).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain('C:\\\\private');
    expect(JSON.stringify(projected)).not.toContain('sha-ppt-old');
  });

  it('resolves only the latest matching producer and file type when referenced', () => {
    const worldV1 = artifact('world-v1', 'World-v1.pptx', 'C:\\shared\\World-v1.pptx');
    const worldV2 = artifact('world-v2', 'World-v2.pptx', 'C:\\shared\\World-v2.pptx');
    const justice = artifact('justice-v3', 'Justice-v3.pptx', 'C:\\shared\\Justice-v3.pptx');
    const entries = [
      message(1, 'build a deck'), artifactEntry(10, 'world', worldV1),
      artifactEntry(20, 'world', worldV2), artifactEntry(25, 'justice', justice),
      message(30, '基于 World 那版 PPT 调整'),
    ];
    const objective = { ...dispatch, objective: '基于 World 那版 PPT 调整' };

    const projected = readContext(buildCollaborationContext({
      task, dispatch: objective, entries,
      agents: [
        { id: 'world', displayName: 'World', openId: 'ou_world' },
        { id: 'justice', displayName: 'Justice', openId: 'ou_justice' },
      ],
    }));
    expect(projected.selectedArtifacts).toMatchObject([{ id: 'world-v2', producerAgentId: 'world' }]);
    expect(JSON.stringify(projected.selectedArtifacts)).toContain('World-v2.pptx');
    expect(JSON.stringify(projected.selectedArtifacts)).not.toContain('Justice-v3.pptx');
    expect(JSON.stringify(projected.selectedArtifacts)).not.toContain('World-v1.pptx');
  });

  it('resolves an explicitly named older artifact and marks long excerpts', () => {
    const old = artifact('old-ppt', 'old-deck.pptx', 'C:\\shared\\old-deck.pptx');
    const entries = [message(1, 'x'.repeat(3_100)), artifactEntry(10, 'world', old), message(30, 'use old-deck.pptx')];
    const projected = readContext(buildCollaborationContext({
      task, dispatch: { ...dispatch, objective: 'use old-deck.pptx' }, entries,
    }));

    expect(projected.selectedArtifacts).toMatchObject([{ id: 'old-ppt', localPath: 'C:\\shared\\old-deck.pptx' }]);
    expect(projected.entries[0]).toMatchObject({ contentChars: 3_100, excerpted: true });
  });
});

function message(sequence: number, content: string): ContextEntry {
  return {
    sequence, recordedAt: '2026-09-01T00:00:00.000Z',
    event: {
      kind: 'message', messageId: `m-${sequence}`, actor: { type: 'human', id: 'user' }, content,
      targetAgentIds: ['world'], visibility: { kind: 'task-public' }, references: [],
      occurredAt: '2026-09-01T00:00:00.000Z',
    },
  };
}

function action(sequence: number, content: string): ContextEntry {
  return {
    sequence, recordedAt: '2026-09-01T00:00:00.000Z',
    event: {
      kind: 'action', action: 'return', actorAgentId: 'world', content, references: [],
      visibility: { kind: 'task-public' }, causedByDispatchId: `d-${sequence}`,
      occurredAt: '2026-09-01T00:00:00.000Z',
    },
  };
}

function artifact(id: string, name: string, localPath: string): SharedArtifact {
  return { id, name, kind: 'file', localPath, sha256: `sha-${id}`, size: 42 };
}

function artifactEntry(sequence: number, actorAgentId: string, value: SharedArtifact): ContextEntry {
  return {
    sequence, recordedAt: '2026-09-01T00:00:00.000Z',
    event: {
      kind: 'artifact', actorAgentId, artifact: value,
      occurredAt: '2026-09-01T00:00:00.000Z', visibility: { kind: 'task-public' },
    },
  };
}

function readContext(value: string): {
  entries: Array<Record<string, unknown> & { sequence: number }>;
  artifactCatalog: Array<Record<string, unknown>>;
  selectedArtifacts: Array<Record<string, unknown>>;
} {
  const match = value.match(/<collaboration_context>\n([\s\S]*?)\n<\/collaboration_context>/);
  if (!match) throw new Error('missing collaboration context section');
  return JSON.parse(match[1]!) as ReturnType<typeof readContext>;
}
