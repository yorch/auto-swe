import { resolveSetting } from '@auto-swe/shared/config';
import type { SignInMethod } from './authMethod.js';
import { recordSignInThresholdExceeded } from './metrics.js';

/**
 * Failed-sign-in threshold crossings, counted per account in this process only.
 *
 * The window slides, as the setting and the alerts query do: each account keeps the timestamps of
 * its most recent failures (at most `threshold` of them), and a failure crosses when that many
 * fall inside the last `windowMs`. A crossing is reported once (`auth.sign_in.threshold_exceeded`)
 * and re-armed only after the count in the window has dropped below the threshold. The map is
 * bounded: the least recently touched accounts are dropped first, so a flood of distinct accounts
 * cannot grow it without limit.
 */
export const MAX_TRACKED_ACCOUNTS = 10_000;

interface Entry {
  /** Failure times, oldest first, never more than `threshold` of them. */
  times: number[];
  reported: boolean;
}

const entries = new Map<string, Entry>();

/** For tests. */
export function _resetSignInAlertsForTests(): void {
  entries.clear();
}

/** For tests. */
export function _trackedAccountCount(): number {
  return entries.size;
}

/**
 * Pure bookkeeping: note one failure for `userId`; true exactly when this failure is the one that
 * brings the count inside the sliding window up to `threshold` after it was last below it.
 */
export function noteFailure(
  userId: string,
  threshold: number,
  windowMs: number,
  now = Date.now()
): boolean {
  const e = entries.get(userId) ?? { reported: false, times: [] };
  // Refresh recency so the eviction below drops the least recently touched account.
  entries.delete(userId);
  entries.set(userId, e);
  while (e.times.length > 0 && now - (e.times[0] as number) >= windowMs) {
    e.times.shift();
  }
  // Below the threshold again: the next crossing is a new one.
  if (e.times.length < threshold) {
    e.reported = false;
  }
  e.times.push(now);
  while (e.times.length > threshold) {
    e.times.shift();
  }
  while (entries.size > MAX_TRACKED_ACCOUNTS) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    entries.delete(oldest);
  }
  if (e.times.length >= threshold && !e.reported) {
    e.reported = true;
    return true;
  }
  return false;
}

/**
 * Called from the failure-recording path, not awaited. Reads the two settings (cached by the
 * registry) and bumps the counter on a crossing. Never throws.
 */
export function trackFailedSignIn(userId: string, method: SignInMethod): void {
  void (async () => {
    try {
      const [threshold, minutes] = await Promise.all([
        resolveSetting('analytics.failedSignInAlertThreshold', {}),
        resolveSetting('analytics.failedSignInAlertWindowMinutes', {}),
      ]);
      if (noteFailure(userId, threshold, minutes * 60_000)) {
        recordSignInThresholdExceeded(method);
      }
    } catch (err) {
      console.error('[better-auth] failed to evaluate the sign-in alert threshold:', err);
    }
  })();
}
