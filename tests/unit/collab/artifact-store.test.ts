import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotArtifact } from '../../../src/collab/artifact-store';

describe('collaboration artifact store', () => {
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
