import { type NodeMap, statusStamp, terminate } from './common.js';

export interface ReviewLoopOptions {
  /** Where an approved review goes next. */
  approved: string;
  /**
   * Where the fixed code goes after `reviewFix` has revised it. Default
   * `setReviewing`, i.e. straight back into the review; default-engineering
   * routes through `clearCiResult` first.
   */
  afterFix?: string;
  /** Rejected reviews tolerated before the run fails. Default 3. */
  limit?: number;
  /**
   * Where the loop goes when it runs out of attempts. Default `terminateReviewFailed`;
   * a template that records the failure first (a lesson, a notification) routes
   * through its own node and on to `terminateReviewFailed` itself.
   */
  exhausted?: string;
  /** Id of the node that keeps the fix, for a template that already names it differently. */
  keepFixId?: string;
  /**
   * Config for the `reviewFix` node (a `systemPrompt`, `allowedPaths`, …). The fixer
   * otherwise runs with the default prompt and no restriction, which loses any rule a
   * template put on its first implementation. Omitted, the node carries no `config`.
   */
  fixConfig?: Record<string, unknown>;
}

/**
 * The agent review loop, as nine plain nodes:
 *
 *   setReviewing -> review -> checkApproval --approved--> `approved`
 *                                   |
 *                              (rejected)
 *                                   v
 *   incReviewRetries -> storeRejection -> checkReviewLimit --over limit--> terminateReviewFailed
 *                                                |
 *                                            (under)
 *                                                v
 *                         reviewFix -> updateCodeAfterReviewFix -> `afterFix` (setReviewing)
 *
 * The counter lives at `context.reviewRetries` and must be initialised to 0
 * before the loop is entered (see `initCounters`). Entry node: `setReviewing`.
 */
export function reviewLoop(opts: ReviewLoopOptions): NodeMap {
  const group = 'review loop';
  const keepFix = opts.keepFixId ?? 'updateCodeAfterReviewFix';
  return {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      group,
      onFalse: 'incReviewRetries',
      onTrue: opts.approved,
      title: 'Approved?',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: `context.reviewRetries >= ${opts.limit ?? 3}`,
      group,
      onFalse: 'reviewFix',
      onTrue: opts.exhausted ?? 'terminateReviewFailed',
      title: 'Out of attempts?',
      type: 'cond',
    },
    incReviewRetries: {
      group,
      next: 'storeRejection',
      title: 'Count the attempt',
      type: 'set',
      values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
    },
    review: {
      group,
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkApproval',
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
      next: keepFix,
      step: 'executeReviewFixImplementation',
      title: 'Fix the review findings',
      type: 'step',
    },
    setReviewing: statusStamp('IN_REVIEW', 'review', { group }),
    storeRejection: {
      group,
      next: 'checkReviewLimit',
      title: 'Record why it was rejected',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: '',
          from: 'nodes.review.output.rejectionSummary',
        },
      },
    },
    terminateReviewFailed: terminate('FAILED', { group, title: 'Review failed' }),
    [keepFix]: {
      group,
      next: opts.afterFix ?? 'setReviewing',
      title: 'Keep the fixed code',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.reviewFix.output' } },
    },
  };
}
