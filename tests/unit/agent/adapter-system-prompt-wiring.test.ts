import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { AntigravityAdapter } from '../../../src/agent/antigravity/adapter';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { DeepSeekHarnessAdapter } from '../../../src/agent/deepseek-harness/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

describe('AntigravityAdapter system prompt wiring', () => {
  it('sends a long prompt through stream-json stdin instead of process argv', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ binary: 'agy' });
    const prompt = 'long prompt '.repeat(4_000);

    adapter.run({ runId: 'r1', prompt, cwd: '/tmp' });

    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args).toContain('stream-json');
    expect(args).not.toContain(expect.stringContaining('long prompt'));
    const input = JSON.parse((await readAll(child.stdin)).trim()) as {
      event: string;
      message: { role: string; content: string };
    };
    expect(input.event).toBe('user');
    expect(input.message.role).toBe('user');
    expect(input.message.content).toBe(prefixBridgeSystemPrompt(prompt, undefined));
  });
});

describe('DeepSeekHarnessAdapter system prompt wiring', () => {
  it('keeps the independent Harness entry and sends a long prompt through stdin', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new DeepSeekHarnessAdapter({
      binary: 'node',
      entry: 'C:/deepseek-harness/dist/cli.js',
    });
    const prompt = 'long prompt '.repeat(4_000);

    adapter.run({ runId: 'r1', prompt, cwd: '/tmp' });

    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('-e');
    expect(args.at(-1)).toBe('C:/deepseek-harness/dist/cli.js');
    expect(args).not.toContain(expect.stringContaining('long prompt'));
    expect(await readAll(child.stdin)).toBe(prefixBridgeSystemPrompt(prompt, undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
