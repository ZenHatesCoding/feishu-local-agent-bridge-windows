import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalTopicLedger } from '../../../src/collab/local-topic-ledger';

describe('LocalTopicLedger', () => {
  it('keeps node-local topic history searchable without mixing topics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-topic-ledger-'));
    const ledger = new LocalTopicLedger(root);
    await ledger.recordMessage('chat:topic-a', {
      messageId: 'm1', senderId: 'world', content: 'Justice review the diagram',
    } as never);
    await ledger.recordMessage('chat:topic-b', {
      messageId: 'm2', senderId: 'world', content: 'Unrelated task',
    } as never);
    await ledger.recordAttachments('chat:topic-a', [{
      absPath: 'C:/node-a/media/diagram.pdf', path: 'C:/node-a/media/diagram.pdf', hash: 'abc', size: 12,
      mime: 'application/pdf', kind: 'file', source: 'lark', sourceMessageId: 'm1', sourceFileKey: 'f1',
      originalName: 'diagram.pdf', requiredness: 'optional', decision: 'accepted',
    }]);

    await ledger.recordMessage('chat:topic-a', {
      messageId: 'm1', senderId: 'world', content: 'duplicate should not append',
    } as never);
    const records = await ledger.query('chat:topic-a', 'justice');
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toContain('Justice');
    expect(await ledger.query('chat:topic-a', 'diagram')).toHaveLength(2);
    expect(await ledger.query('chat:topic-b')).toHaveLength(1);
  });
});
