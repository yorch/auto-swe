import { type NodeMap, terminate } from './common.js';

export interface ReviewLoopOptions {
  /** Where an approved review goes next. */
  approved: string;
  /**
   * Where the fixed code goes after `reviewFix` has revised it. Default `review`,
   * i.e. straight back into the review; ticket-to-merge routes through
   * `clearCiResult` first.
   */
  afterFix?: string;
  /**
   * Rejected reviews tolerated before the run fails (at least 2). Default 3: the third
   * rejection exhausts the loop, so the fixer runs at most `limit - 1` times.
   */
  limit?: number;
  /**
   * Where the loop goes when it runs out of attempts. Default `terminateReviewFailed`;
   * a template that records the failure first (a lesson, a notification) routes
   * through its own node and on to `terminateReviewFailed` itself.
   */
  exhausted?: string;
  /**
   * Config for the `reviewFix` node (a `systemPrompt`, `allowedPaths`, …). The fixer
   * otherwise runs with the default prompt and no restriction, which loses any rule a
   * template put on its first implementation. Omitted, the node carries no `config`.
   */
  fixConfig?: Record<string, unknown>;
}

/**
 * The agent review loop, as seven plain nodes:
 *
 *   review --> checkApproval --approved--> forgetRejection -> `approved`
 *                  |
 *             (rejected)
 *                  v
 *   storeRejection -> checkStalled --same findings as last round--> `exhausted`
 *                          |                                     (default terminateReviewFailed)
 *                    (new findings)
 *                          v
 *                      reviewFix --(visit `limit`)--> `exhausted`
 *                          |
 *                      `afterFix` (review)
 *
 * `review` carries the `IN_REVIEW` status, set on every entry. The attempt limit is
 * `maxVisits` on `reviewFix`: its visit count (`nodes.reviewFix.visits`) is the number of
 * fixes made, and the entry after `limit - 1` fixes goes to `exhausted`. `reviewFix` keeps
 * its output as `context.currentCodeResult` (`storeAs`).
 *
 * `review` is handed the previous round's findings fingerprint
 * (`context.lastReviewFingerprint`) and reports `stalled` when a rejection repeats it.
 * An approval clears the fingerprint (`forgetRejection`), so a template that re-enters the review
 * afterwards (a CI fix, a price-note check) does not compare a later rejection with an earlier one.
 * The count is never reset, so a re-entered review shares the one budget. Entry node: `review`.
 */
export function reviewLoop(opts: ReviewLoopOptions): NodeMap {
  const group = 'review loop';
  const limit = opts.limit ?? 3;
  if (limit < 2) {
    throw new Error(`reviewLoop: limit must be at least 2 (got ${limit})`);
  }
  const exhausted = opts.exhausted ?? 'terminateReviewFailed';
  return {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      group,
      onFalse: 'storeRejection',
      onTrue: 'forgetRejection',
      title: 'Approved?',
      type: 'cond',
    },
    checkStalled: {
      expr: 'nodes.review.output.stalled == true',
      group,
      onFalse: 'reviewFix',
      onTrue: exhausted,
      title: 'Same findings as last round?',
      type: 'cond',
    },
    forgetRejection: {
      group,
      next: opts.approved,
      title: 'Forget the last rejection',
      type: 'set',
      values: { 'context.lastReviewFingerprint': { literal: '' } },
    },
    review: {
      group,
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        previousFingerprint: { default: '', from: 'context.lastReviewFingerprint' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkApproval',
      status: 'IN_REVIEW',
      step: 'runReviewNetwork',
      title: 'Review network',
      type: 'step',
    },
    reviewFix: {
      ...(opts.fixConfig ? { config: opts.fixConfig } : {}),
      group,
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.lastRejectionSummary' },
      },
      maxVisits: limit - 1,
      next: opts.afterFix ?? 'review',
      onExhausted: exhausted,
      step: 'executeReviewFixImplementation',
      storeAs: 'context.currentCodeResult',
      title: 'Fix the review findings',
      type: 'step',
    },
    storeRejection: {
      group,
      next: 'checkStalled',
      title: 'Record why it was rejected',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: '',
          from: 'nodes.review.output.rejectionSummary',
        },
        'context.lastReviewFingerprint': {
          default: '',
          from: 'nodes.review.output.rejectionFingerprint',
        },
      },
    },
    terminateReviewFailed: terminate('FAILED', { group, title: 'Review failed' }),
  };
}
