import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it.skipIf(process.platform !== 'win32')('bounds hung repairs, preserves registered descendants, and reports real exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair contract '));
  const quote = (s: string) => s.replaceAll("'", "''");
  const table = join(dir, 'pids.json');
  writeFileSync(table, '{}');
  writeFileSync(join(dir, 'ok.ps1'), 'exit 0');
  writeFileSync(join(dir, 'bad.ps1'), 'exit 7');
  writeFileSync(join(dir, 'hang.ps1'), `$bot = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30')\n@{bot=$bot.Id} | ConvertTo-Json | Set-Content -LiteralPath '${quote(table)}'\nStart-Sleep -Seconds 30`);
  const script = `
$ErrorActionPreference='Stop'
. '${quote(resolve('scripts/collab-pilot/Repair.Common.ps1'))}'
function Read-CollabPidTable { $j=Get-Content -Raw -LiteralPath '${quote(table)}'|ConvertFrom-Json; $t=@{};foreach($p in $j.PSObject.Properties){$t[$p.Name]=$p.Value};return $t }
try {
  Invoke-CollabRepairStep -Name ok -ScriptPath '${quote(join(dir, 'ok.ps1'))}' -TimeoutSeconds 3
  try { Invoke-CollabRepairStep -Name bad -ScriptPath '${quote(join(dir, 'bad.ps1'))}' -TimeoutSeconds 3; throw 'bad exit ignored' }
  catch { if($_.Exception.Message -notmatch 'exited with code 7'){throw} }
  try { Invoke-CollabRepairStep -Name hang -ScriptPath '${quote(join(dir, 'hang.ps1'))}' -TimeoutSeconds 2; throw 'timeout ignored' }
  catch { if($_.Exception.Message -notmatch 'timed out'){throw} }
  $botId=(Read-CollabPidTable)['bot'];if(!$botId -or !(Get-Process -Id $botId -ErrorAction SilentlyContinue)){throw 'registered bot was killed'}
  Write-Output 'REPAIR_CONTRACT_OK'
} finally { $botId=(Read-CollabPidTable)['bot'];if($botId){Stop-Process -Id $botId -Force -ErrorAction SilentlyContinue} }
`;
  const file = join(dir, 'test.ps1'); writeFileSync(file, script);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(result.stdout + result.stderr).toContain('REPAIR_CONTRACT_OK');
    expect(result.status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
