import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Splits the ticket into parallel sub-task branches using fanOut.
 * Each branch runs executeImplementation independently (feature code, tests,
 * docs), then results are joined and a single PR is opened.
 *
 * Demonstrates: fanOut concurrency, per-branch context, exports, onBranchFail.
 */
export const PARALLEL_FAN_OUT_SPEC: WorkflowSpec = {
  description:
    'Validate context, split the work into three parallel branches ' +
    '(feature implementation, tests, documentation), then join and open a single PR. ' +
    'Each branch runs an isolated executeImplementation agent. ' +
    'Demonstrates the fanOut node with concurrency=3 and per-branch exports.',
  entry: 'setValidating',
  name: 'parallel-fan-out',
  nodes: {
    branchDone: {
      status: 'SUCCESS',
      type: 'terminate',
    },
    buildSubtasks: {
      next: 'fanOutImpl',
      type: 'set',
      values: {
        'context.subtasks': {
          literal: [
            { area: 'feature', focus: 'Implement the core feature logic' },
            { area: 'tests', focus: 'Write unit and integration tests for the feature' },
            { area: 'docs', focus: 'Update inline docs and changelog for the feature' },
          ],
        },
      },
    },
    checkFanOutResult: {
      expr: 'nodes.fanOutImpl.output.failed == 0',
      onFalse: 'terminatePartialFail',
      onTrue: 'openPR',
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
    fanOutImpl: {
      concurrency: 3,
      exports: ['context.currentCodeResult'],
      itemKey: 'subtask',
      join: 'storeResults',
      onBranchFail: 'continue',
      over: { from: 'context.subtasks' },
      subgraph: 'implementBranch',
      type: 'fanOut',
    },
    implementBranch: {
      next: 'recordBranchResult',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    // Stash the branch's implementer output where the fanOut `exports` list
    // reads it at join time — a branch that never writes the exported path
    // joins with `exports: { 'context.currentCodeResult': undefined }`.
    recordBranchResult: {
      next: 'branchDone',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implementBranch.output' } },
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'buildSubtasks',
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
    storeResults: {
      next: 'checkFanOutResult',
      type: 'set',
      values: { 'context.fanOutResults': { from: 'nodes.fanOutImpl.output' } },
    },
    terminatePartialFail: {
      status: 'FAILED',
      type: 'terminate',
    },
    validate: {
      next: 'setSuccessCriteria',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
