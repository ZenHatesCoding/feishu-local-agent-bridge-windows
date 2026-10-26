import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessAdapter } from '../../../src/agent/deepseek-harness/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('DeepSeek Harness entry compatibility', () => {
  async function run(source: string, memoryMode = false) {
    const dir = await mkdtemp(join(tmpdir(), 'harness-entry-'));
    try {
      const entry = join(dir, 'entry.mjs');
      await writeFile(entry, source);
      const adapter = new DeepSeekHarnessAdapter({ binary: process.execPath, entry });
      const events: AgentEvent[] = [];
      for await (const event of adapter.run({ runId: 'test', prompt: 'PING', cwd: dir, memoryMode }).events) events.push(event);
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
  it('takes only the final JSON text for memory and does not record provider reasoning', async () => {
    const events = await run(`export async function runCli(){if(process.argv[4]!=='--json')throw Error('missing json');console.log(JSON.stringify({type:'thinking',text:'PRIVATE'}));console.log(JSON.stringify({type:'final',text:'{"items":[],"summary":"ok"}'}))}`, true);
    expect(events).toEqual([{ type: 'text', delta: '{"items":[],"summary":"ok"}' }, { type: 'done', terminationReason: 'normal' }]);
    const failed = await run(`export async function runCli(){console.error('dsh: reasoning: PRIVATE');process.exitCode=1}`, true);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    expect(failed.at(-1)).toMatchObject({ type: 'error' });
  });
  it('applies a worker-specific host patch only to maintenance', async () => {
    const previous = process.env.LARK_MEMORY_HARNESS_PATCH;
    process.env.LARK_MEMORY_HARNESS_PATCH = 'memory-only.yml';
    try {
      const events = await run(`export async function runCli(){if(process.argv[4]!=='--patch'||process.argv[5]!=='memory-only.yml'||process.argv[6]!=='--json')throw Error('patch argv');console.log(JSON.stringify({type:'final',text:'OK'}))}`, true);
      expect(events.at(-1)).toMatchObject({ type: 'done' });
      expect((await run(`export async function runCli(){if(process.argv.includes('--patch'))throw Error('business changed');console.log('BUSINESS_OK')}`))[0]).toMatchObject({ type: 'text', delta: 'BUSINESS_OK\n' });
    } finally {
      if (previous === undefined) delete process.env.LARK_MEMORY_HARNESS_PATCH;
      else process.env.LARK_MEMORY_HARNESS_PATCH = previous;
    }
  });
});
