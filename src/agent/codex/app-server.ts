import { createInterface } from 'node:readline';
import { spawnProcess } from '../../platform/spawn';
import type { AgentRun, AgentRunOptions } from '../types';
import { LiveEvents } from '../live-events';

export function startCodexAppServer(binary: string, opts: AgentRunOptions, env: NodeJS.ProcessEnv, ignoreRules: boolean): AgentRun {
  const child = spawnProcess(binary, ['app-server', '-c', 'shell_environment_policy.inherit="all"', '-c', `shell_environment_policy.set.CODEX_CLI_PATH=${JSON.stringify(binary)}`], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new LiveEvents();
  let serial = 0, ended = false, threadId = '', turnId = '';
  const requests = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (ended) { reject(Error('Native turn has ended')); return; }
    const id = ++serial;
    const timer = setTimeout(() => { requests.delete(id); reject(Error(`Codex ${method} acknowledgement timed out`)); }, 15000);
    requests.set(id, { resolve, reject, timer });
    child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const fail = (message: string): void => { events.push({ type: 'error', message, terminationReason: 'failed' }); };
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  lines.on('line', line => {
    let e: any; try { e = JSON.parse(line); } catch { return; }
    if (requests.has(e.id)) {
      const request = requests.get(e.id)!; requests.delete(e.id); clearTimeout(request.timer);
      e.error ? request.reject(Error(e.error.message ?? 'Codex RPC rejected')) : request.resolve(e.result);
      return;
    }
    const p = e.params;
    if (typeof e.method === 'string' && (e.method.endsWith('/delta') || e.method === 'turn/started')) events.push({ type: 'activity' });
    if (e.method === 'turn/started') turnId = p.turn.id;
    if (e.method === 'item/started') {
      events.push({ type: 'activity' });
      if (p.item.type === 'commandExecution') events.push({ type: 'tool_use', id: p.item.id, name: 'shell', input: { command: p.item.command } });
    }
    if (e.method === 'item/completed') {
      if (p.item.type === 'agentMessage') events.push({ type: 'text', delta: p.item.text });
      else if (p.item.type === 'commandExecution') events.push({ type: 'tool_result', id: p.item.id, output: p.item.aggregatedOutput ?? '', isError: p.item.exitCode !== 0 });
    }
    if (e.method === 'turn/completed') {
      ended = true;
      if (p.turn.status === 'failed') fail(p.turn.error?.message ?? 'Codex turn failed');
      else events.push({ type: 'done', threadId, terminationReason: p.turn.status === 'interrupted' ? 'interrupted' : 'normal' });
      child.stdin!.end(); child.kill();
    }
    if (e.method === 'error' && !p?.willRetry) fail(p?.error?.message ?? 'Codex app-server error');
  });
  child.stderr!.resume();
  child.on('error', error => fail(error.message));
  child.stdin!.on('error', () => {});
  child.on('close', () => {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(Error('Codex connection closed')); }
    requests.clear();
    if (!ended) fail('Codex app-server exited before the turn completed');
    ended = true; lines.close();
  });
  const ready = (async () => {
    await rpc('initialize', { clientInfo: { name: 'feishu-agent-bridge', version: '1' } });
    child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const thread = await rpc(opts.threadId ? 'thread/resume' : 'thread/start', {
      ...(opts.threadId ? { threadId: opts.threadId } : {}), cwd: opts.cwd, model: opts.model,
      approvalPolicy: 'never', sandbox: opts.sandbox ?? 'danger-full-access',
      ...(ignoreRules ? { config: { project_doc_max_bytes: 0 } } : {}),
    });
    threadId = thread.thread.id;
    events.push({ type: 'system', threadId, cwd: opts.cwd });
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt }, ...(opts.images ?? []).map(path => ({ type: 'localImage', path }))] });
    turnId = turn.turn.id;
  })();
  void ready.catch(error => { fail(error.message); child.kill(); });
  return {
    runId: opts.runId, events: events.read(),
    async steer(text) { await ready; await rpc('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] }); events.push({ type: 'input_updated' }); },
    async stop() { if (!ended && threadId && turnId) await rpc('turn/interrupt', { threadId, turnId }).catch(() => {}); child.kill(); },
    async waitForExit(timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return new Promise<boolean>(resolve => {
        const onExit = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
        child.once('exit', onExit);
      });
    },
  };
}
