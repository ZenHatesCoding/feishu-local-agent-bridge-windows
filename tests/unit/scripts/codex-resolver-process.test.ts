import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it.skipIf(process.platform !== 'win32')('refreshes only the requested worker/profile and preserves explicit installations', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex resolver ')));
  try {
    const search = join(dir, 'bin'); mkdirSync(search);
    for (const [name, complete, at] of [['old', false, 1], ['new', true, 2]] as const) {
      const folder = join(search, name); mkdirSync(folder); const exe = join(folder, 'codex.exe'); writeFileSync(exe, ''); utimesSync(exe, at, at);
      if (complete) writeFileSync(join(folder, 'codex-code-mode-host.exe'), '');
    }
    const old = join(search, 'old/codex.exe'), updated = join(search, 'new/codex.exe');
    const config = join(dir, 'config.json'), pilot = join(dir, 'pilot.json');
    writeFileSync(config, JSON.stringify({ profiles: { codex: { codex: { binaryPath: 'world-pin' } }, engineer: { codex: { binaryPath: old } } } }));
    const agent = (id: string, value: string) => ({ id, launch: { environment: { LARK_CHANNEL_CODEX_BIN: value } } });
    writeFileSync(pilot, JSON.stringify({ agents: [agent('world', 'world-pin'), agent('engineer', old)] }));
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/collab-pilot/Resolve-CodexBinary.ps1'), '-SearchRoot', search, '-ConfigJson', config, '-PilotConfig', pilot, '-AgentId', 'engineer', '-ProfileName', 'engineer', '-Quiet'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const result = run();
    expect(result.stdout.trim(), result.stderr).toBe(updated);
    expect(JSON.parse(readFileSync(config, 'utf8')).profiles).toEqual({ codex: { codex: { binaryPath: 'world-pin' } }, engineer: { codex: { binaryPath: updated } } });
    expect(JSON.parse(readFileSync(pilot, 'utf8')).agents.map((a: ReturnType<typeof agent>) => a.launch.environment.LARK_CHANNEL_CODEX_BIN)).toEqual(['world-pin', updated]);
    const pin = join(dir, 'custom.exe'); writeFileSync(pilot, JSON.stringify({ agents: [agent('engineer', pin)] }));
    expect(run().stdout.trim()).toBe(pin);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
