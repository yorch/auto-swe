import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Standard review + CI, then two additional signal gates: staging deploy result
 * and production monitoring result. Models a release-train / canary pipeline
 * where external systems send go/no-go signals at each stage.
 *
 * Expected signals:
 *   stagingDeploySignal   — payload: { deployed: boolean }
 *   productionMonitorSignal — payload: { healthy: boolean }
 */
export const CANARY_ROLLOUT_SPEC: WorkflowSpec = {
  description:
    'Implement, review (up to 3 agent attempts), open PR, wait for CI, ' +
    'then pause for a staging-deploy signal and finally a production-monitoring signal. ' +
    'Models a canary/release-train pipeline where each promotion stage must be ' +
    'explicitly confirmed by an external system before proceeding.',
  entry: 'setValidating',
  name: 'canary-rollout',
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
      onTrue: 'waitForStaging',
      type: 'cond',
    },
    checkCILimit: {
      expr: 'context.ciRetries >= 3',
      onFalse: 'fetchLogs',
      onTrue: 'terminateCIFailed',
      type: 'cond',
    },
    checkMonitoring: {
      expr: 'context.monitorPayload.healthy == true',
      onFalse: 'terminateRollbackRequired',
      onTrue: 'done',
      type: 'cond',
    },
    checkReviewLimit: {
      expr: 'context.reviewRetries >= 3',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    },
    checkStaging: {
      expr: 'context.stagingPayload.deployed == true',
      onFalse: 'terminateStagingFailed',
      onTrue: 'waitForMonitoring',
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
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    fetchLogs: {
      inputs: { logsUrl: { from: 'context.ciResultPayload.logsUrl' } },
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
      values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
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
        'context.ciRetries': { literal: 0 },
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
    repushAfterCIFix: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'waitForCI',
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
      values: { 'context.lastCILogs': { from: 'nodes.fetchLogs.output' } },
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
    terminateMonitorTimedOut: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    terminateReviewFailed: { status: 'FAILED', type: 'terminate' },
    terminateRollbackRequired: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'FAILED',
      type: 'terminate',
    },
    terminateStagingFailed: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'FAILED',
      type: 'terminate',
    },
    terminateStagingTimedOut: {
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
      status: 'TIMED_OUT',
      type: 'terminate',
    },
    updateCodeAfterCIFix: {
      next: 'repushAfterCIFix',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
    },
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
    waitForMonitoring: {
      name: 'productionMonitorSignal',
      onReceive: 'checkMonitoring',
      onTimeout: 'terminateMonitorTimedOut',
      storeAs: 'context.monitorPayload',
      timeout: '2h',
      type: 'signal',
    },
    waitForStaging: {
      name: 'stagingDeploySignal',
      onReceive: 'checkStaging',
      onTimeout: 'terminateStagingTimedOut',
      storeAs: 'context.stagingPayload',
      timeout: '1h',
      type: 'signal',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
