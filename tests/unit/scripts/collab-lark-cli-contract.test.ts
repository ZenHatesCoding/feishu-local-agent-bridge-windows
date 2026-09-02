import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readPilotFile = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'scripts', 'collab-pilot', ...parts), 'utf8');

describe('collaboration pilot lark-cli identity contract', () => {
  it.each(['lark-cli.cmd', 'lark-cli.ps1'])(
    'routes %s to the configured real CLI without selecting an agent identity',
    (name) => {
      const source = readPilotFile('bin', name);

      expect(source).toContain('LARK_COLLAB_REAL_LARK_CLI_JS');
      expect(source).toMatch(/\bnode\b/i);
      expect(source).not.toMatch(/antigravity-bridge|deepseek-bridge/i);
      expect(source).not.toMatch(/LARK_CHANNEL_(?:HOME|PROFILE|CONFIG)\s*=/i);
      expect(source).not.toMatch(/LARKSUITE_CLI_CONFIG_DIR\s*=/i);
      expect(source).not.toMatch(/cli_a[a-z0-9]{8,}/i);
    },
  );

  it('places the identity-neutral command directory first for every agent', () => {
    const source = readPilotFile('run-agent.ps1');
    const commandDirAssignment = source.indexOf("$commandDir = Join-Path $script:CollabRepoRoot 'scripts\\collab-pilot\\bin'");
    const pathAssignment = source.indexOf('$env:PATH = "$commandDir;$env:PATH"');
    const cliAssignment = source.indexOf('$env:LARK_COLLAB_REAL_LARK_CLI_JS =');
    const launchEnvironment = source.indexOf('Set-CollabEnvironment $agentConfig.launch.environment');
    const launch = source.indexOf('& $filePath @arguments');

    expect(commandDirAssignment).toBeGreaterThanOrEqual(0);
    expect(cliAssignment).toBeGreaterThan(commandDirAssignment);
    expect(pathAssignment).toBeGreaterThan(launchEnvironment);
    expect(launch).toBeGreaterThan(cliAssignment);
    expect(launch).toBeGreaterThan(pathAssignment);
    expect(source).toContain("'LARK_CHANNEL_ANTIGRAVITY_BIN'");
    expect(source).toContain("'LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY'");
  });

  it('keeps agent adapters off legacy external bridge bin directories', () => {
    for (const name of ['deepseek-harness/adapter.ts', 'antigravity/adapter.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'agent', name), 'utf8');
      expect(source).not.toContain("dirname(context.rootDir), 'bin'");
    }
  });
});
