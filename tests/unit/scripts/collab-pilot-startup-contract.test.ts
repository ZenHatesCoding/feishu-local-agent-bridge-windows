import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readPilotScript = (name: string) =>
  readFileSync(join(process.cwd(), 'scripts', 'collab-pilot', name), 'utf8');

describe('Collaboration Pilot Windows startup contract', () => {
  it('keeps a long-lived supervisor alive and repairs missing components', () => {
    const source = readPilotScript('Run-CollabPilotSupervisor.ps1');
    expect(source).toContain('[Threading.Mutex]::new');
    expect(source).toContain('while ($true)');
    expect(source).toContain("'Start-CollabPilot.ps1'");
    expect(source).toContain('Start-Sleep -Seconds $PollSeconds');
  });

  it('loads the HTTP client assembly in a clean Windows PowerShell process', () => {
    const source = readPilotScript('Pilot.Common.ps1');
    expect(source).toContain("'System.Net.Http.HttpClient' -as [type]");
    expect(source).toContain('Add-Type -AssemblyName System.Net.Http');
  });

  it('registers a current-user logon task with restart and unlimited runtime', () => {
    const source = readPilotScript('Install-CollabPilotStartup.ps1');
    expect(source).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(source).toContain('-LogonType Interactive');
    expect(source).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(source).toContain('-RestartCount 3');
    expect(source).toContain('Start-ScheduledTask');
    expect(source).toContain('Timed out stopping existing Windows startup task');
  });
});
