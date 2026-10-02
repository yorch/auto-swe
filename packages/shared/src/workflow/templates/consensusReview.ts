import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
  mergeNodes,
  openPullRequest,
  prResult,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Two independent agent review network calls run in parallel via fanOut.
 * Both must approve (failed == 0) before the PR opens. If either rejects,
 * the agent fixes and the consensus check retries (up to 3 total attempts).
 *
 * CI runs after the consensus. A failing CI is fixed by the agent (up to 3 times, like
 * default-engineering); the fix re-enters the two-reviewer consensus, then updates the pull request.
 *
 * Demonstrates: fanOut for quality aggregation (not work splitting),
 * with onBranchFail: 'continue' so a single rejection doesn't abort early.
 */
export const CONSENSUS_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Run two independent agent review-network calls in parallel (fanOut with concurrency=2). ' +
    'Both reviewers must approve before the PR opens; if either rejects the agent ' +
    'addresses the combined feedback and tries again (up to 3 rounds). ' +
    'Then wait for CI; a CI failure is fixed by the agent (up to 3 times) and the fix goes back ' +
    'through both reviewers before the PR is updated. ' +
    'Demonstrates fanOut for parallel quality gates rather than parallel work.',
  entry: 'setValidating',
  name: 'consensus-review',
  nodes: mergeNodes(
    {
      // ── Branch nodes (run inside fanOut) ─────────────────────────────────
      branchApproved: terminate('SUCCESS', { group: 'reviewer branch', title: 'Branch approved' }),
      branchRejected: terminate('FAILED', { group: 'reviewer branch', title: 'Branch rejected' }),
      checkBranchApproval: {
        expr: 'nodes.runBranchReview.output.approved == true',
        group: 'reviewer branch',
        onFalse: 'storeBranchRejection',
        onTrue: 'branchApproved',
        title: 'Approved?',
        type: 'cond',
      },
      runBranchReview: {
        group: 'reviewer branch',
        inputs: {
          codeResult: { from: 'context.currentCodeResult' },
          successCriteria: { from: 'context.successCriteria' },
        },
        next: 'checkBranchApproval',
        step: 'runReviewNetwork',
        title: 'Review network (one reviewer slot)',
        type: 'step',
      },
      storeBranchRejection: {
        group: 'reviewer branch',
        next: 'branchRejected',
        title: 'Record why it was rejected',
        type: 'set',
        values: {
          'context.branchRejectionSummary': {
            default: '',
            from: 'nodes.runBranchReview.output.rejectionSummary',
          },
        },
      },
    },
    // ── Main graph ────────────────────────────────────────────────────────
    validatePhase({ next: 'setImplementing' }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'initCounters',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      initCounters: initCounters('fanOutReview', { group: 'implement' }),
      // The consensus review: two reviewer slots, both must approve.
      fanOutReview: {
        // Two reviewer slots — each branch runs runBranchReview independently.
        concurrency: 2,
        exports: ['context.branchRejectionSummary'],
        group: 'consensus review',
        itemKey: 'reviewerSlot',
        join: 'storeConsensusResult',
        onBranchFail: 'continue',
        over: { literal: [{ id: 1 }, { id: 2 }] },
        subgraph: 'runBranchReview',
        title: 'Run both reviewers',
        type: 'fanOut',
      },
      storeConsensusResult: {
        group: 'consensus review',
        next: 'checkConsensus',
        title: 'Keep the verdicts',
        type: 'set',
        values: { 'context.fanOutReview': { from: 'nodes.fanOutReview.output' } },
      },
      checkConsensus: {
        expr: 'nodes.fanOutReview.output.failed == 0',
        group: 'consensus review',
        onFalse: 'incReviewRetries',
        onTrue: 'setAwaitingCi',
        title: 'Both approved?',
        type: 'cond',
      },
      incReviewRetries: {
        group: 'consensus review',
        next: 'storeLastRejection',
        title: 'Count the attempt',
        type: 'set',
        values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
      },
      storeLastRejection: {
        group: 'consensus review',
        next: 'checkReviewLimit',
        title: 'Record why it was rejected',
        type: 'set',
        values: {
          'context.lastRejectionSummary': {
            default: 'One or more reviewers rejected the implementation.',
            from: 'context.fanOutReview.results',
          },
        },
      },
      checkReviewLimit: {
        expr: 'context.reviewRetries >= 3',
        group: 'consensus review',
        onFalse: 'consensusFix',
        onTrue: 'terminateReviewFailed',
        title: 'Out of attempts?',
        type: 'cond',
      },
      consensusFix: {
        group: 'consensus review',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'context.lastRejectionSummary' },
        },
        next: 'updateCodeAfterFix',
        step: 'executeReviewFixImplementation',
        title: 'Fix the review findings',
        type: 'step',
      },
      updateCodeAfterFix: {
        group: 'consensus review',
        next: 'fanOutReview',
        title: 'Keep the fixed code',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.consensusFix.output' } },
      },
      terminateReviewFailed: terminate('FAILED', {
        group: 'consensus review',
        title: 'Review failed',
      }),
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    openPullRequest({ next: ciWaitEntry() }),
    // A CI failure is fixed and the fixed code goes back through both reviewers before it is
    // pushed, so the consensus always describes the code that is pushed.
    ciLoop({ fix: { handoff: { rereview: 'fanOutReview' } }, passed: 'done' }),
    {
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
