import { describe, expect, it, vi } from 'vitest';
import { CiPollDeadlineError, type CiPollDeps, runCiPollLoop } from './ciPollLoop.js';
import type { CiVerdict } from './ciStatus.js';

/**
 * Build deps with a fake clock that advances on sleep, and a scripted sequence
 * of verdicts (the last entry repeats once the script is exhausted).
 */
function makeDeps(script: Array<{ verdict: CiVerdict; logsUrl?: string } | Error>) {
  let clockMs = 0;
  let i = 0;
  const heartbeat = vi.fn();
  const deps: CiPollDeps = {
    fetchStatus: vi.fn(async () => {
      const entry = script[Math.min(i, script.length - 1)];
      i += 1;
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    }),
    heartbeat,
    now: () => clockMs,
    sleep: vi.fn(async (ms: number) => {
      clockMs += ms;
    }),
  };
  return { deps, heartbeat };
}

const opts = { deadlineSec: 600, graceSec: 60, intervalSec: 15 };

describe('runCiPollLoop', () => {
  it('returns passed immediately when verdict is passed', async () => {
    const { deps } = makeDeps([{ verdict: 'passed' }]);
    await expect(runCiPollLoop(deps, opts)).resolves.toEqual({ logsUrl: undefined, passed: true });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('returns failed with the logs URL when verdict is failed', async () => {
    const { deps } = makeDeps([{ logsUrl: 'https://ci/run/1', verdict: 'failed' }]);
    await expect(runCiPollLoop(deps, opts)).resolves.toEqual({
      logsUrl: 'https://ci/run/1',
      passed: false,
    });
  });

  it('polls through pending then resolves to passed', async () => {
    const { deps, heartbeat } = makeDeps([
      { verdict: 'pending' },
      { verdict: 'pending' },
      { verdict: 'passed' },
    ]);
    await expect(runCiPollLoop(deps, opts)).resolves.toEqual({ logsUrl: undefined, passed: true });
    expect(deps.fetchStatus).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('treats a transient fetch error as pending and keeps polling', async () => {
    const { deps } = makeDeps([new Error('network blip'), { verdict: 'passed' }]);
    await expect(runCiPollLoop(deps, opts)).resolves.toEqual({ logsUrl: undefined, passed: true });
    expect(deps.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('concludes passed after the grace window when no checks ever appear', async () => {
    // graceSec=60, intervalSec=15 → 4 ticks (0,15,30,45) still under grace, 5th at 60s passes.
    const { deps } = makeDeps([{ verdict: 'none' }]);
    await expect(runCiPollLoop(deps, opts)).resolves.toEqual({ passed: true });
    // 60s / 15s = 4 sleeps before elapsed >= grace.
    expect(deps.sleep).toHaveBeenCalledTimes(4);
  });

  it('throws CiPollDeadlineError when CI stays pending past the deadline', async () => {
    const { deps } = makeDeps([{ verdict: 'pending' }]);
    await expect(runCiPollLoop(deps, { ...opts, deadlineSec: 45 })).rejects.toBeInstanceOf(
      CiPollDeadlineError
    );
  });
});
