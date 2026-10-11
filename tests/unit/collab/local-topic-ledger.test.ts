import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalTopicLedger } from '../../../src/collab/local-topic-ledger';

describe('LocalTopicLedger', () => {
  it('keeps agent-local topic history searchable without mixing topics', async () => {
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

  it('starts a new journal file for every topic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-topic-ledger-'));
    const ledger = new LocalTopicLedger(root);
    await ledger.recordMessage('chat-a:topic-1', {
      messageId: 'm1', senderId: 'world', content: 'first topic',
    } as never);
    await ledger.recordMessage('chat-a:topic-2', {
      messageId: 'm2', senderId: 'world', content: 'second topic',
    } as never);
    await ledger.recordMessage('chat-b', {
      messageId: 'm3', senderId: 'world', content: 'chat without a topic',
    } as never);

    const topicOne = ledger.pathForScope('chat-a:topic-1');
    const topicTwo = ledger.pathForScope('chat-a:topic-2');
    const chatOnly = ledger.pathForScope('chat-b');
    expect(topicOne).not.toBe(topicTwo);
    expect(topicOne.endsWith(join('topics', 'chat-a', 'topic-1.jsonl'))).toBe(true);
    expect(chatOnly.endsWith(join('topics', 'chat-b', '_chat.jsonl'))).toBe(true);

    // The legacy single file is never written once topics are journaled.
    expect(existsSync(ledger.legacyPath)).toBe(false);
    expect((await readFile(topicOne, 'utf8')).trim().split('\n')).toHaveLength(1);
    const topicTwoBody = await readFile(topicTwo, 'utf8');
    expect(topicTwoBody).toContain('second topic');
    expect(topicTwoBody).not.toContain('first topic');
    expect(await readFile(chatOnly, 'utf8')).toContain('chat without a topic');
  });

  it('still reads the legacy single-file ledger after an upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-topic-ledger-'));
    const ledger = new LocalTopicLedger(root);
    const legacy = new LocalTopicLedger(root).legacyPath;
    const { mkdir, appendFile } = await import('node:fs/promises');
    await mkdir(join(root, 'collaboration'), { recursive: true });
    await appendFile(legacy, `${JSON.stringify({
      id: 'message:m-old', scope: 'chat-a:topic-1', recordedAt: '2024-01-01T00:00:00.000Z',
      kind: 'message', messageId: 'm-old', senderId: 'world', content: 'legacy record',
    })}\n`, 'utf8');

    await ledger.recordMessage('chat-a:topic-1', {
      messageId: 'm-new', senderId: 'world', content: 'new record',
    } as never);

    const records = await ledger.query('chat-a:topic-1');
    expect(records.map((record) => record.messageId)).toEqual(['m-old', 'm-new']);
    // The legacy entry is never duplicated into the new file.
    expect(await ledger.query('chat-a:topic-1', 'legacy record')).toHaveLength(1);
  });
});
