import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { LedgerRecord, TaskAddress } from '../collab/types';
import { taskIdFor } from '../collab/task-id';
import type { LanRunEvent, LanRunEventRecord, LanStoredFile, LanStore, LanAttemptState } from './types';

/**
 * node:sqlite is still flagged experimental, so older bundlers/test runners
 * do not know it as a builtin. Resolve it through createRequire so both the
 * tsup bundle and vitest treat it as a plain runtime require.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const SCHEMA_VERSION = '1';

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  address TEXT,
  recorded_at TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger(task_id, seq);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tokens (
  agent_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_conversation ON files(conversation_id);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_dispatch ON attempts(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts(state);
CREATE TABLE IF NOT EXISTS run_events (
  stream_id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_conversation ON run_events(conversation_id, stream_id);
CREATE TABLE IF NOT EXISTS task_canceled (
  task_id TEXT PRIMARY KEY
);
`;

interface LedgerRow {
  seq: number;
  idempotency_key: string;
  task_id: string;
  address: string | null;
  recorded_at: string;
  event: string;
}

interface RunEventRow {
  stream_id: number;
  conversation_id: string;
  task_id: string;
  run_id: string;
  type: string;
  at: string;
  payload: string;
}

/**
 * SQLite-backed LAN center store. One database file per deployment, WAL mode,
 * single writer (the center process). Every append is a single SQLite
 * transaction, so replay never observes a partial Hub submit. The
 * CollaborationLedger surface stays async for Hub compatibility.
 */
