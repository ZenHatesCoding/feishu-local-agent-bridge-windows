import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mock = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), renameSync: mock.rename }));
import { publishAtomicJson } from '../../../src/platform/atomic-json';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('atomic desktop JSON publication', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('keeps valid old data and cleans its temporary file on persistent %s', code => {
    const dir = mkdtempSync(join(tmpdir(), 'ipc-failure-')); roots.push(dir);
    const file = join(dir, 'lease.json'); writeFileSync(file, '{"at":1}');
    mock.rename.mockReset().mockImplementation(() => { throw Object.assign(Error('locked'), { code }); });
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1001);
    expect(() => publishAtomicJson(file, { at: 2 })).toThrow('locked');
    expect(readFileSync(file, 'utf8')).toBe('{"at":1}');
    expect(readdirSync(dir)).toEqual(['lease.json']);
  });
});
