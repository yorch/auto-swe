import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciWaitEntry,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
  terminate,
  validatePhase,
  waitForCi,
} from './authoring/index.js';

/**
 * Simplest supervised flow: implement → tests → human approve → open PR.
 * Useful when a human must sign off on every change before it becomes
 * visible to reviewers.
 */
export const PR_APPROVAL_GATE_SPEC: WorkflowSpec = {
  description:
    'Implement, run tests, then require explicit human approval before the pull request is ' +
    'opened. Useful when a person must sign off on every change before reviewers can see ' +
    'it.',
  entry: 'setValidating',
  name: 'pr-approval-gate',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing', successCriteria: false }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'runTests',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      runTests: qualityGate('runTests', 'storeCodeResult', { group: 'verify' }),
      storeCodeResult: storeCodeResult('approve', { group: 'verify' }),
      approve: {
        description: 'Tests passed. Approve to open the PR or reject to discard.',
        group: 'approval',
        onApprove: 'setAwaitingCi',
        onReject: 'terminateRejected',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Approve implementation before opening PR',
        type: 'humanApproval',
      },
      terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
      terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    openPullRequest({ next: ciWaitEntry() }),
    // CI is observed, not enforced: both outcomes complete the run.
    waitForCi(),
    {
      checkCI: {
        expr: 'context.ciResultPayload.passed == true',
        group: 'CI wait',
        onFalse: 'done',
        onTrue: 'done',
        title: 'CI passed?',
        type: 'cond',
      },
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
