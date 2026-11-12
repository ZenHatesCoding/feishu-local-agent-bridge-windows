import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Windows readers can briefly deny replacement. Keep the old JSON valid while retrying. */
export function publishAtomicJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    const deadline = Date.now() + 1000;
    for (;;) {
      try { renameSync(temp, file); return; }
      catch (error) {
        if (!retryable.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
        Atomics.wait(sleeper, 0, 0, 25);
      }
    }
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* Preserve the original failure. */ }
  }
}
