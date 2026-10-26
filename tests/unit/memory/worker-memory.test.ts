import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/memory/store';
import { WorkerMemoryRuntime, parseMemoryCandidate } from '../../../src/memory/runtime';
import { memoryCost, type MemoryItem } from '../../../src/memory/types';

const roots: string[] = [];
const stores: MemoryStore[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), 'worker-memory-')); roots.push(path); return path; }
function store(path = root(), owner = 'worker-a'): MemoryStore { const result = new MemoryStore(path, owner, 'tenant'); stores.push(result); return result; }
function item(id: string, text = '报告必须两页'): MemoryItem {
  return { itemId: 'pages', kind: 'constraint', text, status: 'active', sourceRefs: [id], evidenceLevel: 'human-explicit', pinned: true };
}
afterEach(() => {
  for (const value of stores.splice(0)) { try { value.close(); } catch {} }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('autonomous Worker topic memory', () => {
  it('survives restart, deduplicates source IDs, and keeps identical legitimate messages', () => {
    const path = root(), first = store(path);
    const event = first.ingest('chat:thread', { origin: 'message:1', kind: 'message', content: '同一句话', actor: 'human' });
    first.close();
    const second = store(path);
    expect(second.ingest('chat:thread', { origin: 'message:1', kind: 'message', content: '同一句话' }).id).toBe(event.id);
    second.ingest('chat:thread', { origin: 'message:2', kind: 'message', content: '同一句话' });
    expect(second.events(second.topic('chat:thread').id)).toHaveLength(2);
  });
  it('does not confuse two instances of the same host or separate topics', () => {
    const a = store(), b = store(root(), 'worker-b');
    a.ingest('same:topic', { origin: '1', kind: 'message', content: '秘密方案甲' });
    b.ingest('same:topic', { origin: '1', kind: 'message', content: '方案乙' });
    expect(a.search(a.topic('different:topic').id, '方案')).toEqual([]);
    expect(b.search(b.topic('same:topic').id, '秘密')).toEqual([]);
    expect(() => new MemoryStore(a.root, 'worker-b', 'tenant')).toThrow('identity-mismatch');
  });
  it('indexes Chinese words beyond the beginning and preserves exact source IDs', () => {
    const db = store();
    const source = db.ingest('topic', { origin: '1', kind: 'message', content: '早期讨论各种内容'.repeat(40) + '最后改用量子通信，错误码 E_CONN_123，路径 D:/work/report.md' });
    expect(db.search(db.topic('topic').id, '量子通信')).toEqual(expect.arrayContaining([expect.objectContaining({ id: source.id })]));
    expect(db.search(db.topic('topic').id, 'E_CONN_123')).toHaveLength(1);
  });
  it('stores long originals losslessly as bounded parts and a content-addressed blob', () => {
    const db = store(), text = '中文长约束🧪'.repeat(1000);
    const first = db.ingest('topic', { origin: 'long', kind: 'message', content: text });
    const parts = db.events(db.topic('topic').id, 0, 200);
    expect(parts.map(part => part.content).join('')).toBe(text);
    expect(parts.every(part => memoryCost(part.content) <= 5000)).toBe(true);
    const fragment = (first.data as { fragment: { sha256: string } }).fragment;
    expect(readFileSync(join(db.root, 'blobs', fragment.sha256), 'utf8')).toBe(text);
    db.ingest('topic', { origin: 'long', kind: 'message', content: text });
    expect(db.events(db.topic('topic').id, 0, 200)).toHaveLength(parts.length);
  });
  it('rejects fabricated sources and tool verification without moving coverage', () => {
    const db = store(), topic = db.topic('t');
    const event = db.ingest('t', { origin: '1', kind: 'message', content: '我觉得通过了', actor: 'agent' });
    expect(() => db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [item('fabricated')], summary: 'summary' })).toThrow('invalid-sources');
    expect(() => db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [{ ...item(event.id), evidenceLevel: 'tool-observed' }], summary: 'summary' })).toThrow('fabricated-verification');
    expect(db.getTopic(topic.id).state_through).toBe(0);
  });
  it('retains pinned constraints, accepts explicit corrections and rejects stale writers', () => {
    const db = store(), topic = db.topic('t');
    const first = db.ingest('t', { origin: '1', kind: 'message', content: '报告必须一页', actor: 'human' });
    db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [item(first.id, '报告必须一页')], summary: '用户要求一页' });
    const later = db.ingest('t', { origin: '2', kind: 'message', content: '改成两页', actor: 'human' });
    expect(() => db.checkpoint(topic.id, { baseRevision: 1, through: 2, items: [], summary: '删除了约束' })).toThrow('pinned-item-dropped');
    db.checkpoint(topic.id, { baseRevision: 1, through: 2, items: [{ ...item(later.id), sourceRefs: [first.id, later.id] }], summary: '用户将页数改成两页' });
    expect(db.getTopic(topic.id).items[0]!.text).toBe('报告必须两页');
    expect(() => db.checkpoint(topic.id, { baseRevision: 1, through: 2, items: [], summary: '旧运行' })).toThrow('stale-revision');
    expect(db.events(topic.id)).toHaveLength(2);
  });
  it('does not misclassify reordered object keys as pinned edits', () => {
    const db = store(), topic = db.topic('t');
    const e = db.ingest('t', { origin: '1', kind: 'message', content: '报告两页', actor: 'human' });
    const old = item(e.id);
    db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [old], summary: '两页' });
    const reordered = Object.fromEntries(Object.entries(old).reverse()) as unknown as MemoryItem;
    expect(db.checkpoint(topic.id, { baseRevision: 1, through: 1, items: [reordered] }).revision).toBe(2);
  });
  it('accepts an explicit user revocation without forcing the retired constraint to stay pinned', () => {
    const db = store(), topic = db.topic('t');
    const first = db.ingest('t', { origin: '1', kind: 'message', content: '两页', actor: 'human' });
    db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [item(first.id)], summary: '两页' });
    const correction = db.ingest('t', { origin: '2', kind: 'message', content: '原两页约束作废', actor: 'human' });
    db.checkpoint(topic.id, { baseRevision: 1, through: 2, items: [{ ...item(first.id), status: 'superseded', pinned: false, sourceRefs: [first.id, correction.id] }], summary: '用户撤销两页限制' });
    expect(db.getTopic(topic.id).items[0]!.status).toBe('superseded');
  });
  it('archives dropped open work as searchable parked items rather than silently completing it', () => {
    const db = store(), topic = db.topic('t');
    const source = db.ingest('t', { origin: '1', kind: 'message', content: '以后还要检查量子接口', actor: 'human' });
    db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [{ ...item(source.id, '检查量子接口'), itemId: 'check-interface', kind: 'todo', pinned: false }], summary: '留下接口检查待办' });
    db.checkpoint(topic.id, { baseRevision: 1, through: 1, items: [] });
    expect(db.status(topic.id)).toMatchObject({ parkedOpenItems: 1 });
    expect(db.inspect(topic.id, 'parked_check-interface')).toMatchObject({ status: 'parked', sourceRefs: [source.id] });
    expect(db.search(topic.id, '量子接口')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'parked_check-interface' })]));
  });
  it('fences expired jobs and rolls back all partial publication', () => {
    const db = store(), topic = db.topic('t');
    db.ingest('t', { origin: '1', kind: 'message', content: '必须完成' });
    const job = db.claimJob(topic.id, true)!;
    db.db.prepare('UPDATE jobs SET expires=0 WHERE id=?').run(job.id);
    expect(() => db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [], summary: '完成' }, undefined, job)).toThrow('stale-job');
    expect(db.getTopic(topic.id).revision).toBe(0);
    expect(db.activeSummaries(topic.id)).toEqual([]);
  });
  it('shares retrieval allowance across database connections and validates topic bindings', () => {
    const db = store(), topic = db.topic('t'), binding = db.bind(topic.id);
    const second = store(db.root);
    db.boundedResult(binding, [{ text: 'a'.repeat(1200) }]);
    expect(second.boundedResult(binding, [{ text: 'b'.repeat(1200) }]).results).toEqual([]);
    expect(() => second.boundedResult({ ...binding, topic: second.topic('other').id }, [])).toThrow('invalid-run-binding');
    expect(() => second.boundedResult({ ...binding, nonce: 'wrong' }, [])).toThrow('invalid-run-binding');
  });
  it('restricts bound search to the run input fence', () => {
    const db = store(), topic = db.topic('t');
    db.ingest('t', { origin: '1', kind: 'message', content: '旧约束' });
    const binding = db.bind(topic.id);
    db.ingest('t', { origin: '2', kind: 'message', content: '新约束' });
    expect(db.search(topic.id, '新约束', 10, binding.fence)).toEqual([]);
  });
  it('restores a revision without deleting originals or rewinding Hub state', () => {
    const db = store(), topic = db.topic('t');
    db.ingest('t', { origin: '1', kind: 'message', content: '第一轮' });
    db.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [], summary: '第一轮' });
    db.ingest('t', { origin: '2', kind: 'message', content: '第二轮' });
    db.checkpoint(topic.id, { baseRevision: 1, through: 2, items: [], summary: '第二轮' });
    db.rollback(topic.id, 1);
    expect(db.getTopic(topic.id)).toMatchObject({ revision: 3, state_through: 1, next_seq: 3 });
    expect(db.events(topic.id)).toHaveLength(2);
  });
  it('redacts recognisable credentials before indexing or blob storage', () => {
    const db = store();
    const event = db.ingest('t', { origin: '1', kind: 'message', content: 'api_key=private-value github_pat_' + 'a'.repeat(40) });
    expect(event.content).not.toContain('private-value');
    expect(event.content).not.toContain('a'.repeat(40));
  });
  it('makes a consistent backup that opens independently', () => {
    const db = store(), backup = join(root(), 'snapshot.sqlite');
    db.ingest('t', { origin: '1', kind: 'message', content: '备份' });
    db.backup(backup);
    expect(readFileSync(backup).subarray(0, 15).toString()).toBe('SQLite format 3');
  });
});

