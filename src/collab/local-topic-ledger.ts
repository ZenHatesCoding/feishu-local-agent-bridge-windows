import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import type { NormalizedAttachment } from '../media/attachment';
import { WorkerMemoryRuntime, type MemorySynthesizer } from '../memory/runtime';
import type { MemoryLimits } from '../memory/types';

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
  readonly memory?: WorkerMemoryRuntime;
  readonly path: string;
  private readonly seen = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(rootDir: string, options?: { memoryRoot: string; owner: string; tenant: string; host?: string; synthesize?: MemorySynthesizer; limits?: Partial<MemoryLimits> }) {
    this.path = join(rootDir, 'collaboration', 'local-topic-ledger.jsonl');
    if (options) this.memory = new WorkerMemoryRuntime(options.memoryRoot, options.owner, options.tenant, options.synthesize, options.limits, options.host);
  }

  async load(): Promise<void> {
    if (this.memory) return; // SQLite source uniqueness replaces whole-file replay.
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
    const senderType = (msg.raw as { sender?: { sender_type?: string } } | undefined)?.sender?.sender_type;
    this.memory?.store.ingest(scope, { origin: `message:${msg.messageId}`, kind: 'message', content: msg.content, actor: senderType === 'app' || senderType === 'bot' ? 'agent' : senderType === 'user' ? 'human' : 'unknown' });
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
    for (const attachment of attachments) this.memory?.store.ingest(scope, { origin: `attachment:${attachment.sourceMessageId}:${attachment.hash}`, kind: 'attachment', content: JSON.stringify({ name: attachment.originalName, hash: attachment.hash, path: attachment.absPath, decision: attachment.decision }), actor: 'tool' });
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
    this.memory?.store.ingest(scope, { origin: `bot-result:${runId}`, kind: 'bot-result', content, actor: 'agent' });
    return this.append({
      id: `bot-result:${runId}`,
      scope,
      recordedAt: new Date().toISOString(),
      kind: 'bot-result',
      content,
    });
  }

  async query(scope: string, query?: string, limit = 12): Promise<LocalTopicRecord[]> {
    if (this.memory) {
      const topic = this.memory.store.topic(scope);
      const records = query
        ? this.memory.store.search(topic.id, query, limit).map(hit => this.memory!.store.inspect(topic.id, (hit as { id: string }).id)).filter(hit => 'seq' in (hit as object))
        : this.memory.store.tail(topic.id, limit);
      return records.map(value => { const event = value as import('../memory/types').MemoryEvent; return { id: event.id, scope, recordedAt: event.at, kind: event.kind as LocalTopicRecord['kind'], content: event.content }; });
    }
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
    if (this.memory) Object.assign(record, { authorAgentId: this.memory.store.owner });
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
