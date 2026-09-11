import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LedgerRecord } from './types';

export class JsonlLedger {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async readAll(): Promise<LedgerRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split(/\r?\n/);
    const records: LedgerRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as LedgerRecord | LedgerRecord[];
        records.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch (err) {
        const isLastNonEmpty = lines.slice(index + 1).every((candidate) => !candidate?.trim());
        if (isLastNonEmpty) break;
        throw new Error(`invalid collaboration ledger at line ${index + 1}`, { cause: err });
      }
    }
    return records;
  }

  append(records: LedgerRecord[]): Promise<void> {
    const operation = this.tail.then(async () => {
      if (records.length === 0) return;
      await mkdir(dirname(this.path), { recursive: true });
      // One submit/ack is one JSONL line. A torn final write is discarded as a
      // whole transaction during replay, so projections never observe half a route.
      const payload = `${JSON.stringify(records)}\n`;
      await appendFile(this.path, payload, { encoding: 'utf8', mode: 0o600, flush: true });
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
