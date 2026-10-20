import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciWaitEntry,
  initCounters,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  terminate,
  validatePhase,
  waitForCi,
} from './authoring/index.js';

/**
 * Simplest supervised flow: implement → tests → human approve → open PR.
 * Useful when a human must sign off on every change before it becomes
 * visible to reviewers.
 *
 * The gate offers a third action beside approve and reject: request changes
 * (with a required note) sends the code back for a fix that is tested again and
 * re-presented for approval; a third change request fails the run.
 */
export const APPROVE_BEFORE_PR_SPEC: WorkflowSpec = {
  description:
    'Implement, run tests, then require explicit human approval before the pull request is ' +
    'opened. Requesting changes — with a required note — sends the code back for a fix that ' +
    'is tested and approved again (a third change request fails the run); rejecting stops it. ' +
    'Useful when a person must sign off on every change before reviewers can see it.',
  entry: 'setValidating',
  name: 'approve-before-pr',
  nodes: mergeNodes(
    validatePhase({ next: 'setImplementing', successCriteria: false }),
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        group: 'implement',
        next: 'initCounters',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      initCounters: initCounters('runTests', {
        ci: false,
        counters: ['context.approvalRetries'],
        group: 'implement',
        review: false,
      }),
      runTests: qualityGate('runTests', 'approve', { group: 'verify' }),
      approve: {
        description:
          'Tests passed. Approve to open the PR, request changes (with a note) to send it ' +
          'back for a fix, or reject to discard.',
        group: 'approval',
        onApprove: 'setAwaitingCi',
        onReject: 'terminateRejected',
        onRequestChanges: 'incApprovalRetries',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Approve implementation before opening PR',
        type: 'humanApproval',
      },
      incApprovalRetries: {
        group: 'approval',
        next: 'checkApprovalLimit',
        title: 'Count the change request',
        type: 'set',
        values: { 'context.approvalRetries': { expr: 'context.approvalRetries + 1' } },
      },
      checkApprovalLimit: {
        expr: 'context.approvalRetries >= 3',
        group: 'approval',
        onFalse: 'approvalFix',
        onTrue: 'terminateRejected',
        title: 'Out of attempts?',
        type: 'cond',
      },
      approvalFix: {
        group: 'approval',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'nodes.approve.output.comment' },
        },
        next: 'updateCodeAfterApprovalFix',
        step: 'executeReviewFixImplementation',
        title: 'Fix the change the approver sent back',
        type: 'step',
      },
      updateCodeAfterApprovalFix: {
        group: 'approval',
        next: 'runTests',
        title: 'Keep the fixed code',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.approvalFix.output' } },
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
