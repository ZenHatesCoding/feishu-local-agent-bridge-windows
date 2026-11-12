import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { snapshotArtifact } from '../../../src/collab/artifact-store';

describe('collaboration artifact store', () => {
  it('publishes concurrent snapshots without sharing or deleting another writer temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-parallel-'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(123456789);
    try {
      const source = join(root, 'source.txt'); await writeFile(source, 'complete shared content');
      const results = await Promise.all(Array.from({ length: 8 }, () => snapshotArtifact({ sourcePath: source, root: join(root, 'shared'), taskId: 'task' })));
      expect(new Set(results.map(result => result.localPath)).size).toBe(1);
      expect(await readFile(results[0]!.localPath, 'utf8')).toBe('complete shared content');
      expect(await readdir(dirname(results[0]!.localPath))).toEqual(['source.txt']);
    } finally { clock.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it('creates a content-addressed durable snapshot and reuses it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-artifact-'));
    const source = join(root, 'deck.pptx');
    await writeFile(source, 'presentation bytes');

    const first = await snapshotArtifact({
      sourcePath: source,
      root: join(root, 'shared'),
      taskId: 'task/unsafe',
      originalName: 'Q3: review?.pptx',
    });
    const second = await snapshotArtifact({
      sourcePath: source,
      root: join(root, 'shared'),
      taskId: 'task/unsafe',
      originalName: 'Q3: review?.pptx',
    });

    expect(first).toEqual(second);
    expect(first.name).toBe('Q3_ review_.pptx');
    expect(first.kind).toBe('presentation');
    expect(first.localPath).toContain('task_unsafe');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(first.localPath)).resolves.toMatchObject({ size: 18 });
    expect(await readFile(first.localPath, 'utf8')).toBe('presentation bytes');
  });
});