export class SqliteLanStore implements LanStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(
    readonly deploymentId: string,
    readonly databasePath: string,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(DDL);
    if (this.metaGet('schema_version') !== SCHEMA_VERSION) {
      this.metaSet('schema_version', SCHEMA_VERSION);
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // ---- meta ----

  metaGet(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  metaSet(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  // ---- CollaborationLedger ----

  readAll(): Promise<LedgerRecord[]> {
    return Promise.resolve(
      (this.db.prepare('SELECT * FROM ledger ORDER BY seq').all() as unknown as LedgerRow[])
        .map((row) => ledgerRowToRecord(row)),
    );
  }

  append(records: LedgerRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        'INSERT INTO ledger(seq, idempotency_key, task_id, address, recorded_at, event) VALUES(?, ?, ?, ?, ?, ?)',
      );
      for (const record of records) {
        insert.run(
          record.sequence,
          record.idempotencyKey,
          record.taskId,
          record.address ? JSON.stringify(record.address) : null,
          record.recordedAt,
          JSON.stringify(record.event),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  ledgerRecordsForConversation(conversationId: string, afterSequence: number): LedgerRecord[] {
    const taskId = taskIdFor({ deploymentId: this.deploymentId, conversationId });
    return (this.db
      .prepare('SELECT * FROM ledger WHERE task_id = ? AND seq > ? ORDER BY seq')
      .all(taskId, afterSequence) as unknown as LedgerRow[])
      .map((row) => ledgerRowToRecord(row));
  }

  ledgerTail(limit: number): LedgerRecord[] {
    return (this.db
      .prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?')
      .all(limit) as unknown as LedgerRow[])
      .reverse()
      .map((row) => ledgerRowToRecord(row));
  }

  // ---- conversations ----

  createConversation(input: { id: string; title: string; createdBy: string; createdAt: string }): void {
    this.db.prepare(
      'INSERT INTO conversations(id, title, created_at, created_by) VALUES(?, ?, ?, ?)',
    ).run(input.id, input.title, input.createdAt, input.createdBy);
  }

  listConversations(): Array<{ id: string; title: string; createdAt: string; createdBy: string }> {
    return this.db
      .prepare('SELECT id, title, created_at AS createdAt, created_by AS createdBy FROM conversations ORDER BY created_at')
      .all() as unknown as Array<{ id: string; title: string; createdAt: string; createdBy: string }>;
  }

  getConversation(id: string): { id: string; title: string; createdAt: string; createdBy: string } | undefined {
    return this.db
      .prepare('SELECT id, title, created_at AS createdAt, created_by AS createdBy FROM conversations WHERE id = ?')
      .get(id) as unknown as { id: string; title: string; createdAt: string; createdBy: string } | undefined;
  }

  // ---- users & sessions ----

  upsertUser(input: { username: string; displayName: string; passwordHash: string }): void {
    this.db.prepare(
      `INSERT INTO users(username, display_name, password_hash) VALUES(?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash`,
    ).run(input.username, input.displayName, input.passwordHash);
  }

  getUser(username: string): { username: string; displayName: string; passwordHash: string } | undefined {
    return this.db
      .prepare('SELECT username, display_name AS displayName, password_hash AS passwordHash FROM users WHERE username = ?')
      .get(username) as unknown as { username: string; displayName: string; passwordHash: string } | undefined;
  }

  createSession(input: { tokenHash: string; username: string; createdAt: string; expiresAt: string }): void {
    this.db.prepare(
      'INSERT INTO sessions(token_hash, username, created_at, expires_at) VALUES(?, ?, ?, ?)',
    ).run(input.tokenHash, input.username, input.createdAt, input.expiresAt);
  }

  getSession(tokenHash: string): { username: string; expiresAt: string } | undefined {
    return this.db
      .prepare('SELECT username, expires_at AS expiresAt FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as unknown as { username: string; expiresAt: string } | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  // ---- agent credentials ----

  getAgentToken(agentId: string): string | undefined {
    const row = this.db.prepare('SELECT token_hash AS tokenHash FROM agent_tokens WHERE agent_id = ?')
      .get(agentId) as unknown as { tokenHash: string } | undefined;
    return row?.tokenHash;
  }

  setAgentToken(agentId: string, tokenHash: string): void {
    this.db.prepare(
      `INSERT INTO agent_tokens(agent_id, token_hash) VALUES(?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash`,
    ).run(agentId, tokenHash);
  }

  // ---- files ----

  saveFile(input: LanStoredFile): void {
    this.db.prepare(
      'INSERT INTO files(id, name, mime, size, sha256, uploaded_by, created_at, conversation_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(input.id, input.name, input.mime, input.size, input.sha256, input.uploadedBy, input.createdAt, input.conversationId ?? null);
  }

  getFile(id: string): LanStoredFile | undefined {
    return this.db
      .prepare(`SELECT id, name, mime, size, sha256,
                       uploaded_by AS uploadedBy, created_at AS createdAt,
                       conversation_id AS conversationId
                FROM files WHERE id = ?`)
      .get(id) as unknown as LanStoredFile | undefined;
  }

  listConversationFiles(conversationId: string): LanStoredFile[] {
    return this.db
      .prepare(`SELECT id, name, mime, size, sha256,
                       uploaded_by AS uploadedBy, created_at AS createdAt,
                       conversation_id AS conversationId
                FROM files WHERE conversation_id = ? ORDER BY created_at`)
      .all(conversationId) as unknown as LanStoredFile[];
  }

  // ---- attempts ----

  insertAttempt(input: {
    id: string;
    dispatchId: string;
    agentId: string;
    instanceId: string;
    claimedAt: string;
    heartbeatAt: string;
  }): void {
    this.db.prepare(
      `INSERT INTO attempts(id, dispatch_id, agent_id, instance_id, state, claimed_at, heartbeat_at)
       VALUES(?, ?, ?, ?, 'active', ?, ?)`,
    ).run(input.id, input.dispatchId, input.agentId, input.instanceId, input.claimedAt, input.heartbeatAt);
  }

  getAttempt(id: string): {
    id: string; dispatchId: string; agentId: string; instanceId: string;
    state: string; claimedAt: string; heartbeatAt: string;
  } | undefined {
    return this.db
      .prepare(
        `SELECT id, dispatch_id AS dispatchId, agent_id AS agentId, instance_id AS instanceId,
                state, claimed_at AS claimedAt, heartbeat_at AS heartbeatAt
         FROM attempts WHERE id = ?`,
      )
      .get(id) as unknown as {
        id: string; dispatchId: string; agentId: string; instanceId: string;
        state: string; claimedAt: string; heartbeatAt: string;
      } | undefined;
  }

  attemptsForDispatch(dispatchId: string): Array<{
    id: string; state: string; agentId: string; instanceId: string;
    claimedAt: string; heartbeatAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, agent_id AS agentId, instance_id AS instanceId, state,
                claimed_at AS claimedAt, heartbeat_at AS heartbeatAt
         FROM attempts WHERE dispatch_id = ? ORDER BY claimed_at`,
      )
      .all(dispatchId) as unknown as Array<{
        id: string; state: string; agentId: string; instanceId: string;
        claimedAt: string; heartbeatAt: string;
      }>;
  }

  touchAttemptHeartbeat(id: string, at: string): void {
    this.db.prepare('UPDATE attempts SET heartbeat_at = ? WHERE id = ? AND state = \'active\'').run(at, id);
  }

  setAttemptState(id: string, state: LanAttemptState): void {
    this.db.prepare('UPDATE attempts SET state = ? WHERE id = ?').run(state, id);
  }

  listAttempts(input: { state?: LanAttemptState }): Array<{
    id: string; dispatchId: string; agentId: string; instanceId: string;
    state: string; heartbeatAt: string;
  }> {
    const rows = input.state
      ? this.db
        .prepare(
          `SELECT id, dispatch_id AS dispatchId, agent_id AS agentId, instance_id AS instanceId, state,
                  heartbeat_at AS heartbeatAt
           FROM attempts WHERE state = ? ORDER BY claimed_at`,
        )
        .all(input.state)
      : this.db
        .prepare(
          `SELECT id, dispatch_id AS dispatchId, agent_id AS agentId, instance_id AS instanceId, state,
                  heartbeat_at AS heartbeatAt
           FROM attempts ORDER BY claimed_at`,
        )
        .all();
    return rows as unknown as Array<{
      id: string; dispatchId: string; agentId: string; instanceId: string;
      state: string; heartbeatAt: string;
    }>;
  }

  // ---- run progress stream ----

  appendRunEvents(conversationId: string, taskId: string, events: LanRunEvent[]): LanRunEventRecord[] {
    if (events.length === 0) return [];
    const records: LanRunEventRecord[] = [];
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        'INSERT INTO run_events(conversation_id, task_id, run_id, type, at, payload) VALUES(?, ?, ?, ?, ?, ?)',
      );
      for (const event of events) {
        const result = insert.run(
          conversationId,
          taskId,
          (event as { runId: string }).runId,
          event.type,
          event.at,
          JSON.stringify(event),
        ) as { lastInsertRowid: number | bigint };
        records.push({ ...event, streamId: Number(result.lastInsertRowid), conversationId, taskId } as LanRunEventRecord);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records;
  }

  runEventsAfter(conversationId: string, afterStreamId: number, limit = 500): LanRunEventRecord[] {
    return (this.db
      .prepare(
        'SELECT * FROM run_events WHERE conversation_id = ? AND stream_id > ? ORDER BY stream_id LIMIT ?',
      )
      .all(conversationId, afterStreamId, limit) as unknown as RunEventRow[])
      .map((row) => runEventRowToRecord(row));
  }

  // ---- task cancellation ----

  setTaskCanceled(taskId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO task_canceled(task_id) VALUES(?)').run(taskId);
  }

  isTaskCanceled(taskId: string): boolean {
    return this.db.prepare('SELECT 1 AS one FROM task_canceled WHERE task_id = ?').get(taskId) !== undefined;
  }
}

function ledgerRowToRecord(row: LedgerRow): LedgerRecord {
  return {
    sequence: row.seq,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    ...(row.address ? { address: JSON.parse(row.address) as TaskAddress } : {}),
    recordedAt: row.recorded_at,
    event: JSON.parse(row.event) as LedgerRecord['event'],
  };
}

function runEventRowToRecord(row: RunEventRow): LanRunEventRecord {
  const payload = JSON.parse(row.payload) as LanRunEvent;
  return {
    ...payload,
    streamId: row.stream_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
  } as LanRunEventRecord;
}
