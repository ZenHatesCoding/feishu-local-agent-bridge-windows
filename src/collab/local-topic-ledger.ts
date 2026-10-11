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
 * Agent-local, append-only record of what this bridge actually observed.
 * It deliberately has no Hub replication: paths are useful only on this node.
 *
 * One journal per topic (one directory per chat), so a new topic starts a new
 * file instead of appending to a single ever-growing ledger:
 *
 *   <root>/collaboration/topics/<chatId>/<threadId>.jsonl
 *   <root>/collaboration/topics/<chatId>/_chat.jsonl   (non-topic chat)
 *
 * The legacy single-file layout (<root>/collaboration/local-topic-ledger.jsonl)
 * is still read so upgrading in place keeps its history; new records are never
 * written there.
 */
export class LocalTopicLedger {
  readonly rootDir: string;
  readonly legacyPath: string;
  private readonly seenByScope = new Map<string, Set<string>>();
  private readonly tailByScope = new Map<string, Promise<void>>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.legacyPath = join(rootDir, 'collaboration', 'local-topic-ledger.jsonl');
  }

  /** Journal file that holds one scope (`chatId` or `chatId:threadId`). */
  pathForScope(scope: string): string {
    const { chatId, threadId } = splitScope(scope);
    const file = threadId ? `${safeSegment(threadId)}.jsonl` : '_chat.jsonl';
    return join(this.rootDir, 'collaboration', 'topics', safeSegment(chatId), file);
  }

  /** Kept for callers that need the legacy path (reading/archiving it). */
  get path(): string {
    return this.legacyPath;
  }

  /**
   * Scopes load lazily on first use, so this stays a cheap hook for the bridge
   * startup path and keeps the old call site working.
   */
  async load(): Promise<void> {}

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
    const terms = (query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const records: LocalTopicRecord[] = [];
    const emitted = new Set<string>();
    for (const file of [this.legacyPath, this.pathForScope(scope)]) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
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
    }
    // The legacy file and the per-topic file may interleave in time.
    records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return records.slice(-boundedLimit);
  }

  private async ensureScope(scope: string): Promise<Set<string>> {
    const existing = this.seenByScope.get(scope);
    if (existing) return existing;
    const ids = new Set<string>();
    for (const file of [this.legacyPath, this.pathForScope(scope)]) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as LocalTopicRecord;
          if (record.id && record.scope === scope) ids.add(record.id);
        } catch {
          // A torn final append is not a reason to fail a run.
        }
      }
    }
    this.seenByScope.set(scope, ids);
    return ids;
  }

  private append(record: LocalTopicRecord): Promise<void> {
    const previous = this.tailByScope.get(record.scope) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const seen = await this.ensureScope(record.scope);
      if (seen.has(record.id)) return;
      const file = this.pathForScope(record.scope);
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
      seen.add(record.id);
    });
    this.tailByScope.set(record.scope, operation.catch(() => {}));
    return operation;
  }
}

function splitScope(scope: string): { chatId: string; threadId?: string } {
  const separator = scope.indexOf(':');
  if (separator < 0) return { chatId: scope };
  return { chatId: scope.slice(0, separator), threadId: scope.slice(separator + 1) };
}

/** Feishu ids are already path-safe; this keeps a malformed scope from escaping the root. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}
