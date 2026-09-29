import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types.js';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import { processAgentStream } from '../../../src/bot/channel.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('run activity watchdog', () => {
  it('refreshes the idle deadline for privacy-safe activity heartbeats', async () => {
    vi.useFakeTimers();
    let releaseActivity!: () => void;
    let releaseDone!: () => void;
    const activityReady = new Promise<void>((resolve) => { releaseActivity = resolve; });
    const doneReady = new Promise<void>((resolve) => { releaseDone = resolve; });
    let stops = 0;

    async function* events(): AsyncGenerator<AgentEvent> {
      await activityReady;
      yield { type: 'activity', summary: 'agent stream active' };
      await doneReady;
      yield { type: 'done', terminationReason: 'normal' };
    }

    const run: AgentRun = {
      runId: 'run-activity',
      events: events(),
      async stop() { stops += 1; },
      async waitForExit() { return true; },
    };
    const handle: RunHandle = { run, interrupted: false };
    const resultPromise = processAgentStream(
      handle,
      run.events,
      'scope-1',
      100,
      () => {},
      async () => {},
    );

    await vi.advanceTimersByTimeAsync(80);
    releaseActivity();
    await vi.advanceTimersByTimeAsync(80);
    releaseDone();
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toMatchObject({ terminal: 'done' });
    expect(stops).toBe(0);
  });
});
