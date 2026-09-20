import { resolveAppPaths } from '../../config/app-paths';
import { LocalTopicLedger } from '../../collab/local-topic-ledger';

export async function runLocalContext(input: {
  scope: string;
  query?: string;
  limit?: string;
}): Promise<void> {
  const ledger = new LocalTopicLedger(process.env.LARK_COLLAB_NODE_LEDGER_ROOT ?? resolveAppPaths().rootDir);
  const parsedLimit = input.limit ? Number(input.limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  const records = await ledger.query(input.scope, input.query, parsedLimit);
  process.stdout.write(`${JSON.stringify({ scope: input.scope, records }, null, 2)}\n`);
}
