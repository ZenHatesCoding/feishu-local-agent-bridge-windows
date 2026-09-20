import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import type { NormalizedAttachment } from '../media/attachment';

export interface LocalTopicRecord {
  id: string;
  scope: string;
  recordedAt: string;
  kind: 'message' | 'attachment' | 'bot-result';
  messageId?: string;
  senderId?: string;
  senderName?: string;
  content?: string;
  attachment?: {
    name?: string;
    path: string;
    hash: string;
    size: number;
    mime: string;
    sourceMessageId: string;
    decision: string;
  };
}

/**
 * A node-local, append-only record of what this computer actually observed.
 * It deliberately has no Hub replication: paths are useful only on this node.
 */
export class LocalTopicLedger {
  readonly path: string;
  private readonly seen = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.path = join(rootDir, 'collaboration', 'local-topic-ledger.jsonl');
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as LocalTopicRecord;
        if (record.id) this.seen.add(record.id);
      } catch {
        // A torn final append is not a reason to prevent the bridge starting.
      }
    }
  }

  recordMessage(scope: string, msg: NormalizedMessage): Promise<void> {
    return this.append({
      id: `message:${msg.messageId}`,
      scope,
      recordedAt: new Date().toISOString(),
      kind: 'message',
      messageId: msg.messageId,
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      content: msg.content,
    });
  }

  recordAttachments(scope: string, attachments: readonly NormalizedAttachment[]): Promise<void> {
    return Promise.all(attachments.map((attachment) => this.append({
      id: `attachment:${attachment.sourceMessageId}:${attachment.hash}`,
      scope,
      recordedAt: new Date().toISOString(),
      kind: 'attachment',
      messageId: attachment.sourceMessageId,
      attachment: {
        ...(attachment.originalName ? { name: attachment.originalName } : {}),
        path: attachment.absPath,
        hash: attachment.hash,
        size: attachment.size,
        mime: attachment.mime,
        sourceMessageId: attachment.sourceMessageId,
        decision: attachment.decision,
      },
    })) ).then(() => undefined);
  }

  recordBotResult(scope: string, runId: string, content: string): Promise<void> {
    return this.append({
      id: `bot-result:${runId}`,
      scope,
      recordedAt: new Date().toISOString(),
      kind: 'bot-result',
      content,
    });
  }

  async query(scope: string, query?: string, limit = 12): Promise<LocalTopicRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const terms = (query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const records: LocalTopicRecord[] = [];
    const emitted = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as LocalTopicRecord;
        if (record.scope !== scope || emitted.has(record.id)) continue;
        const haystack = JSON.stringify(record).toLocaleLowerCase();
        if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) continue;
        emitted.add(record.id);
        records.push(record);
      } catch {
        // Ignore a partially written final line.
      }
    }
    return records.slice(-boundedLimit);
  }

  private append(record: LocalTopicRecord): Promise<void> {
    if (this.seen.has(record.id)) return Promise.resolve();
    this.seen.add(record.id);
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
