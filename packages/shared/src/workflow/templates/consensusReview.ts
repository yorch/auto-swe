import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Two independent agent review network calls run in parallel via fanOut.
 * Both must approve (failed == 0) before the PR opens. If either rejects,
 * the agent fixes and the consensus check retries (up to 3 total attempts).
 *
 * Demonstrates: fanOut for quality aggregation (not work splitting),
 * with onBranchFail: 'continue' so a single rejection doesn't abort early.
 */
export const CONSENSUS_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Run two independent agent review-network calls in parallel (fanOut with concurrency=2). ' +
    'Both reviewers must approve before the PR opens; if either rejects the agent ' +
    'addresses the combined feedback and tries again (up to 3 rounds). ' +
    'Demonstrates fanOut for parallel quality gates rather than parallel work.',
  entry: 'setValidating',
  name: 'consensus-review',
  nodes: {
    // ── Branch nodes (run inside fanOut) ─────────────────────────────────
    branchApproved: { status: 'SUCCESS', type: 'terminate' },
    branchRejected: { status: 'FAILED', type: 'terminate' },
    checkBranchApproval: {
      expr: 'nodes.runBranchReview.output.approved == true',
      onFalse: 'storeBranchRejection',
      onTrue: 'branchApproved',
      type: 'cond',
    },

    // ── Main graph ────────────────────────────────────────────────────────
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      onFalse: 'terminateCIFailed',
      onTrue: 'setCompleted',
      type: 'cond',
    },
    checkConsensus: {
      expr: 'nodes.fanOutReview.output.failed == 0',
      onFalse: 'incReviewRetries',
      onTrue: 'setAwaitingCi',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'consensusFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    consensusFix: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.lastRejectionSummary' },
      },
      next: 'updateCodeAfterFix',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    fanOutReview: {
      // Two reviewer slots — each branch runs runBranchReview independently.
      concurrency: 2,
      exports: ['context.branchRejectionSummary'],
      itemKey: 'reviewerSlot',
      join: 'storeConsensusResult',
      onBranchFail: 'continue',
      over: { literal: [{ id: 1 }, { id: 2 }] },
      subgraph: 'runBranchReview',
      type: 'fanOut',
    },
    implement: {
      next: 'initCounters',
      step: 'executeImplementation',
      type: 'step',
    },
    incReviewRetries: {
      next: 'storeLastRejection',
      type: 'set',
      values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
    },
    initCounters: {
      next: 'fanOutReview',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.reviewRetries': { literal: 0 },
      },
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    runBranchReview: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkBranchApproval',
      step: 'runReviewNetwork',
      type: 'step',
    },
    savePrInfo: {
      next: 'waitForCI',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setAwaitingCi: {
      config: { status: 'AWAITING_CI' },
      next: 'openPR',
      step: 'updateDomainState',
      type: 'step',
    },
    setCompleted: {
      config: { status: 'COMPLETED' },
      next: 'done',
      step: 'updateDomainState',
      type: 'step',
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setSuccessCriteria: {
      next: 'setImplementing',
      type: 'set',
      values: {
        'context.successCriteria': { default: [], from: 'nodes.validate.output.successCriteria' },
      },
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeBranchRejection: {
      next: 'branchRejected',
      type: 'set',
      values: {
        'context.branchRejectionSummary': {
          default: '',
          from: 'nodes.runBranchReview.output.rejectionSummary',
        },
      },
    },
    storeConsensusResult: {
      next: 'checkConsensus',
      type: 'set',
      values: { 'context.fanOutReview': { from: 'nodes.fanOutReview.output' } },
    },
    storeLastRejection: {
      next: 'checkReviewLimit',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: 'One or more reviewers rejected the implementation.',
          from: 'context.fanOutReview.results',
        },
      },
    },
    terminateCIFailed: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'FAILED',
      type: 'terminate',
    },
    terminateCITimedOut: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
    updateCodeAfterFix: {
      next: 'fanOutReview',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.consensusFix.output' } },
    },
    validate: {
      next: 'setSuccessCriteria',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
    waitForCI: {
      name: 'ciPipelineSignal',
      onReceive: 'checkCI',
      onTimeout: 'terminateCITimedOut',
      storeAs: 'context.ciResultPayload',
      timeout: '4h',
      type: 'signal',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
