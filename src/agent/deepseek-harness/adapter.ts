import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { harnessLiveAssets } from './live';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';

export interface DeepSeekHarnessAdapterOptions {
  binary: string;
  entry: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type HarnessChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const STDIN_BOOTSTRAP = [
  "const{pathToFileURL}=require('node:url')",
  "let s=''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data',c=>s+=c)",
  "process.stdin.on('end',async()=>{try{const e=process.argv[1];const memory=process.env.LARK_MEMORY_MAINTENANCE==='1';process.argv=[process.execPath,e,'--profile','headless',...(memory&&process.env.LARK_MEMORY_HARNESS_PATCH?['--patch',process.env.LARK_MEMORY_HARNESS_PATCH]:[]),...(memory?['--json']:[]),s];const m=await import(pathToFileURL(e).href);if(typeof m.runCli==='function')await m.runCli()}catch(e){console.error(e);process.exitCode=1}})",
].join(';');

export class DeepSeekHarnessAdapter implements AgentAdapter {
  readonly id = 'deepseek-harness';
  readonly displayName = 'DeepSeek Harness';
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(private readonly opts: DeepSeekHarnessAdapterOptions) {
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'deepseek-harness',
      agentName: this.displayName,
      command: this.opts.binary,
      binaryPath: this.opts.binary,
      args: [this.opts.entry, '--version'],
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'DeepSeek Harness binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for DeepSeekHarnessAdapter.run');
    const prompt = opts.memoryMode ? opts.prompt : prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const live = opts.memoryMode ? undefined : harnessLiveAssets();
    const child = spawnProcess(this.opts.binary, ['-e', live?.bootstrap ?? STDIN_BOOTSTRAP, this.opts.entry, ...(live ? [live.patch] : [])], {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.opts.larkChannel),
        ...opts.env,
        LARK_MEMORY_MAINTENANCE: opts.memoryMode ? '1' : undefined,
        LARK_CHANNEL_ANTIGRAVITY_BRIDGE: undefined,
        LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE: opts.memoryMode ? undefined : '1',
        DSH_CWD: opts.cwd,
        PATH: harnessPath(process.env.PATH),
        HERMES_HOME: undefined,
        HERMES_GIT_BASH_PATH: undefined,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as HarnessChild;
    if (live) child.stdin.write(JSON.stringify({ prompt }) + '\n');
    else child.stdin.end(prompt);

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrLines.on('line', line => {
      if (line.includes('LARK_LIVE ')) {
        try { const ack = JSON.parse(line.slice(line.lastIndexOf('LARK_LIVE ') + 10)); const p = pending.get(ack.id); if (p) { clearTimeout(p.timer); pending.delete(ack.id); ack.error ? p.reject(Error(ack.error)) : p.resolve(); } } catch { /* Not a control frame. */ }
      } else stderrChunks.push(Buffer.from(line + '\n'));
    });
    child.stdin.on('error', () => {});
    child.once('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Harness exited')); } pending.clear(); if (live) rmSync(live.root, { recursive: true, force: true }); });
    child.on('error', (err) => { runtimeError = err; });
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: harnessEvents(child, stderrChunks, () => runtimeError, opts.memoryMode === true),
      ...(live ? { steer: (text: string): Promise<void> => new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { reject(Error('Harness turn has ended')); return; }
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Harness input acknowledgement timed out')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, text }) + '\n');
      }) } : {}),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolve();
          }, stopGraceMs);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
          const onExit = (): void => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

function harnessPath(basePath: string | undefined): string | undefined {
  const proxy = process.env.LARK_COLLAB_COMMAND_DIR;
  return [proxy, basePath].filter(Boolean).join(delimiter);
}

async function* harnessEvents(
  child: HarnessChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  memoryMode = false,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield { type: 'error', message: err ? `failed to spawn DeepSeek Harness: ${err.message}` : 'spawn returned no pid', terminationReason: 'failed' };
    return;
  }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let text = '';
  try {
    for await (const line of rl) {
      if (memoryMode) {
        let event: { type?: string; text?: string; phase?: string; reason?: { kind?: string; error?: { code?: string } } };
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'final' && typeof event.text === 'string') text = event.text;
        if (event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'error') {
          child.kill();
          yield { type: 'error', message: `DeepSeek Harness maintenance failed (${event.reason.error?.code ?? 'provider-error'})`, terminationReason: 'failed' };
          return;
        }
        continue; // Never export thinking or tools into memory/error records.
      }
      const delta = `${line}\n`;
      text += delta;
      yield { type: 'text', delta };
    }
  } finally {
    rl.close();
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (exitCode !== 0 && exitCode !== null) {
    yield { type: 'error', message: `DeepSeek Harness exited with code ${exitCode}${!memoryMode && stderr ? `: ${stderr.slice(0, 1000)}` : ''}`, terminationReason: 'failed' };
    return;
  }
  const runtimeError = getError();
  if (runtimeError) {
    yield { type: 'error', message: `DeepSeek Harness runtime error: ${runtimeError.message}`, terminationReason: 'failed' };
    return;
  }
  if (!text.trim()) {
    yield { type: 'error', message: `DeepSeek Harness produced no reply.${!memoryMode && stderr ? ` stderr: ${stderr.slice(0, 1000)}` : ''}`, terminationReason: 'failed' };
    return;
  }
  if (memoryMode) yield { type: 'text', delta: text };
  yield { type: 'done', terminationReason: 'normal' };
}
