import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { resolveCodexBinary } from '../../../src/agent/codex/binary';

it('refreshes an App binary on every call, skips incomplete updates and respects explicit pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-install-'));
  const install = (hash: string, complete: boolean, at: number) => {
    const dir = join(root, hash); mkdirSync(dir);
    const exe = join(dir, 'codex.exe'); writeFileSync(exe, ''); utimesSync(exe, at, at);
    if (complete) writeFileSync(join(dir, 'codex-code-mode-host.exe'), '');
    return exe;
  };
  try {
    const old = install('aaaa', true, 10);
    install('bbbb', false, 40);
    const options = { platform: 'win32', root };
    expect(resolveCodexBinary(old, options)).toBe(old);
    const updated = install('cccc', true, 20);
    expect(resolveCodexBinary(old, options)).toBe(updated);
    expect(resolveCodexBinary(join(root, '..', 'custom.exe'), options)).toBe(join(root, '..', 'custom.exe'));
    expect(resolveCodexBinary(old, { ...options, platform: 'linux' })).toBe(old);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
