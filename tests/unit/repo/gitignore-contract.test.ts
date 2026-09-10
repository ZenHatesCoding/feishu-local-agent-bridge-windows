import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const ignorePatterns = () =>
  readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

describe('repository ignore contract', () => {
  it('never hides src/workspace behind a bare workspace/ pattern', () => {
    const patterns = ignorePatterns();

    // A bare `workspace/` (no leading slash) matches at every depth, so it also
    // ignores src/workspace/, where tracked sources live. Anything added there
    // would silently stay out of the repository and break other clones.
    expect(patterns).not.toContain('workspace/');
    expect(patterns).not.toContain('workspace');
    expect(patterns).toContain('/workspace/');
  });

  it('keeps the workspace store that the start command imports', () => {
    expect(existsSync(join(repoRoot, 'src', 'workspace', 'store.ts'))).toBe(true);
  });
});
