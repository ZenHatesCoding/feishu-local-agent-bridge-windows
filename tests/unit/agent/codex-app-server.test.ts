import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../../src/platform/spawn', () => ({ spawnProcess: mock.spawn }));
import { startCodexAppServer } from '../../../src/agent/codex/app-server';

describe('Codex native live input', () => {
  it('steers the existing turn, resets old visible output and finishes once', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null, signalCode: null });
    mock.spawn.mockReturnValue(child);
    const requests: any[] = [];
    child.stdin.on('data', chunk => {
      const e = JSON.parse(chunk.toString()); requests.push(e);
      const response = e.method === 'thread/start' ? { thread: { id: 'thread-1' } } : e.method === 'turn/start' ? { turn: { id: 'turn-1' } } : e.method === 'turn/steer' ? { turnId: 'turn-1' } : {};
      if (e.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: e.id, result: response }) + '\n'));
    });
    const run = startCodexAppServer('codex', { runId: 'one', cwd: '/workspace', prompt: 'OLD' }, {}, true);
    await run.steer!('NEW');
    expect(requests.filter(e => e.method === 'turn/start')).toHaveLength(1);
    expect(requests.find(e => e.method === 'turn/steer').params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ text: 'NEW' }] });
    child.stdout.write(JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'NEW' } } }) + '\n');
    child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) + '\n');
    const events = []; for await (const event of run.events) events.push(event);
    expect(events).toContainEqual({ type: 'input_updated' });
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    await expect(run.steer!('LATE')).rejects.toThrow('ended');
  });
});
