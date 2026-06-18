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
  /** Fetch the current verdict. Throws are treated as transient → `pending`. */
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
    } catch {
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
