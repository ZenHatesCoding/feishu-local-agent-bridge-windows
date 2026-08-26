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
    const launch = source.indexOf('& $filePath @arguments');

    expect(commandDirAssignment).toBeGreaterThanOrEqual(0);
    expect(pathAssignment).toBeGreaterThan(commandDirAssignment);
    expect(cliAssignment).toBeGreaterThan(pathAssignment);
    expect(launch).toBeGreaterThan(cliAssignment);
  });
});
