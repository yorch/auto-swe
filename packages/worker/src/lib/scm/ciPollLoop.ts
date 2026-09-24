/**
 * Provider-agnostic CI polling loop.
 *
 * Repeatedly asks for a {@link CiVerdict} until CI resolves, the no-checks grace
 * window elapses, or the overall deadline is hit. All side effects (status
 * fetch, sleep, clock, heartbeat) are injected so the control flow is
 * unit-testable with fakes — the Temporal activity wires real implementations.
 */

import type { CiVerdict } from './ciStatus.js';

export interface CiPollResult {
  passed: boolean;
  logsUrl?: string;
}

export interface CiPollDeps {
  /**
   * Fetch the current verdict. A throw is treated as transient → `pending`,
   * except a permanent HTTP failure (401 / non-rate-limit 403, or a 404 that
   * outlasts the grace window), which ends the loop with
   * {@link CiPollFetchError}.
   */
  fetchStatus: () => Promise<{ verdict: CiVerdict; logsUrl?: string }>;
  /** Sleep for the given milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in milliseconds (e.g. `Date.now`). */
  now: () => number;
  /** Heartbeat so Temporal knows the long-running activity is alive. */
  heartbeat: () => void;
}

export interface CiPollOpts {
  intervalSec: number;
  /** After this long with verdict `none`, conclude passed (repo has no CI). */
  graceSec: number;
  /** Hard upper bound; exceeding it throws {@link CiPollDeadlineError}. */
  deadlineSec: number;
}

export class CiPollDeadlineError extends Error {
  constructor(deadlineSec: number) {
    super(`CI did not complete within ${deadlineSec}s`);
    this.name = 'CiPollDeadlineError';
  }
}

/**
 * The status fetch failed in a way retrying cannot fix — bad credentials, no
 * access, or a repository/ref that does not exist. Polling on would only burn
 * the whole deadline reporting "pending".
 */
export class CiPollFetchError extends Error {
  constructor(
    readonly status: number,
    cause: unknown
  ) {
    super(
      `CI status fetch failed with HTTP ${status}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'CiPollFetchError';
  }
}

/**
 * Largest poll interval honoured. The loop heartbeats once per tick and the
 * activity's heartbeat timeout is 2 minutes, so a tick (sleep + one status
 * fetch) must stay well inside it — a longer configured interval would get
 * the activity killed as dead between two heartbeats.
 */
export const CI_POLL_MAX_INTERVAL_SEC = 60;

/**
 * Largest deadline honoured: below the activity's 6 h `startToCloseTimeout`
 * with room for the final tick, so the loop's own deadline error (terminal,
 * with a clear message) always fires before Temporal's timeout does.
 */
export const CI_POLL_MAX_DEADLINE_SEC = 6 * 3600 - 15 * 60;

/**
 * Make poll timings safe to run. A value that is missing or not a positive
 * number (an unbound spec input arrives as `undefined`, which arithmetic turns
 * into `NaN`, and `sleep(NaN)` is a zero-delay hot loop against the SCM API)
 * falls back to `fallback`; the interval and deadline are then clamped to the
 * bounds above.
 */
export function normalizeCiPollOpts(
  raw: Partial<Record<keyof CiPollOpts, unknown>>,
  fallback: CiPollOpts
): CiPollOpts {
  const pick = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  return {
    deadlineSec: Math.min(pick(raw.deadlineSec, fallback.deadlineSec), CI_POLL_MAX_DEADLINE_SEC),
    graceSec: pick(raw.graceSec, fallback.graceSec),
    intervalSec: Math.min(pick(raw.intervalSec, fallback.intervalSec), CI_POLL_MAX_INTERVAL_SEC),
  };
}

/**
 * The HTTP status of a fetch error that retrying cannot fix, or null for one
 * that may be transient. 401 and 404 are permanent. 403 is permanent unless it
 * is GitHub's rate limiting, which also answers 403 and does clear with time.
 */
export function permanentFetchErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const e = err as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Record<string, unknown> };
  };
  const status = typeof e.status === 'number' ? e.status : null;
  if (status === 401 || status === 404) {
    return status;
  }
  if (status === 403) {
    const headers = e.response?.headers ?? {};
    const rateLimited =
      String(headers['x-ratelimit-remaining'] ?? '') === '0' ||
      headers['retry-after'] !== undefined ||
      /rate limit/i.test(typeof e.message === 'string' ? e.message : '');
    return rateLimited ? null : status;
  }
  return null;
}

export async function runCiPollLoop(deps: CiPollDeps, opts: CiPollOpts): Promise<CiPollResult> {
  const start = deps.now();
  for (;;) {
    deps.heartbeat();

    let verdict: CiVerdict;
    let logsUrl: string | undefined;
    try {
      const res = await deps.fetchStatus();
      verdict = res.verdict;
      logsUrl = res.logsUrl;
    } catch (err) {
      const status = permanentFetchErrorStatus(err);
      // A 404 is permanent only once the grace window has passed: a SHA
      // pushed a moment ago can 404 on the status API until the provider has
      // indexed it, and ending the loop then fails a change whose CI never
      // got a chance to report. Auth failures do not clear with time.
      const youngNotFound = status === 404 && (deps.now() - start) / 1000 < opts.graceSec;
      if (status !== null && !youngNotFound) {
        throw new CiPollFetchError(status, err);
      }
      // Transient GitHub/API error — don't crash the loop; the deadline still
      // bounds it. Treat as still-pending and retry on the next tick.
      verdict = 'pending';
    }

    if (verdict === 'passed') {
      return { logsUrl, passed: true };
    }
    if (verdict === 'failed') {
      return { logsUrl, passed: false };
    }

    const elapsedSec = (deps.now() - start) / 1000;
    if (verdict === 'none' && elapsedSec >= opts.graceSec) {
      // No checks ever appeared within the grace window → nothing to gate on.
      return { passed: true };
    }
    if (elapsedSec >= opts.deadlineSec) {
      throw new CiPollDeadlineError(opts.deadlineSec);
    }

    await deps.sleep(opts.intervalSec * 1000);
  }
}
