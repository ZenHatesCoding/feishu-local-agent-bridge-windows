import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryDatabase, type MemoryDatabase } from './database';
import { DEFAULT_MEMORY_LIMITS, memoryCost, memoryError, memoryLimitsFromEnvironment, type MemoryBinding, type MemoryCandidate, type MemoryEvent, type MemoryItem, type MemoryJob, type MemoryLimits, type MemoryTopic } from './types';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
interface TopicRow { id: string; scope: string; next_seq: number; revision: number; state_through: number; items: string }
interface SummaryRow { id: string; start_seq: number; end_seq: number; depth: number; text: string; sources: string }

export class MemoryStore {
  readonly db: MemoryDatabase;
  readonly instanceId: string;
  readonly limits: MemoryLimits;
  readonly path: string;
  constructor(readonly root: string, readonly owner: string, readonly tenant: string, limits: Partial<MemoryLimits> = {}) {
    mkdirSync(root, { recursive: true });
    try { writeFileSync(join(root, 'identity.json'), JSON.stringify({ instanceId: randomUUID(), owner, tenant }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const identity = JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8')) as { instanceId: string; owner: string; tenant: string };
    if (identity.owner !== owner || identity.tenant !== tenant) memoryError('identity-mismatch');
    this.instanceId = identity.instanceId;
    this.limits = { ...DEFAULT_MEMORY_LIMITS, ...memoryLimitsFromEnvironment(), ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) memoryError('invalid-budget');
    this.path = join(root, 'memory.sqlite');
    this.db = openMemoryDatabase(this.path);
    try { chmodSync(this.path, 0o600); } catch { /* Windows ACLs are inherited. */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_info(version INTEGER NOT NULL);
      INSERT INTO schema_info SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_info);
      CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,scope TEXT UNIQUE NOT NULL,next_seq INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0,state_through INTEGER NOT NULL DEFAULT 0,items TEXT NOT NULL DEFAULT '[]',last_error TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(topic TEXT NOT NULL REFERENCES topics(id),seq INTEGER NOT NULL,id TEXT UNIQUE NOT NULL,origin TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,data TEXT,PRIMARY KEY(topic,seq),UNIQUE(topic,origin));
      CREATE INDEX IF NOT EXISTS event_origin ON events(topic,origin);
      CREATE TABLE IF NOT EXISTS revisions(topic TEXT NOT NULL,revision INTEGER NOT NULL,through_seq INTEGER NOT NULL,items TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(topic,revision));
      CREATE TABLE IF NOT EXISTS parked_items(topic TEXT NOT NULL,item_id TEXT NOT NULL,item TEXT NOT NULL,through_seq INTEGER NOT NULL,PRIMARY KEY(topic,item_id));
      CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY,topic TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,depth INTEGER NOT NULL,text TEXT NOT NULL,sources TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS summary_topic ON summaries(topic,active,start_seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(topic UNINDEXED,id UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,topic TEXT NOT NULL,fence INTEGER NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,remaining INTEGER NOT NULL,projection TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,topic TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,token TEXT NOT NULL,expires INTEGER NOT NULL,input TEXT NOT NULL,error TEXT,created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS job_topic ON jobs(topic,status);
      CREATE TABLE IF NOT EXISTS imports(path TEXT PRIMARY KEY,offset INTEGER NOT NULL DEFAULT 0,unknown_count INTEGER NOT NULL DEFAULT 0);
    `);
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!jobColumns.some(column => column.name === 'attempts')) this.db.exec('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    const version = this.db.prepare('SELECT version FROM schema_info').get() as { version: number };
    if (version.version !== 1) memoryError('unsupported-schema');
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  topic(scope: string): MemoryTopic {
    if (!scope || scope.length > 1024) memoryError('invalid-scope');
    const id = hash(`${this.instanceId}\0${this.tenant}\0${scope}`).slice(0, 32);
    this.db.prepare('INSERT OR IGNORE INTO topics(id,scope) VALUES(?,?)').run(id, scope);
    return this.getTopic(id);
  }
  getTopic(id: string): MemoryTopic {
    const row = this.db.prepare('SELECT * FROM topics WHERE id=?').get(id) as TopicRow | undefined;
    if (!row) memoryError('unknown-topic');
    return { ...row, items: JSON.parse(row.items) as MemoryItem[] };
  }
  topics(): MemoryTopic[] {
    return (this.db.prepare('SELECT id FROM topics ORDER BY rowid DESC LIMIT 1000').all() as { id: string }[]).map(row => this.getTopic(row.id));
  }
  ingest(scope: string, event: { origin: string; kind: string; content: string; actor?: MemoryEvent['actor']; at?: string; data?: unknown }): MemoryEvent {
    const content = redactMemorySecrets(event.content);
    if (memoryCost(content) > 5000) {
      const digest = hash(content);
      mkdirSync(join(this.root, 'blobs'), { recursive: true });
      try { writeFileSync(join(this.root, 'blobs', digest), content, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const parts: string[] = []; let part = '', cost = 0;
      for (const char of content) { const size = memoryCost(char); if (cost + size > 5000) { parts.push(part); part = ''; cost = 0; } part += char; cost += size; }
      if (part) parts.push(part);
      let first: MemoryEvent | undefined;
      parts.forEach((text, index) => {
        const saved = this.ingestOne(scope, { ...event, origin: index === 0 ? event.origin : `${event.origin}:part:${index}`, content: text, data: { originalData: event.data, fragment: { index, count: parts.length, sha256: digest } } });
        first ??= saved;
      });
      return first!;
    }
    return this.ingestOne(scope, { ...event, content });
  }
  private ingestOne(scope: string, event: { origin: string; kind: string; content: string; actor?: MemoryEvent['actor']; at?: string; data?: unknown }): MemoryEvent {
    const topic = this.topic(scope);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM events WHERE topic=? AND origin=?').get(topic.id, event.origin);
      if (old) return decodeEvent(old);
      if (!event.origin || event.origin.length > 2048) memoryError('invalid-origin');
      const next = this.getTopic(topic.id).next_seq;
      const id = `evt_${topic.id.slice(0, 12)}_${next}`;
      const content = redactMemorySecrets(event.content);
      const at = event.at ?? new Date().toISOString();
      const data = event.data === undefined ? null : JSON.stringify(event.data);
      this.db.prepare('INSERT INTO events(topic,seq,id,origin,kind,content,actor,at,data) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(topic.id, next, id, event.origin, event.kind, content, event.actor ?? 'unknown', at, data);
      this.db.prepare('UPDATE topics SET next_seq=next_seq+1 WHERE id=?').run(topic.id);
      this.index(topic.id, id, content);
      return { id, seq: next, origin: event.origin, kind: event.kind, content, actor: event.actor ?? 'unknown', at, ...(event.data === undefined ? {} : { data: event.data }) };
    });
  }
  events(topic: string, after = 0, limit = 50, through = Number.MAX_SAFE_INTEGER): MemoryEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE topic=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?')
      .all(topic, after, through, Math.min(Math.max(limit, 1), 200)).map(decodeEvent);
  }
  tail(topic: string, limit = 12): MemoryEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE topic=? ORDER BY seq DESC LIMIT ?').all(topic, Math.min(Math.max(limit, 1), 50)).map(decodeEvent).reverse();
  }
  private index(topic: string, id: string, text: string): void {
    this.db.prepare('INSERT INTO search_index(topic,id,text) VALUES(?,?,?)').run(topic, id, indexText(text));
  }
  inspect(topic: string, id: string): unknown {
    const event = this.db.prepare('SELECT * FROM events WHERE topic=? AND id=?').get(topic, id);
    if (event) return decodeEvent(event);
    const summary = this.db.prepare('SELECT id,start_seq,end_seq,depth,text,sources FROM summaries WHERE topic=? AND id=?').get(topic, id) as SummaryRow | undefined;
    if (summary) return { ...summary, sources: JSON.parse(summary.sources) as string[] };
    if (id.startsWith('state_')) {
      const current = this.getTopic(topic);
      const item = current.items.find(value => `state_${value.itemId}` === id);
      if (item) return { id, ...item, sources: item.sourceRefs, end_seq: current.state_through };
    }
    if (id.startsWith('parked_')) {
      const parked = this.db.prepare('SELECT item,through_seq FROM parked_items WHERE topic=? AND item_id=?').get(topic, id.slice(7)) as { item: string; through_seq: number } | undefined;
      if (parked) { const item = JSON.parse(parked.item) as MemoryItem; return { id, ...item, sources: item.sourceRefs, end_seq: parked.through_seq }; }
    }
    memoryError('source-not-found');
  }
  search(topic: string, query: string, limit = 10, through = Number.MAX_SAFE_INTEGER): unknown[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const expression = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ');
    return this.db.prepare('SELECT id,snippet(search_index,2,\'\',\'\',\'…\',24) AS snippet FROM search_index WHERE topic=? AND search_index MATCH ? AND (id IN (SELECT id FROM events WHERE topic=? AND seq<=?) OR id IN (SELECT id FROM summaries WHERE topic=? AND end_seq<=?) OR (id LIKE \'state_%\' AND EXISTS(SELECT 1 FROM topics WHERE id=? AND state_through<=?)) OR id IN (SELECT \'parked_\'||item_id FROM parked_items WHERE topic=? AND through_seq<=?)) ORDER BY rank LIMIT ?')
      .all(topic, expression, topic, through, topic, through, topic, through, topic, through, Math.min(Math.max(limit, 1), 50));
  }
  activeSummaries(topic: string): SummaryRow[] {
    return this.db.prepare('SELECT * FROM summaries WHERE topic=? AND active=1 ORDER BY start_seq DESC LIMIT 100').all(topic) as SummaryRow[];
  }
  bind(topic: string, runId: string = randomUUID(), fence = this.getTopic(topic).next_seq - 1): MemoryBinding {
    const binding = { topic, runId, fence, nonce: randomUUID(), expires: Date.now() + 24 * 3600_000 };
    this.db.prepare('INSERT INTO runs(id,topic,fence,nonce,expires,remaining) VALUES(?,?,?,?,?,?)').run(runId, topic, fence, hash(binding.nonce), binding.expires, this.limits.retrieval);
    return binding;
  }
  validateBinding(binding: MemoryBinding): void {
    const row = this.db.prepare('SELECT topic,fence,nonce,expires FROM runs WHERE id=?').get(binding.runId) as { topic: string; fence: number; nonce: string; expires: number } | undefined;
    const digest = hash(binding.nonce ?? '');
    if (!row || row.topic !== binding.topic || row.fence !== binding.fence || row.expires < Date.now()
      || !timingSafeEqual(Buffer.from(row.nonce), Buffer.from(digest))) memoryError('invalid-run-binding');
  }
  boundedResult(binding: MemoryBinding, values: unknown[]): { results: unknown[]; remaining: number; truncated: boolean } {
    this.validateBinding(binding);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT remaining FROM runs WHERE id=?').get(binding.runId) as { remaining: number };
      const results: unknown[] = [];
      if (row.remaining < 128) memoryError('retrieval-budget-exhausted');
      let remaining = row.remaining - 128;
      for (const value of values) {
        const cost = memoryCost(value) + 8;
        if (cost > remaining) break;
        results.push(value); remaining -= cost;
      }
      this.db.prepare('UPDATE runs SET remaining=? WHERE id=?').run(remaining, binding.runId);
      return { results, remaining, truncated: results.length < values.length };
    });
  }
  saveProjection(binding: MemoryBinding, projection: unknown): void {
    this.validateBinding(binding);
    this.db.prepare('UPDATE runs SET projection=? WHERE id=?').run(JSON.stringify(projection), binding.runId);
  }
  checkpoint(topicId: string, candidate: MemoryCandidate, binding?: MemoryBinding, job?: MemoryJob): { revision: number } {
    if (binding) this.validateBinding(binding);
    return this.transaction(() => {
      const topic = this.getTopic(topicId);
      if (topic.revision !== candidate.baseRevision) memoryError('stale-revision');
      if (!Number.isSafeInteger(candidate.through) || candidate.through < topic.state_through || candidate.through >= topic.next_seq
        || (binding && candidate.through > binding.fence)) memoryError('invalid-coverage');
      if (job) {
        const lease = this.db.prepare('SELECT token,status,expires FROM jobs WHERE id=?').get(job.id) as { token: string; status: string; expires: number } | undefined;
        if (!lease || lease.token !== job.token || lease.status !== 'running' || lease.expires < Date.now()) memoryError('stale-job');
      }
      this.validateItems(topic, candidate.items, candidate.through);
      if (memoryCost(candidate.items) > this.limits.state) memoryError('state-over-budget');
      if (candidate.through > topic.state_through && !candidate.summary?.trim()) memoryError('summary-required-for-coverage');
      if (candidate.summary && memoryCost(candidate.summary) > this.limits.summaries) memoryError('summary-over-budget');
      const revision = topic.revision + 1;
      for (const old of topic.items) {
        if (old.kind === 'todo' && ['active','parked','disputed'].includes(old.status) && !candidate.items.some(item => item.itemId === old.itemId || item.supersedes === old.itemId)) {
          const parked = { ...old, status: 'parked' };
          this.db.prepare('INSERT OR REPLACE INTO parked_items(topic,item_id,item,through_seq) VALUES(?,?,?,?)').run(topicId, old.itemId, JSON.stringify(parked), topic.state_through);
          this.db.prepare('DELETE FROM search_index WHERE topic=? AND id=?').run(topicId, `parked_${old.itemId}`);
          this.index(topicId, `parked_${old.itemId}`, old.text);
        }
      }
      this.db.prepare('DELETE FROM search_index WHERE topic=? AND id LIKE \'state_%\'').run(topicId);
      for (const item of candidate.items) {
        this.index(topicId, `state_${item.itemId}`, item.text);
        for (const id of [item.itemId, item.supersedes].filter((value): value is string => Boolean(value))) {
          this.db.prepare('DELETE FROM parked_items WHERE topic=? AND item_id=?').run(topicId, id);
          this.db.prepare('DELETE FROM search_index WHERE topic=? AND id=?').run(topicId, `parked_${id}`);
        }
      }
      this.db.prepare('INSERT INTO revisions(topic,revision,through_seq,items,at) VALUES(?,?,?,?,?)').run(topicId, revision, candidate.through, JSON.stringify(candidate.items), new Date().toISOString());
      this.db.prepare('UPDATE topics SET revision=?,state_through=?,items=?,last_error=NULL,retry_at=0 WHERE id=?').run(revision, candidate.through, JSON.stringify(candidate.items), topicId);
      if (candidate.summary) {
        const sources = job?.sources ?? this.events(topicId, topic.state_through, 200, candidate.through).map(event => event.id);
        if (!job && sources.length && (this.inspect(topicId, sources.at(-1)!) as MemoryEvent).seq !== candidate.through) memoryError('coverage-too-large');
        const id = `sum_${randomUUID()}`;
        const depth = job?.kind === 'condense' ? 1 + Math.max(...job.sources.map(source => (this.inspect(topicId, source) as { depth: number }).depth)) : 0;
        this.db.prepare('INSERT INTO summaries(id,topic,start_seq,end_seq,depth,text,sources) VALUES(?,?,?,?,?,?,?)')
          .run(id, topicId, job?.start ?? topic.state_through + 1, job?.end ?? candidate.through, depth, candidate.summary, JSON.stringify(sources));
        if (job?.kind === 'condense') for (const source of job.sources) this.db.prepare('UPDATE summaries SET active=0 WHERE id=? AND topic=?').run(source, topicId);
        this.index(topicId, id, candidate.summary);
      }
      if (job) this.db.prepare('UPDATE jobs SET status=\'done\' WHERE id=? AND token=?').run(job.id, job.token);
      return { revision };
    });
  }
  private validateItems(topic: MemoryTopic, items: MemoryItem[], through: number): void {
    if (!Array.isArray(items) || items.length > 100) memoryError('invalid-items');
    const ids = new Set<string>();
    for (const item of items) {
      if (!item || typeof item.itemId !== 'string' || !/^[\p{L}\p{N}_.-]{1,100}$/u.test(item.itemId) || ids.has(item.itemId)
        || !['goal','constraint','decision','progress','todo','evidence','hypothesis'].includes(item.kind)
        || !['active','resolved','superseded','disputed','parked'].includes(item.status)
        || typeof item.text !== 'string' || !item.text.trim() || memoryCost(item.text) > 1800
        || !Array.isArray(item.sourceRefs) || !item.sourceRefs.length || item.sourceRefs.length > 20
        || !['human-explicit','agent-reported','tool-observed'].includes(item.evidenceLevel)) memoryError('invalid-items');
      ids.add(item.itemId);
      for (const id of item.sourceRefs) {
        const source = this.db.prepare('SELECT actor,seq FROM events WHERE topic=? AND id=?').get(topic.id, id) as { actor: string; seq: number } | undefined;
        if (!source || source.seq > through) memoryError('invalid-sources');
        if (item.evidenceLevel === 'tool-observed' && source.actor !== 'tool') memoryError('fabricated-verification');
      }
      if (item.evidenceLevel === 'human-explicit' && !item.sourceRefs.some(id => (this.inspect(topic.id, id) as MemoryEvent).actor === 'human')) memoryError('fabricated-user-decision');
    }
    for (const old of topic.items.filter(item => item.pinned && item.status === 'active')) {
      const next = items.find(item => item.itemId === old.itemId);
      if (!next) memoryError('pinned-item-dropped');
      if (!sameItem(next, old)) {
        const newHumanSource = next.sourceRefs.some(id => !old.sourceRefs.includes(id) && (this.inspect(topic.id, id) as MemoryEvent).actor === 'human');
        if (!newHumanSource || (next.status === 'active' && next.pinned !== true)) memoryError('pinned-item-changed-without-user-source');
      }
    }
  }
  claimJob(topicId: string, force = false, through = Number.MAX_SAFE_INTEGER): MemoryJob | undefined {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare('UPDATE jobs SET status=\'expired\' WHERE status=\'running\' AND expires<?').run(now);
      if (this.db.prepare('SELECT id FROM jobs WHERE topic=? AND status=\'running\'').get(topicId)) return undefined;
      const topic = this.getTopic(topicId);
      const retry = this.db.prepare('SELECT retry_at FROM topics WHERE id=?').get(topicId) as { retry_at: number };
      if (!force && retry.retry_at > now) return undefined;
      const quota = this.db.prepare('SELECT COALESCE(SUM(attempts),0) AS count FROM jobs WHERE created>?').get(now - 3600000) as { count: number };
      if (quota.count >= this.limits.maxCalls) return undefined;
      const events = this.events(topicId, topic.state_through, 100, through);
      let kind: MemoryJob['kind'] = 'update';
      let sources: string[] = [], start = topic.state_through + 1, end = topic.state_through;
      let records: unknown[] = [];
      if (events.length) {
        let cost = memoryCost({ currentItems: topic.items, records: [] }) + 100;
        let recordCost = 0;
        for (const event of events) {
          if (cost + memoryCost(event) > this.limits.chunk) break;
          // Small source batches leave room for a useful answer within one
          // bounded model call. A large indivisible record is still kept whole.
          if (records.length && recordCost + memoryCost(event) > Math.min(this.limits.state, 4000)) break;
          records.push(event); sources.push(event.id); end = event.seq; cost += memoryCost(event);
          recordCost += memoryCost(event);
        }
        if (!sources.length) { this.recordFailure(topicId, 'source-exceeds-maintenance-budget'); return undefined; }
        if (!force && cost < 2500 && events.length < 8 && !events.some(event => /必须|不要|改为|改成|取消|纠正|handoff|constraint|instead|must not/i.test(event.content))) return undefined;
      } else {
        const active = this.activeSummaries(topicId).reverse();
        let contiguous: SummaryRow[] = [];
        for (const node of active) {
          const previous = contiguous.at(-1);
          if (previous && (previous.depth !== node.depth || previous.end_seq + 1 !== node.start_seq)) contiguous = [];
          contiguous.push(node);
          if (contiguous.length === 4) break;
        }
        if (contiguous.length < 4) return undefined;
        kind = 'condense'; records = contiguous; sources = contiguous.map(node => node.id);
        start = contiguous[0]!.start_seq; end = contiguous.at(-1)!.end_seq;
      }
      // Include small original evidence for existing state as well as the new suffix.
      // Native hosts otherwise try to look up references outside this isolated job.
      const referencedEvidence: unknown[] = [];
      let remaining = Math.min(1500, this.limits.chunk - memoryCost({ currentItems: topic.items, records }) - 100);
      for (const id of new Set(topic.items.flatMap(item => item.sourceRefs))) {
        if (sources.includes(id)) continue;
        const evidence = this.inspect(topicId, id);
        const cost = memoryCost(evidence);
        if (cost > remaining) continue;
        referencedEvidence.push(evidence); remaining -= cost;
      }
      const job: MemoryJob = { id: randomUUID(), topic: topicId, kind, baseRevision: topic.revision, start, end, sources, token: randomUUID(), input: JSON.stringify({ currentItems: topic.items, records, referencedEvidence }) };
      this.db.prepare('INSERT INTO jobs(id,topic,kind,status,token,expires,input,created) VALUES(?,?,?,\'running\',?,?,?,?)')
        .run(job.id, topicId, kind, job.token, now + this.limits.timeoutMs + 30000, JSON.stringify(job), now);
      return job;
    });
  }
  recordFailure(topic: string, error: string, job?: MemoryJob): void {
    error = redactMemorySecrets(error);
    // Identical failed inputs back off instead of burning the hourly allowance
    // forever. New coverage/revision starts with the normal five-minute delay.
    const failures = job ? (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE topic=? AND status='failed' AND json_extract(input,'$.baseRevision')=? AND json_extract(input,'$.end')=?").get(topic, job.baseRevision, job.end) as { count: number }).count : 0;
    const delay = Math.min(21600000, 300000 * 2 ** Math.min(failures, 7));
    this.db.prepare('UPDATE topics SET last_error=?,retry_at=? WHERE id=?').run(error.slice(0, 300), Date.now() + delay, topic);
    if (job) this.db.prepare('UPDATE jobs SET status=\'failed\',error=? WHERE id=? AND token=?').run(error.slice(0, 300), job.id, job.token);
  }
  reserveCall(job: MemoryJob): boolean {
    return this.transaction(() => {
      const now = Date.now();
      const quota = this.db.prepare('SELECT COALESCE(SUM(attempts),0) AS count FROM jobs WHERE created>?').get(now - 3600000) as { count: number };
      if (quota.count >= this.limits.maxCalls) return false;
      const result = this.db.prepare('UPDATE jobs SET attempts=attempts+1,expires=? WHERE id=? AND token=? AND status=\'running\' AND expires>?').run(now + this.limits.timeoutMs + 30000, job.id, job.token, now);
      return Number(result.changes) === 1;
    });
  }
  status(topic: string): unknown {
    const row = this.db.prepare('SELECT id,scope,next_seq-1 AS observedThrough,revision,state_through AS stateThrough,last_error AS lastError,retry_at AS retryAt FROM topics WHERE id=?').get(topic);
    const counts = this.db.prepare('SELECT COUNT(*) AS summaries FROM summaries WHERE topic=? AND active=1').get(topic);
    const parked = this.db.prepare('SELECT COUNT(*) AS parkedOpenItems FROM parked_items WHERE topic=?').get(topic);
    const legacy = this.db.prepare('SELECT COALESCE(SUM(unknown_count),0) AS legacyUnattributed FROM imports').get();
    return { ...row as object, ...counts as object, ...parked as object, ...legacy as object, instanceId: this.instanceId, accounting: 'conservative-utf8-bytes', hostContextCapacity: 'host-owned; not inferred from memory budget', limits: this.limits };
  }
  rollback(topicId: string, revision: number): void {
    this.transaction(() => {
      const old = revision === 0 ? { through_seq: 0, items: '[]' } : this.db.prepare('SELECT through_seq,items FROM revisions WHERE topic=? AND revision=?').get(topicId, revision) as { through_seq: number; items: string } | undefined;
      if (!old) memoryError('unknown-revision');
      const topic = this.getTopic(topicId), next = topic.revision + 1;
      this.db.prepare('INSERT INTO revisions(topic,revision,through_seq,items,at) VALUES(?,?,?,?,?)').run(topicId, next, old.through_seq, old.items, new Date().toISOString());
      this.db.prepare('UPDATE topics SET revision=?,state_through=?,items=?,last_error=NULL,retry_at=0 WHERE id=?').run(next, old.through_seq, old.items, topicId);
      this.db.prepare('UPDATE summaries SET active=0 WHERE topic=? AND end_seq>?').run(topicId, old.through_seq);
      this.db.prepare('DELETE FROM search_index WHERE topic=? AND id LIKE \'state_%\'').run(topicId);
      for (const item of JSON.parse(old.items) as MemoryItem[]) {
        this.index(topicId, `state_${item.itemId}`, item.text);
        this.db.prepare('DELETE FROM parked_items WHERE topic=? AND item_id=?').run(topicId, item.itemId);
        this.db.prepare('DELETE FROM search_index WHERE topic=? AND id=?').run(topicId, `parked_${item.itemId}`);
      }
    });
  }
  backup(path: string): void { this.db.prepare('VACUUM INTO ?').run(path); }
}

function decodeEvent(value: unknown): MemoryEvent {
  const row = value as MemoryEvent & { data?: string };
  return { ...row, ...(row.data ? { data: JSON.parse(row.data) as unknown } : {}) };
}
function searchTerms(text: string, maximum = 24): string[] {
  const words = text.toLocaleLowerCase().match(/[a-z0-9_./:\\-]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]))].slice(0, maximum);
}
function indexText(text: string): string { return `${text}\n${searchTerms(text, Number.MAX_SAFE_INTEGER).join(' ')}`; }
export function redactMemorySecrets(text: string): string {
  return text.replace(/(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED]')
    .replace(/((?:app[_ -]?secret|api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]');
}
function sameItem(a: MemoryItem, b: MemoryItem): boolean {
  return a.text === b.text && a.kind === b.kind && a.status === b.status && a.pinned === b.pinned
    && a.evidenceLevel === b.evidenceLevel && a.supersedes === b.supersedes
    && JSON.stringify([...a.sourceRefs].sort()) === JSON.stringify([...b.sourceRefs].sort());
}
