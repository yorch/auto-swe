import type { NodeMap } from './common.js';

export interface QodoReviewOptions {
  /** Node that follows when Qodo has no blocking finding (or could not be read). */
  next: string;
  /** Node a blocking Qodo finding routes to, typically a human decision. */
  onBlocked: string;
  /** Seconds to wait for Qodo's review. Omitted: the team's `qodo.reviewWaitSeconds` setting. */
  waitSeconds?: number;
  /** Ignore open findings below this level. Omitted: every level counts. */
  minActionLevel?: 'action_required' | 'remediation_recommended' | 'informational';
  /**
   * Route to `onBlocked` unless Qodo reviewed the head commit and found nothing blocking. A review
   * that is pending, stale, unavailable or disabled then blocks too. Default false: those go to
   * `next`.
   */
  failClosed?: boolean;
}

/**
 * Wait for Qodo's review of the pull request just recorded and route on it:
 * `qodoReview -> qodoGate -> onBlocked | next`. The step never fails the run, so it blocks only
 * through `qodoGate`, which sends a review of the head commit with an open `action_required`
 * finding to `onBlocked`. A review that is pending, stale, unavailable or disabled goes to `next`,
 * unless `failClosed` is set, which sends it to `onBlocked` as well.
 * Reads `context.prUrl` and `context.currentCodeResult.headSha`, so it follows `openPullRequest`.
 * Entry node: `qodoReview`.
 */
export function qodoReview(opts: QodoReviewOptions): NodeMap {
  const group = 'Qodo review';
  const config = {
    ...(opts.waitSeconds === undefined ? {} : { waitSeconds: opts.waitSeconds }),
    ...(opts.minActionLevel ? { minActionLevel: opts.minActionLevel } : {}),
  };
  return {
    qodoGate: {
      expr: opts.failClosed
        ? "nodes.qodoReview.output.status != 'reviewed' || nodes.qodoReview.output.blocking == true"
        : 'nodes.qodoReview.output.blocking == true',
      group,
      onFalse: opts.next,
      onTrue: opts.onBlocked,
      title: 'Qodo found a blocking issue?',
      type: 'cond',
    },
    qodoReview: {
      ...(Object.keys(config).length > 0 ? { config } : {}),
      group,
      inputs: {
        headSha: { from: 'context.currentCodeResult.headSha' },
        prUrl: { from: 'context.prUrl' },
      },
      next: 'qodoGate',
      onFail: 'warn',
      step: 'awaitQodoReview',
      title: "Wait for Qodo's review",
      type: 'step',
    },
  };
}
