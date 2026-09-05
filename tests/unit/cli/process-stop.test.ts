import { afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  isAlive: vi.fn(),
  readAndPrune: vi.fn(() => []),
  resolveTarget: vi.fn(),
  unregister: vi.fn(),
}));
const locks = vi.hoisted(() => ({ cleanupStoppedRuntimeLocks: vi.fn() }));

vi.mock('../../../src/runtime/registry', () => registry);
vi.mock('../../../src/runtime/locks', () => locks);

import { runKillCli, stopProcessEntry } from '../../../src/cli/commands/ps';

describe('process stop stale-entry handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not signal a PID that is already gone', async () => {
    registry.isAlive.mockReturnValue(false);
    const kill = vi.spyOn(process, 'kill');

    await expect(stopProcessEntry({ pid: 2147483647 })).resolves.toBe('terminated');
    expect(kill).not.toHaveBeenCalled();
  });

  it('removes a stale registry entry instead of reporting kill ESRCH', async () => {
    registry.resolveTarget.mockReturnValue({
      id: 'dead',
      pid: 2147483647,
      appId: 'cli_test',
      profileName: 'codex',
    });
    registry.isAlive.mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runKillCli('dead');

    expect(registry.unregister).toHaveBeenCalledWith('dead');
    expect(locks.cleanupStoppedRuntimeLocks).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'codex' }),
      'cli_test',
      2147483647,
    );
    expect(log).toHaveBeenCalledWith('✓ 已清理 bot dead 的陈旧登记。');
  });
});