describe('bounded automatic consolidation', () => {
  it('preserves pinned state automatically without accepting unauthorized model rewrites', async () => {
    const runtime = new WorkerMemoryRuntime(root(), 'worker-a', 'tenant', async () => JSON.stringify({ items: [], summary: '有新的进展，原约束继续有效。' }));
    try {
      const first = runtime.store.ingest('t', { origin: '1', kind: 'message', content: '报告必须两页', actor: 'human' });
      const topic = runtime.store.topic('t');
      runtime.store.checkpoint(topic.id, { baseRevision: 0, through: 1, items: [item(first.id)], summary: '两页' });
      runtime.store.ingest('t', { origin: '2', kind: 'message', content: '开始工作', actor: 'agent' });
      expect(await runtime.maintain(topic.id, true)).toBe(true);
      expect(runtime.store.getTopic(topic.id)).toMatchObject({ state_through: 2, items: [item(first.id)] });
      expect(() => runtime.store.checkpoint(topic.id, { baseRevision: 2, through: 2, items: [], summary: 'drop' })).toThrow('pinned-item-dropped');
    } finally { await runtime.close(); }
  });
  it('backs off repeated failures on the same coverage but resets for new coverage', () => {
    const db = store(), topic = db.topic('t');
    db.ingest('t', { origin: '1', kind: 'message', content: 'must keep' });
    const first = db.claimJob(topic.id, true)!; db.recordFailure(topic.id, 'invalid-model-output', first);
    const a = (db.status(topic.id) as { retryAt: number }).retryAt;
    const second = db.claimJob(topic.id, true)!; db.recordFailure(topic.id, 'invalid-model-output', second);
    const b = (db.status(topic.id) as { retryAt: number }).retryAt;
    expect(b - a).toBeGreaterThan(290000);
    expect(db.claimJob(topic.id)).toBeUndefined();
    db.ingest('t', { origin: '2', kind: 'message', content: 'new user correction', actor: 'human' });
    const third = db.claimJob(topic.id, true)!; db.recordFailure(topic.id, 'invalid-model-output', third);
    expect((db.status(topic.id) as { retryAt: number }).retryAt).toBeLessThan(b);
  });
  it('automatically grounds state and exposes a bounded packet across fresh runs', async () => {
    const runtime = new WorkerMemoryRuntime(root(), 'worker-a', 'tenant', async prompt => {
      const data = JSON.parse(prompt.split('<memory_data>')[1]!.split('</memory_data>')[0]!) as { records: { id: string }[] };
      return JSON.stringify({ items: [item(data.records[0]!.id)], summary: '用户要求报告两页；精确原文可展开。' });
    });
    try {
      runtime.store.ingest('t', { origin: '1', kind: 'message', content: '报告必须两页', actor: 'human' });
      expect(await runtime.maintain(runtime.store.topic('t').id, true)).toBe(true);
      const prepared = await runtime.prepare('t');
      expect(prepared.prompt).toContain('报告必须两页');
      expect(memoryCost(prepared.prompt) + runtime.store.limits.retrieval).toBeLessThanOrEqual(12000);
      expect(prepared.bindingFile).toContain(runtime.store.root);
      expect(await runtime.maintain()).toBe(false);
    } finally { await runtime.close(); }
  });
  it('keeps originals and debt when synthesis is invalid; never substitutes truncation', async () => {
    const runtime = new WorkerMemoryRuntime(root(), 'worker-a', 'tenant', async () => 'not JSON');
    try {
      const event = runtime.store.ingest('t', { origin: '1', kind: 'message', content: '必须保留重要要求', actor: 'human' });
      const topic = runtime.store.topic('t');
      expect(await runtime.maintain(topic.id, true)).toBe(false);
      expect(runtime.store.getTopic(topic.id).state_through).toBe(0);
      expect(runtime.store.inspect(topic.id, event.id)).toMatchObject({ content: '必须保留重要要求' });
      expect(runtime.store.status(topic.id)).toMatchObject({ revision: 0, lastError: expect.any(String) });
    } finally { await runtime.close(); }
  });
  it('refuses to execute with silently omitted unprocessed history', async () => {
    const runtime = new WorkerMemoryRuntime(root(), 'worker-a', 'tenant');
    try {
      runtime.store.ingest('t', { origin: '1', kind: 'message', content: '大量旧要求'.repeat(600) });
      await expect(runtime.prepare('t')).rejects.toThrow('history-needs-maintenance');
      expect(runtime.store.events(runtime.store.topic('t').id).length).toBeGreaterThan(0);
    } finally { await runtime.close(); }
  });
  it('uses source lineage when condensing and retains children for expansion', () => {
    const db = store(), topic = db.topic('t');
    for (let seq = 1; seq <= 4; seq++) {
      db.ingest('t', { origin: String(seq), kind: 'message', content: `阶段${seq}` });
      db.checkpoint(topic.id, { baseRevision: seq - 1, through: seq, items: [], summary: `阶段${seq}完成` });
    }
    const job = db.claimJob(topic.id, true)!;
    expect(job.kind).toBe('condense');
    db.checkpoint(topic.id, { baseRevision: 4, through: 4, items: [], summary: '完成四个阶段，细节可展开' }, undefined, job);
    expect(db.activeSummaries(topic.id)).toHaveLength(1);
    for (const source of job.sources) expect(db.inspect(topic.id, source)).toMatchObject({ depth: 0 });
    expect(db.events(topic.id)).toHaveLength(4);
  });
  it('rejects giant model output and does no work without new inputs', async () => {
    expect(() => parseMemoryCandidate('x'.repeat(33000))).toThrow('model-output-over-budget');
    let calls = 0;
    const runtime = new WorkerMemoryRuntime(root(), 'worker-a', 'tenant', async () => { calls++; return '{}'; });
    try { expect(await runtime.maintain()).toBe(false); expect(calls).toBe(0); }
    finally { await runtime.close(); }
  });
});
