import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { delimiter } from 'node:path';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
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
  "process.stdin.on('end',async()=>{const e=process.argv[1];process.argv=[process.execPath,e,'--profile','headless',s];await import(pathToFileURL(e).href)})",
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
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const child = spawnProcess(this.opts.binary, ['-e', STDIN_BOOTSTRAP, this.opts.entry], {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.opts.larkChannel),
        ...opts.env,
        LARK_CHANNEL_ANTIGRAVITY_BRIDGE: undefined,
        LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE: '1',
        DSH_CWD: opts.cwd,
        PATH: harnessPath(process.env.PATH),
        HERMES_HOME: undefined,
        HERMES_GIT_BASH_PATH: undefined,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as HarnessChild;
    child.stdin.end(prompt);

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => { runtimeError = err; });
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: harnessEvents(child, stderrChunks, () => runtimeError),
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
    yield { type: 'error', message: `DeepSeek Harness exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 1000)}` : ''}`, terminationReason: 'failed' };
    return;
  }
  const runtimeError = getError();
  if (runtimeError) {
    yield { type: 'error', message: `DeepSeek Harness runtime error: ${runtimeError.message}`, terminationReason: 'failed' };
    return;
  }
  if (!text.trim() && stderr) {
    yield { type: 'error', message: `DeepSeek Harness produced no reply. stderr: ${stderr.slice(0, 1000)}`, terminationReason: 'failed' };
    return;
  }
  yield { type: 'done', terminationReason: 'normal' };
}
