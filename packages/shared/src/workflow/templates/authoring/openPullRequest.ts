import type { Binding } from '../../spec.js';
import type { NodeMap } from './common.js';

export interface OpenPullRequestOptions {
  /** Node that follows the pull request being recorded. */
  next: string;
  /**
   * Also reset `context.ciRetries` to 0 when the pull request is recorded. Only a CI loop
   * with an expression limit counts in `context.ciRetries` (see `ciLoop`); every other loop
   * counts visits to `fetchLogs` and needs no reset. Default false.
   */
  resetCiRetries?: boolean;
  /**
   * Open the pull request as a draft. A repository that cannot hold drafts fails
   * the step; it is never opened ready for review instead. Default false, and then
   * the node carries no `config` at all, so existing templates are unchanged.
   */
  draft?: boolean;
  /** Domain status stamped when `openPR` is entered (normally `AWAITING_CI`). Default none. */
  status?: string;
}

/**
 * Open (or update) the pull request and record it: `openPR -> savePrInfo -> next`.
 * `savePrInfo` writes `context.prNumber` / `context.prUrl`, which the terminal
 * results report. Entry node: `openPR`.
 */
export function openPullRequest(opts: OpenPullRequestOptions): NodeMap {
  const group = 'pull request';
  const values: Record<string, Binding> = {
    ...(opts.resetCiRetries ? { 'context.ciRetries': { literal: 0 } } : {}),
    'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
    'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
  };
  return {
    openPR: {
      ...(opts.draft ? { config: { draft: true } } : {}),
      group,
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      ...(opts.status ? { status: opts.status } : {}),
      step: 'createOrUpdatePullRequest',
      title: 'Open the pull request',
      type: 'step',
    },
    savePrInfo: {
      group,
      next: opts.next,
      title: 'Record the pull request',
      type: 'set',
      values,
    },
  };
}
