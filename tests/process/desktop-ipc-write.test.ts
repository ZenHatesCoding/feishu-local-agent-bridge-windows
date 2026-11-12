import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { publishAtomicJson } from '../../src/platform/atomic-json';
import { writeFileAtomic, renameFileWithRetry } from '../../src/platform/atomic-write';

const core = createRequire(import.meta.url)(resolve('adapters/antigravity-desktop/core.cjs'));
describe.skipIf(process.platform !== 'win32')('desktop IPC Windows replacement contention', () => {
  it.each([
    ['bridge', publishAtomicJson], ['Sidecar/Hook', core.save],
    ['shared state', (file: string, data: unknown) => writeFileAtomic(file, JSON.stringify(data))],
    ['media/artifact publication', async (file: string, data: unknown) => { const temp = file + '.pending'; writeFileSync(temp, JSON.stringify(data)); await renameFileWithRetry(temp, file); }],
  ] as const)('retries %s publication while a real Windows reader denies delete sharing', async (_name, save) => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-ipc-lock-')), file = join(dir, 'lease.json');
    writeFileSync(file, JSON.stringify({ at: 1 }));
    const script = `$s=[IO.File]::Open('${file.replace(/'/g, "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); Start-Sleep -Milliseconds 300 } finally { $s.Dispose() }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw Error('lock process exited before ready'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('lock readiness timeout')), 5000); timer.unref(); })]);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: 1 });
      const started = Date.now();
      await save(file, { at: 2 });
      expect(Date.now() - started).toBeGreaterThan(100);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: 2 });
      expect(readdirSync(dir)).toEqual(['lease.json']);
    } finally { child.kill(); await exited; rmSync(dir, { recursive: true, force: true }); }
  }, 10000);
});
