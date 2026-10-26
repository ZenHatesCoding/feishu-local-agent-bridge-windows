import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Refresh only App-managed binaries; explicit CLI installations stay pinned. */
export function resolveCodexBinary(binary: string, options: { platform?: string; root?: string } = {}): string {
  if ((options.platform ?? process.platform) !== 'win32' || process.env.LARK_CHANNEL_CODEX_BIN_DISABLE_RESOLVE === '1') return binary;
  const root = options.root ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : undefined);
  if (!root || !/^[a-f0-9]+[/\\]codex\.exe$/i.test(relative(resolve(root), resolve(binary)))) return binary;
  try {
    const installs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      const dir = join(root, entry.name), exe = join(dir, 'codex.exe');
      return existsSync(exe) && existsSync(join(dir, 'codex-code-mode-host.exe')) ? { exe, at: statSync(exe).mtimeMs } : undefined;
    }).filter((value): value is { exe: string; at: number } => Boolean(value));
    return installs.sort((a, b) => b.at - a.at)[0]?.exe ?? binary;
  } catch { return binary; }
}
