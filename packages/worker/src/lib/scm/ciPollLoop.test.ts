import { describe, expect, it, vi } from 'vitest';
import {
  CI_POLL_MAX_DEADLINE_SEC,
  CI_POLL_MAX_INTERVAL_SEC,
  CiPollDeadlineError,
  type CiPollDeps,
  CiPollFetchError,
  normalizeCiPollOpts,
  permanentFetchErrorStatus,
  runCiPollLoop,
} from './ciPollLoop.js';
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

describe('runCiPollLoop — permanent fetch errors', () => {
  const httpError = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

  it('tolerates a 404 inside the grace window (a just-pushed SHA)', async () => {
    const { deps } = makeDeps([httpError(404), httpError(404), { verdict: 'passed' }]);
    await expect(runCiPollLoop(deps, opts)).resolves.toMatchObject({ passed: true });
    expect(deps.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('ends the loop on a 404 that outlasts the grace window', async () => {
    // graceSec=60, intervalSec=15 → 404s at 0,15,30,45 are tolerated; 60 ends it.
    const { deps } = makeDeps([httpError(404)]);
    await expect(runCiPollLoop(deps, opts)).rejects.toMatchObject({ status: 404 });
    expect(deps.fetchStatus).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403])(
    'ends the loop on HTTP %i immediately instead of polling to the deadline',
    async (status) => {
      const { deps } = makeDeps([httpError(status)]);
      await expect(runCiPollLoop(deps, opts)).rejects.toBeInstanceOf(CiPollFetchError);
      expect(deps.sleep).not.toHaveBeenCalled();
    }
  );

  it('keeps polling through a rate-limit 403 and a 5xx', async () => {
    const { deps } = makeDeps([
      httpError(403, { response: { headers: { 'x-ratelimit-remaining': '0' } } }),
      httpError(502),
      { verdict: 'passed' },
    ]);
    await expect(runCiPollLoop(deps, opts)).resolves.toMatchObject({ passed: true });
    expect(deps.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('classifies statuses', () => {
    expect(permanentFetchErrorStatus(httpError(404))).toBe(404);
    expect(permanentFetchErrorStatus(new Error('You have exceeded a secondary rate limit'))).toBe(
      null
    );
    expect(permanentFetchErrorStatus(httpError(403, { message: 'API rate limit exceeded' }))).toBe(
      null
    );
    expect(permanentFetchErrorStatus(httpError(500))).toBe(null);
    expect(permanentFetchErrorStatus('boom')).toBe(null);
  });
});

describe('normalizeCiPollOpts', () => {
  const fallback = { deadlineSec: 14_400, graceSec: 60, intervalSec: 15 };

  it('fills unbound or non-positive inputs from the fallback instead of producing NaN', () => {
    expect(
      normalizeCiPollOpts(
        { deadlineSec: undefined, graceSec: Number.NaN, intervalSec: 0 },
        fallback
      )
    ).toEqual(fallback);
  });

  it('clamps the interval below the heartbeat timeout and the deadline below start-to-close', () => {
    const out = normalizeCiPollOpts(
      { deadlineSec: 10 * 3600, graceSec: 30, intervalSec: 600 },
      fallback
    );
    expect(out.intervalSec).toBe(CI_POLL_MAX_INTERVAL_SEC);
    expect(out.deadlineSec).toBe(CI_POLL_MAX_DEADLINE_SEC);
    expect(CI_POLL_MAX_DEADLINE_SEC).toBeLessThan(6 * 3600);
    expect(out.graceSec).toBe(30);
  });
});
