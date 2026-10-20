import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function installWorkerMemorySkill(root: string, host: string): string | undefined {
  const bundled = fileURLToPath(new URL('../adapters/memory/', import.meta.url));
  const assets = process.env.LARK_MEMORY_ASSET_ROOT ?? (existsSync(bundled) ? bundled : undefined);
  if (!assets) return undefined;
  if (!['codex','claude','antigravity','deepseek-harness','hermes'].includes(host)) throw new Error('memory:unsupported-host');
  const source = join(assets, host, 'SKILL.md');
  if (!existsSync(source)) throw new Error('memory:missing-host-skill');
  const directory = join(root, 'skills', host, 'worker-topic-memory');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'SKILL.md');
  const content = readFileSync(source, 'utf8');
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) writeFileSync(target, content, { mode: 0o600 });
  return target;
}
