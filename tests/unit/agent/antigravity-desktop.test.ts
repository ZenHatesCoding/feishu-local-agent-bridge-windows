import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { AntigravityDesktopAdapter } from '../../../src/agent/antigravity/desktop';
const core = createRequire(import.meta.url)(resolve('adapters/antigravity-desktop/core.cjs'));
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'desktop-contract-')); roots.push(dir); return dir; };
function ready(dir: string) { writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: Date.now(), transport: 'antigravity-app' })); }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('Antigravity App transport', () => {
  it('stops an orphan Sidecar before publishing heartbeat or claiming jobs', () => {
    let tick: () => void = () => {};
    const save = vi.fn();
    const jobs = vi.fn(() => []);
    const exit = vi.fn();
    const kill = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Object.assign(Error('parent exited'), { code: 'ESRCH' }); });
    runInNewContext(readFileSync(resolve('adapters/antigravity-desktop/sidecar.cjs'), 'utf8'), {
      require(name: string) {
        if (name === './core.cjs') return { ...core, save };
        if (name === 'node:fs') return { mkdirSync() {}, readdirSync: jobs };
        return createRequire(import.meta.url)(name);
      },
      process: { env: { LARK_ANTIGRAVITY_DESKTOP_ROOT: '/fixture', ANTIGRAVITY_LS_ADDRESS: 'fixture' }, pid: 123, ppid: 122, kill, exit },
      setInterval(callback: () => void) { tick = callback; },
    });
    tick();
    expect(save).toHaveBeenCalledTimes(1);
    tick();
    expect(kill).toHaveBeenLastCalledWith(122, 0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveBeenCalledTimes(1);
  });
  it('retries Sidecar storage failures without crashing its timer', () => {
    let tick: () => void = () => {};
    const save = vi.fn().mockImplementationOnce(() => { throw Error('disk offline'); }).mockImplementation(() => {});
    runInNewContext(readFileSync(resolve('adapters/antigravity-desktop/sidecar.cjs'), 'utf8'), {
      require(name: string) {
        if (name === './core.cjs') return { ...core, save };
        if (name === 'node:fs') return { mkdirSync() {}, readdirSync() { return []; } };
        return createRequire(import.meta.url)(name);
      },
      process: { env: { LARK_ANTIGRAVITY_DESKTOP_ROOT: '/fixture', ANTIGRAVITY_LS_ADDRESS: 'fixture' }, pid: 123 },
      setInterval(callback: () => void) { tick = callback; },
    });
    expect(() => tick()).not.toThrow();
    expect(() => tick()).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('fences storage failures without throwing from lease timers or cancellation', async () => {
    vi.useFakeTimers();
    const dir = root(); ready(dir);
    const run = new AntigravityDesktopAdapter(dir).run({ runId: 'io-failure', cwd: dir, prompt: 'test' });
    const job = join(dir, 'runs/io-failure');
    const iterator = run.events[Symbol.asyncIterator]();
    rmSync(job, { recursive: true });
    try {
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      expect((await iterator.next()).value).toMatchObject({ type: 'error', terminationReason: 'failed', message: expect.stringContaining('Desktop IPC failed') });
      await expect(run.stop()).resolves.toBeUndefined();
      await iterator.return?.();
    } finally { vi.useRealTimers(); }
  });
  it('reports malformed IPC as a failed run and closes the lease', async () => {
    const dir = root(); ready(dir);
    const run = new AntigravityDesktopAdapter(dir).run({ runId: 'bad-result', cwd: dir, prompt: 'test' });
    writeFileSync(join(dir, 'runs/bad-result/result.json'), '{invalid');
    const events = []; for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(await run.waitForExit(1)).toBe(true);
  });
  it('fails explicitly when the App is offline and never falls back to CLI', async () => {
    const adapter = new AntigravityDesktopAdapter(root());
    expect(await adapter.isAvailable()).toBe(false);
    await expect(adapter.prepareRun()).rejects.toThrow('CLI fallback is disabled');
  });
  it('accepts only lifecycle activity and the final public result', async () => {
    const dir = root(); ready(dir);
    const adapter = new AntigravityDesktopAdapter(dir);
    const run = adapter.run({ runId: 'bound-run', cwd: dir, prompt: 'original request', env: { LARK_MEMORY_BINDING: '/private/binding' } });
    const job = join(dir, 'runs/bound-run');
    expect(JSON.parse(readFileSync(join(job, 'request.json'), 'utf8')).env.LARK_MEMORY_BINDING).toBe('/private/binding');
    writeFileSync(join(job, 'events.jsonl'), '{"type":"thinking","delta":"private"}\n{"type":"activity","summary":"desktop model invocation"}\n');
    writeFileSync(join(job, 'result.json'), JSON.stringify({ type: 'done', text: 'public answer', conversationId: 'session' }));
    const events = []; for await (const event of run.events) events.push(event);
    expect(events).toEqual([{ type: 'activity', summary: 'desktop model invocation' }, { type: 'text', delta: 'public answer' }, { type: 'done', sessionId: 'session', terminationReason: 'normal' }]);
    expect(() => adapter.run({ runId: 'bound-run', cwd: dir, prompt: 'replay' })).toThrow('already exists');
  });
  it('fences late replies after cancellation', async () => {
    const dir = root(); ready(dir);
    const run = new AntigravityDesktopAdapter(dir).run({ runId: 'cancelled', cwd: dir, prompt: 'test' });
    await run.stop();
    writeFileSync(join(dir, 'runs/cancelled/result.json'), JSON.stringify({ type: 'done', text: 'late result' }));
    const events = []; for await (const event of run.events) events.push(event);
    expect(events).toEqual([{ type: 'done', terminationReason: 'interrupted' }]);
    expect(JSON.parse(readFileSync(join(dir, 'runs/cancelled/cancel.json'), 'utf8')).reason).toBe('bridge cancelled');
  });
});
describe('App named hooks', () => {
  it('uses a bounded maintenance tier without overriding the App model for business tasks', () => {
    expect(core.submissionArgs({ runId: 'test', memoryMode: true }, 'data')).toContain('--model=flash_lite');
    expect(core.submissionArgs({ runId: 'test', memoryMode: false }, 'task').some((arg: string) => arg.startsWith('--model='))).toBe(false);
    expect(() => core.submissionArgs({ runId: 'test', memoryMode: true }, 'data', 'invalid')).toThrow();
  });
  it('does not export App authentication or another ambient bot identity to tools', () => {
    expect(core.toolEnvironment({ PATH: 'system-path', ANTIGRAVITY_CSRF_TOKEN: 'app-private', LARK_COLLAB_HUB_TOKEN: 'other-bot' }, { LARK_COLLAB_HUB_TOKEN: 'this-bot' })).toEqual({ PATH: 'system-path', LARK_COLLAB_HUB_TOKEN: 'this-bot' });
  });
  function fixture(memoryMode = false) {
    const dir = root(), id = 'owned-run', conversationId = '12345678-1234-1234-1234-123456789abc';
    const job = join(dir, 'runs', id); mkdirSync(job, { recursive: true });
    core.save(join(job, 'request.json'), { runId: id, nonce: 'nonce', cwd: dir, expires: Date.now() + 60000, memoryMode });
    core.save(join(job, 'lease.json'), { at: Date.now() });
    core.save(join(dir, 'conversations', conversationId + '.json'), { runId: id, nonce: 'nonce' });
    return { dir, job, input: { conversationId, toolCall: { name: 'run_command', args: { CommandLine: 'Write-Output done' } } } };
  }
  it('does not attach credentials or policies to unrelated App conversations', () => {
    expect(core.hook(root(), 'PreToolUse', { conversationId: '12345678-1234-1234-1234-123456789abc' })).toEqual({ decision: 'allow' });
  });
  it('denies tools in memory-only calls and cancelled or completed runs', () => {
    const f = fixture(true);
    expect(core.hook(f.dir, 'PreToolUse', f.input).decision).toBe('deny');
    const g = fixture(); core.save(join(g.job, 'cancel.json'), {});
    expect(core.hook(g.dir, 'PreToolUse', g.input).decision).toBe('deny');
    expect(core.hook(g.dir, 'PostInvocation', g.input)).toEqual({ terminationBehavior: 'terminate' });
    const h = fixture(); core.save(join(h.job, 'result.json'), {});
    expect(core.hook(h.dir, 'PreToolUse', h.input).decision).toBe('deny');
    const q = fixture();
    expect(core.hook(q.dir, 'PreToolUse', { ...q.input, toolCall: { name: 'ask_question', args: {} } }).decision).toBe('deny');
  });
  it('binds native helpers to the same run without publishing a helper as the final result', () => {
    const f = fixture();
    const result = core.hook(f.dir, 'PreToolUse', { ...f.input, toolCall: { name: 'invoke_subagent', args: { Subagents: [{ Prompt: 'Check one image', Role: 'reviewer' }] } } });
    expect(result.overwrite.Subagents[0].Prompt).toContain('FEISHU_DESKTOP_RUN:owned-run:nonce');
    core.save(join(f.job, 'conversation.json'), { conversationId: 'parent-conversation' });
    core.hook(f.dir, 'Stop', { ...f.input, fullyIdle: true, terminationReason: 'model_stop' });
    expect(() => readFileSync(join(f.job, 'result.json'))).toThrow();
  });
  it('terminates abandoned leases and wraps commands without exposing capability values', () => {
    const f = fixture();
    const result = core.hook(f.dir, 'PreToolUse', f.input);
    expect(result.overwrite.CommandLine).toContain('core.cjs');
    expect(result.overwrite.CommandLine).not.toContain('LARK_COLLAB_HUB_TOKEN');
    core.save(join(f.job, 'lease.json'), { at: Date.now() - 30000 });
    expect(core.hook(f.dir, 'PreToolUse', f.input).decision).toBe('deny');
  });
  it('ignores reasoning and waits for background work before publishing a final answer', () => {
    const f = fixture(), transcript = join(f.job, 'transcript.jsonl');
    writeFileSync(transcript, [{ type: 'THINKING', content: 'private reasoning' }, { type: 'PLANNER_RESPONSE', content: 'public answer' }, { type: 'TOOL_RESULT', content: 'private output' }].map(x => JSON.stringify(x)).join('\n'));
    const input = { ...f.input, transcriptPath: transcript, terminationReason: 'model_stop', fullyIdle: false };
    core.hook(f.dir, 'Stop', input);
    expect(() => readFileSync(join(f.job, 'result.json'))).toThrow();
    core.hook(f.dir, 'Stop', { ...input, fullyIdle: true });
    expect(core.json(join(f.job, 'result.json')).text).toBe('public answer');
    const g = fixture();
    core.hook(g.dir, 'Stop', { ...g.input, transcriptPath: transcript, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' });
    expect(core.json(join(g.job, 'result.json')).type).toBe('done');
    const h = fixture();
    core.hook(h.dir, 'Stop', { ...h.input, transcriptPath: transcript, fullyIdle: true, terminationReason: 'MAX_STEPS_EXCEEDED' });
    expect(core.json(join(h.job, 'result.json')).type).toBe('error');
  });
});
