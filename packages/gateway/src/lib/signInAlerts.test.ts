import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings: Record<string, number> = {
  'analytics.failedSignInAlertThreshold': 3,
  'analytics.failedSignInAlertWindowMinutes': 10,
};
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => settings[key]),
}));
const recorded = vi.fn();
vi.mock('./metrics.js', () => ({ recordSignInThresholdExceeded: (m: string) => recorded(m) }));

import {
  _resetSignInAlertsForTests,
  _trackedAccountCount,
  MAX_TRACKED_ACCOUNTS,
  noteFailure,
  trackFailedSignIn,
} from './signInAlerts.js';

beforeEach(() => {
  _resetSignInAlertsForTests();
  recorded.mockClear();
});

describe('noteFailure', () => {
  it('reports the crossing once per window per account', () => {
    const r = [1, 2, 3, 4, 5].map((i) => noteFailure('u1', 3, 1000, 100 + i));
    expect(r).toEqual([false, false, true, false, false]);
    expect(noteFailure('u2', 3, 1000, 100)).toBe(false);
  });

  it('reports again after the window runs out', () => {
    for (let i = 0; i < 3; i++) {
      noteFailure('u1', 3, 1000, i);
    }
    expect(noteFailure('u1', 3, 1000, 2000)).toBe(false);
    expect(noteFailure('u1', 3, 1000, 2001)).toBe(false);
    expect(noteFailure('u1', 3, 1000, 2002)).toBe(true);
  });

  it('slides: failures straddling a fixed-window boundary still cross', () => {
    // threshold 5, window 15 min: 1 at t=0, 3 at t=14, 2 at t=16.
    const min = 60_000;
    const r = [
      noteFailure('s', 5, 15 * min, 0),
      ...[14, 14, 14].map((t) => noteFailure('s', 5, 15 * min, t * min)),
      ...[16, 16].map((t) => noteFailure('s', 5, 15 * min, t * min)),
    ];
    expect(r).toEqual([false, false, false, false, false, true]);
  });

  it('re-arms only after the count drops below the threshold', () => {
    const t = [0, 1, 2, 3].map((x) => noteFailure('r', 3, 10, x));
    expect(t).toEqual([false, false, true, false]);
    // Window drained: a fresh burst reports again.
    expect([100, 101, 102].map((x) => noteFailure('r', 3, 10, x))).toEqual([false, false, true]);
  });

  it('stays bounded under many distinct accounts', () => {
    for (let i = 0; i < MAX_TRACKED_ACCOUNTS + 50; i++) {
      noteFailure(`u${i}`, 3, 1_000_000, i);
    }
    expect(_trackedAccountCount()).toBeLessThanOrEqual(MAX_TRACKED_ACCOUNTS);
  });
});

describe('trackFailedSignIn', () => {
  it('counts the crossing with the method, once, and never throws', async () => {
    for (let i = 0; i < 4; i++) {
      trackFailedSignIn('u1', 'password');
    }
    await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
    expect(recorded).toHaveBeenCalledWith('password');
  });
});
