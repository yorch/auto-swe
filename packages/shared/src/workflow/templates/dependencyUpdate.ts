import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Tailored for dependency bumps: implement → full test suite → open PR → CI loop.
 * Skips the expensive review network (the diff is typically mechanical); tests
 * and CI are the real quality gate. Up to 3 CI-fix attempts before giving up.
 */
export const DEPENDENCY_UPDATE_SPEC: WorkflowSpec = {
  description:
    'Implement the dependency update, run the full test suite, open a PR, then loop ' +
    'on CI failures (fetch logs → fix → push) up to 3 times. ' +
    'Skips the review network — tests and CI are the quality gate for mechanical dep bumps.',
  entry: 'setValidating',
  name: 'dependency-update',
  nodes: {
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      onFalse: 'incCIRetries',
      onTrue: 'setCompleted',
      type: 'cond',
    },
    checkCILimit: {
      expr: 'context.ciRetries >= 3',
      onFalse: 'fetchLogs',
      onTrue: 'terminateCIFailed',
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
      next: 'storeCodeResult',
      step: 'executeImplementation',
      type: 'step',
    },
    incCIRetries: {
      next: 'checkCILimit',
      type: 'set',
      values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    repushAfterFix: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'waitForCI',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    runTests: {
      next: 'openPR',
      onFail: 'warn',
      step: 'runTests',
      type: 'step',
    },
    savePrInfo: {
      next: 'waitForCI',
      type: 'set',
      values: {
        'context.ciRetries': { literal: 0 },
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
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
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeCodeResult: {
      next: 'runTests',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    storeLogs: {
      next: 'ciFix',
      type: 'set',
      values: { 'context.lastCILogs': { from: 'nodes.fetchLogs.output' } },
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
    updateCodeAfterCIFix: {
      next: 'repushAfterFix',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
    },
    validate: {
      next: 'setImplementing',
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
