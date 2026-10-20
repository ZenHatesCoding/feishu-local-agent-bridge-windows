import { resolveAppPaths } from '../../config/app-paths';
import { LocalTopicLedger } from '../../collab/local-topic-ledger';

export async function runLocalContext(input: {
  scope: string;
  query?: string;
  limit?: string;
}): Promise<void> {
  if (process.env.LARK_MEMORY_BINDING) {
    const { runMemoryCommand } = await import('./memory');
    const { readMemoryBinding } = await import('../../memory/runtime');
    const { MemoryStore } = await import('../../memory/store');
    const bound = readMemoryBinding(process.env.LARK_MEMORY_BINDING);
    const store = new MemoryStore(bound.root, bound.owner, bound.tenant);
    try { store.validateBinding(bound.binding); if (store.getTopic(bound.binding.topic).scope !== input.scope) throw new Error('memory:bound-scope-override'); }
    finally { store.close(); }
    await runMemoryCommand(input.query ? 'search' : 'read', { query: input.query, limit: input.limit });
    return;
  }
  const ledger = new LocalTopicLedger(process.env.LARK_COLLAB_NODE_LEDGER_ROOT ?? resolveAppPaths().rootDir);
  const parsedLimit = input.limit ? Number(input.limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  const records = await ledger.query(input.scope, input.query, parsedLimit);
  process.stdout.write(`${JSON.stringify({ scope: input.scope, records }, null, 2)}\n`);
}
