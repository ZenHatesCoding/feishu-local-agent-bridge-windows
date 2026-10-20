import { spawnProcess, mergeProcessEnv } from '../platform/spawn';
import type { MemorySynthesizer } from './runtime';

export function hermesMemorySynthesizer(): MemorySynthesizer | undefined {
  const python = process.env.LARK_MEMORY_HERMES_PYTHON;
  const helper = process.env.LARK_MEMORY_HERMES_HELPER;
  if (!python || !helper) return undefined;
  return (prompt, cwd) => new Promise<string>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    for (const key of Object.keys(process.env)) if (key.startsWith('LARK_COLLAB_') || key === 'LARK_MEMORY_BINDING') env[key] = undefined;
    const child = spawnProcess(python, [helper], { cwd, env: mergeProcessEnv(process.env, env), stdio: ['pipe','pipe','pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('memory:hermes-timeout')); }, 120000);
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 32000) { child.kill(); reject(new Error('memory:hermes-output-over-budget')); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && output.trim()) resolve(output); else reject(new Error('memory:hermes-synthesis-failed')); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}
