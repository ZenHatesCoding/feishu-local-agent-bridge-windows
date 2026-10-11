#!/usr/bin/env node
// Entry point for the lark-cli command that the standalone launchers expose on
// PATH. It never sets HOME, USERPROFILE, LARK_CHANNEL_* or
// LARKSUITE_CLI_CONFIG_DIR: those belong to whoever calls it, and a shim that
// picks a profile by itself makes one bot run as another. No path here is
// machine-specific, so a fresh clone works anywhere.
//
// Resolution order:
//   1. LARK_COLLAB_REAL_LARK_CLI_JS when the collaboration pilot exported it
//   2. <dir of node.exe>/node_modules/@larksuite/cli/scripts/run.js
//   3. %APPDATA%\npm\node_modules\@larksuite\cli\scripts\run.js
//   4. require.resolve from those roots
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const RELATIVE_ENTRY = join('node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
const require = createRequire(import.meta.url);
const roots = [dirname(process.execPath)];
if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm'));

function resolveRealCli() {
  const explicit = process.env.LARK_COLLAB_REAL_LARK_CLI_JS;
  if (explicit && existsSync(explicit)) return explicit;
  for (const root of roots) {
    const direct = join(root, RELATIVE_ENTRY);
    if (existsSync(direct)) return direct;
  }
  for (const root of roots) {
    try {
      return require.resolve('@larksuite/cli/scripts/run.js', { paths: [root] });
    } catch {
      // Try the next root.
    }
  }
  return undefined;
}

const entry = resolveRealCli();
if (!entry) {
  console.error(
    'lark-cli: @larksuite/cli was not found. Install it with `npm install -g @larksuite/cli`, ' +
    'or set LARK_COLLAB_REAL_LARK_CLI_JS to its scripts/run.js.',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
