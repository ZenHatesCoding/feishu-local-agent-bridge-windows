import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessAdapter } from '../../../src/agent/deepseek-harness/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('DeepSeek Harness entry compatibility', () => {
  async function run(source: string) {
    const dir = await mkdtemp(join(tmpdir(), 'harness-entry-'));
    try {
      const entry = join(dir, 'entry.mjs');
      await writeFile(entry, source);
      const adapter = new DeepSeekHarnessAdapter({ binary: process.execPath, entry });
      const events: AgentEvent[] = [];
      for await (const event of adapter.run({ runId: 'test', prompt: 'PING', cwd: dir }).events) events.push(event);
      return events;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('calls exported runCli when import.meta.main prevents auto-start', async () => {
    const events = await run("export async function runCli(){if(process.argv[2]!=='--profile'||process.argv[3]!=='headless')throw Error('argv');console.log('HARNESS_OK')} if(import.meta.main)await runCli();");
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', delta: 'HARNESS_OK\n' }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });

  it('preserves legacy self-starting entries', async () => {
    expect((await run("console.log('LEGACY_OK')"))[0]).toMatchObject({ type: 'text', delta: 'LEGACY_OK\n' });
  });

  it('rejects a silent successful exit', async () => {
    expect((await run('export const unused = true;')).at(-1)).toMatchObject({ type: 'error', message: 'DeepSeek Harness produced no reply.' });
  });

  it('reports entry failures instead of completing silently', async () => {
    expect((await run("export async function runCli(){throw Error('ENTRY_FAILED')}" )).at(-1)).toMatchObject({ type: 'error' });
  });
});
