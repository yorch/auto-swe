import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Two-person rule: two independent humanApproval gates before the PR opens.
 * Models a change-management process where the author (or team lead) signs off
 * first, then a second independent reviewer must also approve.
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, then require two sequential human approvals ' +
    '(e.g. author sign-off followed by independent reviewer sign-off) before opening the PR. ' +
    'Models a four-eyes / two-person-rule change-management requirement.',
  entry: 'setValidating',
  name: 'four-eyes',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'incReviewRetries',
      onTrue: 'firstSignoff',
      type: 'cond',
    },
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      onFalse: 'terminateCIFailed',
      onTrue: 'setCompleted',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    firstSignoff: {
      description:
        'Confirm you have read the implementation and are satisfied it meets the requirements.',
      onApprove: 'secondSignoff',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'First sign-off — author / team-lead review',
      type: 'humanApproval',
    },
    implement: {
      next: 'initCounters',
      step: 'executeImplementation',
      type: 'step',
    },
    incReviewRetries: {
      next: 'storeRejection',
      type: 'set',
      values: { 'context.reviewRetries': { expr: 'context.reviewRetries + 1' } },
    },
    initCounters: {
      next: 'setReviewing',
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
    review: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        successCriteria: { from: 'context.successCriteria' },
      },
      next: 'checkApproval',
      step: 'runReviewNetwork',
      type: 'step',
    },
    reviewFix: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: { from: 'context.lastRejectionSummary' },
      },
      next: 'updateCodeAfterReviewFix',
      step: 'executeReviewFixImplementation',
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
    secondSignoff: {
      description: 'You are a second, independent reviewer. Confirm the change is safe to merge.',
      onApprove: 'setAwaitingCi',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Second sign-off — independent reviewer',
      type: 'humanApproval',
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
    setReviewing: {
      config: { status: 'IN_REVIEW' },
      next: 'review',
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
    storeRejection: {
      next: 'checkReviewLimit',
      type: 'set',
      values: {
        'context.lastRejectionSummary': {
          default: '',
          from: 'nodes.review.output.rejectionSummary',
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
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    updateCodeAfterReviewFix: {
      next: 'setReviewing',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.reviewFix.output' } },
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
