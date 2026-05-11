import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';

/**
 * The seeded default-engineering template. Mirrors the hardcoded
 * EngineeringWorkflow shape exactly so the interpreter can run in parity
 * mode before any teams customize their workflows.
 *
 * Sequence:
 *   start → validate (non-blocking) → implement → review loop → CI loop →
 *   wait-for-human-merge → commit-to-memory → done
 */
export const DEFAULT_ENGINEERING_SPEC: WorkflowSpec = {
  description: 'Default engineering workflow (parity with hardcoded EngineeringWorkflow).',
  entry: 'setValidating',
  name: 'default-engineering',
  nodes: {
    checkApproval: {
      expr: 'nodes.review.output.approved == true',
      onFalse: 'incReviewRetries',
      onTrue: 'setAwaitingCi',
      type: 'cond',
    },
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      onFalse: 'incCIRetries',
      onTrue: 'setAwaitingHumanMerge',
      type: 'cond',
    },
    checkCILimit: {
      expr: 'context.ciRetries >= 3',
      onFalse: 'fetchLogs',
      onTrue: 'terminateCIFailed',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    ciFix: {
      inputs: {
        failureContext: { from: 'context.lastCILogs' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'updateCodeAfterCIFix',
      step: 'executeCIFixImplementation',
      type: 'step',
    },
    // ── Review + CI loop ──
    clearCiResult: {
      next: 'setReviewing',
      type: 'set',
      values: {
        'context.ciResultPayload': { literal: null },
      },
    },
    // ── Memory + completion ──
    commitLesson: {
      next: 'setCompleted',
      onError: 'continue',
      step: 'commitToMemory',
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
    fetchLogs: {
      inputs: {
        logsUrl: { from: 'context.ciResultPayload.logsUrl' },
      },
      next: 'storeLogs',
      step: 'fetchCILogs',
      type: 'step',
    },
    implement: {
      next: 'initCounters',
      step: 'executeImplementation',
      type: 'step',
    },
    incCIRetries: {
      next: 'checkCILimit',
      type: 'set',
      values: {
        'context.ciRetries': { expr: 'context.ciRetries + 1' },
      },
    },
    incReviewRetries: {
      next: 'storeRejection',
      type: 'set',
      values: {
        'context.reviewRetries': { expr: 'context.reviewRetries + 1' },
      },
    },
    initCounters: {
      next: 'clearCiResult',
      type: 'set',
      values: {
        'context.ciRetries': { literal: 0 },
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.reviewRetries': { literal: 0 },
      },
    },
    openPR: {
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
      },
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
    setAwaitingCi: {
      config: { status: 'AWAITING_CI' },
      next: 'openPR',
      step: 'updateDomainState',
      type: 'step',
    },
    // ── Wait for human merge ──
    setAwaitingHumanMerge: {
      config: { status: 'AWAITING_HUMAN_MERGE' },
      next: 'waitForHumanMerge',
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
    storeLogs: {
      next: 'ciFix',
      type: 'set',
      values: {
        'context.lastCILogs': { from: 'nodes.fetchLogs.output' },
      },
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
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'FAILED',
      type: 'terminate',
    },
    terminateCITimedOut: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    terminateMergeTimedOut: {
      result: {},
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    terminateReviewFailed: {
      result: {
        status: { literal: 'FAILED' },
      },
      status: 'FAILED',
      type: 'terminate',
    },
    updateCodeAfterCIFix: {
      next: 'clearCiResult',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.ciFix.output' },
      },
    },
    updateCodeAfterReviewFix: {
      next: 'clearCiResult',
      type: 'set',
      values: {
        'context.currentCodeResult': { from: 'nodes.reviewFix.output' },
      },
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
    waitForHumanMerge: {
      name: 'humanMergeSignal',
      onReceive: 'commitLesson',
      onTimeout: 'terminateMergeTimedOut',
      timeout: '7d',
      type: 'signal',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
