import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readScript = (name: string) =>
  readFileSync(join(process.cwd(), 'scripts', name), 'utf8');

describe('Antigravity proxy startup contract', () => {
  it('lets agent-specific environment restore values removed by the pilot', () => {
    const source = readScript('collab-pilot/run-agent.ps1');
    const globalUnset = source.indexOf('foreach ($name in @($pilot.unsetEnvironment))');
    const agentEnvironment = source.indexOf('Set-CollabEnvironment $agentConfig.launch.environment');
    const agentUnset = source.indexOf('foreach ($name in @($agentConfig.launch.unsetEnvironment))');

    expect(globalUnset).toBeGreaterThanOrEqual(0);
    expect(agentEnvironment).toBeGreaterThan(globalUnset);
    expect(agentUnset).toBeGreaterThan(agentEnvironment);
    expect(source).toContain("-ieq 'agy.exe'");
    expect(source).toContain('Initialize-AntigravityProxyEnvironment');
  });

  it.each([
    'run-antigravity-bridge.ps1',
    'start-antigravity-bridge-service.ps1',
  ])('initializes Windows proxy settings in %s', (name) => {
    const source = readScript(name);
    expect(source).toContain('antigravity-proxy-env.ps1');
    expect(source).toContain('Initialize-AntigravityProxyEnvironment');
    expect(source).toContain('$env:LARK_CHANNEL_DISABLE_PROXY = "1"');
  });
});
