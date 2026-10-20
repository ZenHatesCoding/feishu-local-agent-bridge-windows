import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { MemoryStore } from '../../memory/store';
import { readMemoryBinding, WorkerMemoryRuntime } from '../../memory/runtime';
import { memoryCost, memoryError, type MemoryBinding, type MemoryCandidate } from '../../memory/types';
import { hermesMemorySynthesizer } from '../../memory/hermes';
import { createMemorySynthesizer, type MemorySynthesizer } from '../../memory/runtime';

export interface MemoryCommandOptions {
  root?: string; owner?: string; tenant?: string; scope?: string; query?: string; id?: string;
  file?: string; after?: string; limit?: string; offset?: string; revision?: string; confirmedOwner?: boolean; binding?: string;
}
export async function runMemoryCommand(mode: string, opts: MemoryCommandOptions): Promise<void> {
  if (process.env.LARK_MEMORY_BINDING && opts.binding && process.env.LARK_MEMORY_BINDING !== opts.binding) memoryError('bound-scope-override');
  const bindingPath = process.env.LARK_MEMORY_BINDING ?? opts.binding;
  const bound = bindingPath ? readMemoryBinding(bindingPath) : undefined;
  if (bound && (opts.root || opts.owner || opts.tenant || opts.scope)) memoryError('bound-scope-override');
  const root = bound?.root ?? opts.root ?? process.env.LARK_MEMORY_ROOT ?? resolveAppPaths({ profile: process.env.LARK_CHANNEL_PROFILE }).profileDir + '/memory';
  const owner = bound?.owner ?? opts.owner ?? process.env.LARK_COLLAB_AGENT_ID ?? process.env.LARK_CHANNEL_PROFILE ?? 'standalone';
  const tenant = bound?.tenant ?? opts.tenant ?? process.env.LARK_COLLAB_TENANT_KEY ?? 'standalone';
  const store = new MemoryStore(root, owner, tenant);
  let binding: MemoryBinding | undefined = bound?.binding;
  try {
    if (binding) store.validateBinding(binding);
    if (mode === 'migrate') {
      if (binding || !opts.file) memoryError('unbound-migrate-file-required');
      output(await importLegacyMemory(store, opts.file, opts.confirmedOwner === true)); return;
    }
    if (mode === 'backup') {
      if (binding || !opts.file) memoryError('unbound-backup-file-required');
      store.backup(resolve(opts.file)); output({ backedUp: true }); return;
    }
    const topic = binding ? store.getTopic(binding.topic) : opts.scope ? store.topic(opts.scope) : undefined;
    if (mode === 'status' || mode === 'doctor') {
      output(topic ? store.status(topic.id) : store.topics().map(value => store.status(value.id))); return;
    }
    if (!topic) memoryError('scope-required');
    if (mode === 'prepare' || mode === 'maintain') {
      if (binding) memoryError('cannot-rebind');
      // Hermes calls the same local implementation; never a Hub request.
      store.close();
      const runtime = new WorkerMemoryRuntime(root, owner, tenant, await commandSynthesizer());
      try {
        if (mode === 'maintain') { output({ maintained: await runtime.maintain(topic.id, true) }); return; }
        const prepared = await runtime.prepare(topic.scope); output({ prompt: prepared.prompt, env: prepared.env, bindingFile: prepared.bindingFile });
      }
      finally { await runtime.close(); }
      return;
    }
    if (mode === 'observe') {
      if (binding || !opts.file) memoryError('unbound-observe-file-required');
      const event = JSON.parse(readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '')) as Parameters<MemoryStore['ingest']>[1];
      output(store.ingest(topic.scope, event)); return;
    }
    if (mode === 'checkpoint') {
      if (!binding || !opts.file) memoryError('bound-checkpoint-file-required');
      const candidate = JSON.parse(readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, '')) as MemoryCandidate;
      output({ status: 'accepted', ...store.checkpoint(topic.id, candidate, binding) }); return;
    }
    if (mode === 'rollback') {
      if (binding || !opts.revision) memoryError('unbound-revision-required');
      store.rollback(topic.id, integer(opts.revision, 1)); output(store.status(topic.id)); return;
    }
    if (mode === 'export') {
      if (binding || !opts.file) memoryError('unbound-export-file-required');
      writeFileSync(opts.file, '', { flag: 'wx', mode: 0o600 });
      const { appendFileSync } = await import('node:fs');
      let after = 0;
      for (;;) { const events = store.events(topic.id, after, 200); if (!events.length) break; appendFileSync(opts.file, events.map(event => JSON.stringify(event)).join('\n') + '\n'); after = events.at(-1)!.seq; }
      output({ exported: true, through: after }); return;
    }
    let values: unknown[];
    if (mode === 'read') {
      if (binding && topic.state_through > binding.fence) memoryError('state-after-input-fence');
      values = [{ revision: topic.revision, through: topic.state_through }, ...topic.items, ...store.events(topic.id, integer(opts.after, topic.state_through), integer(opts.limit, 12), binding?.fence).map(event => ({ id: event.id, seq: event.seq, kind: event.kind, actor: event.actor, at: event.at, preview: event.content.slice(0, 160), sourceBytes: memoryCost(event.content) }))];
    } else if (mode === 'search') {
      if (!opts.query?.trim()) memoryError('query-required');
      values = store.search(topic.id, opts.query, integer(opts.limit, 10), binding?.fence);
    } else if (mode === 'inspect' || mode === 'expand') {
      if (!opts.id) memoryError('id-required');
      const source = store.inspect(topic.id, opts.id) as { content?: string; text?: string; sources?: string[]; seq?: number; end_seq?: number };
      if (binding && (source.seq ?? source.end_seq ?? 0) > binding.fence) memoryError('source-after-input-fence');
      const offset = integer(opts.offset, 0);
      const text = source.content ?? source.text ?? '';
      // Page original content by Unicode code points, preserving source and cursor.
      const characters = Array.from(text);
      const slice = characters.slice(offset, offset + 320).join('');
      values = [{ ...source, content: undefined, text: slice, offset, nextOffset: offset + 320 < characters.length ? offset + 320 : null }];
    } else memoryError('unknown-command');
    if (binding) output(store.boundedResult(binding, values));
    else {
      let budget = 8000;
      output({ results: values.filter(value => { budget -= memoryCost(value) + 8; return budget >= 0; }), cursor: opts.after ?? 0 });
    }
  } finally {
    try { store.close(); } catch { /* prepare already closed its first connection. */ }
  }
}
async function commandSynthesizer(): Promise<MemorySynthesizer | undefined> {
  const hermes = hermesMemorySynthesizer();
  if (hermes) return hermes;
  const profile = process.env.LARK_CHANNEL_PROFILE;
  if (!profile) return undefined;
  const { loadRootConfig } = await import('../../config/profile-store');
  const { createRuntimeAgent } = await import('./start');
  const paths = resolveAppPaths({ profile });
  const config = await loadRootConfig(paths.configFile);
  const settings = config?.profiles[profile];
  if (!settings) return undefined;
  return createMemorySynthesizer(createRuntimeAgent(settings, paths));
}
function output(value: unknown): void { process.stdout.write(JSON.stringify(value) + '\n'); }
function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) memoryError('invalid-number');
  return result;
}
export async function importLegacyMemory(store: MemoryStore, path: string, confirmedOwner: boolean): Promise<{ imported: number; unknown: number }> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let imported = 0, unknown = 0, line = 0;
  for await (const text of lines) {
    line++;
    try {
      const record = JSON.parse(text.replace(/^\uFEFF/, '')) as { id?: string; scope?: string; kind?: string; content?: string; recordedAt?: string; authorAgentId?: string; actor?: string; senderId?: string };
      if (!record.scope || !record.id) continue;
      if (record.authorAgentId !== store.owner && !confirmedOwner) { unknown++; continue; }
      store.ingest(record.scope, { origin: `legacy:${record.id}`, kind: record.kind ?? 'message', content: record.content ?? JSON.stringify(record), actor: record.kind === 'bot-result' ? 'agent' : 'unknown', at: record.recordedAt });
      imported++;
    } catch (error) { if (error instanceof SyntaxError) { unknown++; continue; } throw error; }
  }
  store.db.prepare('INSERT OR REPLACE INTO imports(path,offset,unknown_count) VALUES(?,?,?)').run(resolve(path), line, unknown);
  return { imported, unknown };
}
