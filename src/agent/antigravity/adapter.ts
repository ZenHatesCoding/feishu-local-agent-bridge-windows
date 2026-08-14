import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { delimiter, dirname, join } from 'node:path';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';

export interface AntigravityAdapterOptions {
  binary: string;
  project?: string;
  model?: string;
  printTimeout?: string;
  dangerouslySkipPermissions?: boolean;
  sandbox?: boolean;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type AntigravityChild = SpawnedProcessByStdio<null, Readable, Readable>;

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: string;
  private readonly project: string | undefined;
  private readonly model: string | undefined;
  private readonly printTimeout: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly sandbox: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: AntigravityAdapterOptions) {
    this.binary = opts.binary;
    this.project = opts.project;
    this.model = opts.model;
    this.printTimeout = opts.printTimeout ?? '10m';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions === true;
    this.sandbox = opts.sandbox === true;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    const entryScript = this.project;
    return checkAgentAvailability({
      agentId: 'antigravity',
      agentName: 'DeepSeek Harness',
      command: this.binary,
      binaryPath: this.binary,
      ...(entryScript ? { args: [entryScript, '--version'] } : {}),
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
    if (!opts.cwd) {
      throw new Error('cwd is required for DeepSeek Harness');
    }

    if (!this.project) {
      throw new Error('DeepSeek Harness CLI entry script is required');
    }

    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const args = [
      this.project,
      '--profile',
      'headless',
      prompt,
    ];

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE: '1',
        DSH_CWD: opts.cwd,
        PATH: antigravityPath(this.larkChannel, process.env.PATH),
        HERMES_HOME: undefined,
        HERMES_GIT_BASH_PATH: undefined,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as AntigravityChild;

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (err) => {
      runtimeError = err;
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

function antigravityPath(
  context: LarkChannelEnvContext | undefined,
  basePath: string | undefined,
): string | undefined {
  if (!context?.rootDir) return basePath;
  return [join(dirname(context.rootDir), 'bin'), basePath].filter(Boolean).join(delimiter);
}

async function* createEventStream(
  child: AntigravityChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn DeepSeek Harness: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
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

  const exitCode = await waitForExitCode(child);
  const runtimeError = getError();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (exitCode !== 0 && exitCode !== null) {
    const detail = stderr ? `: ${truncateForReply(stderr)}` : '';
    yield {
      type: 'error',
      message: `DeepSeek Harness exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (runtimeError) {
    yield {
      type: 'error',
      message: `DeepSeek Harness runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (text.trim().length === 0 && stderr.length > 0) {
    yield {
      type: 'error',
      message: `DeepSeek Harness produced no reply. stderr: ${truncateForReply(stderr)}`,
      terminationReason: 'failed',
    };
    return;
  }
  yield { type: 'done', terminationReason: 'normal' };
}

async function waitForExitCode(child: AntigravityChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function truncateForReply(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}
