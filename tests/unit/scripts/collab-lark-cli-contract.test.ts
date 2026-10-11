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
    const common = readPilotFile('Pilot.Common.ps1');
    const commandDirAssignment = source.indexOf("$commandDir = Join-Path $script:CollabRepoRoot 'scripts\\collab-pilot\\bin'");
    const pathAssignment = source.indexOf('$env:PATH = "$commandDir;$env:PATH"');
    // The real CLI entry is now exported through the shared helper; the literal
    // assignment lives in Pilot.Common.ps1. The call site must still sit after
    // the command dir is known and before the agent launcher runs.
    const cliAssignment = source.indexOf('Export-CollabRealLarkCliJs -Pilot $pilot');
    const launchEnvironment = source.indexOf('Set-CollabEnvironment $agentConfig.launch.environment');
    const launch = source.indexOf('& $filePath @arguments');

    expect(common).toContain("'LARK_COLLAB_REAL_LARK_CLI_JS'");
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

  it.each(['lark-cli.cmd', 'lark-cli.ps1'])(
    'keeps the repository-root %s shim identity-neutral and machine-independent',
    (name) => {
      const source = readFileSync(join(process.cwd(), 'bin', name), 'utf8');

      expect(source).toContain('lark-cli.mjs');
      // No absolute Windows path, and no identity of its own: HOME, USERPROFILE,
      // LARK_CHANNEL_* and LARKSUITE_CLI_CONFIG_DIR belong to the caller.
      expect(source).not.toMatch(/[A-Za-z]:\\/);
      expect(source).not.toMatch(/LARK_CHANNEL_(?:HOME|PROFILE|CONFIG)\s*=/i);
      expect(source).not.toMatch(/LARKSUITE_CLI_CONFIG_DIR\s*=/i);
      expect(source).not.toMatch(/\bHOME\s*=/);
      expect(source).not.toMatch(/\bUSERPROFILE\s*=/);
    },
  );

  it('resolves the real lark-cli without assuming an install location', () => {
    const resolver = readFileSync(join(process.cwd(), 'bin', 'lark-cli.mjs'), 'utf8');

    expect(resolver).toContain('LARK_COLLAB_REAL_LARK_CLI_JS');
    expect(resolver).toContain("'@larksuite/cli/scripts/run.js'");
    expect(resolver).not.toMatch(/[A-Za-z]:\\/);
    expect(resolver).not.toMatch(/antigravity-bridge|deepseek-bridge/i);
  });
});
