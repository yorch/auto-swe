import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciWaitEntry,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
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
  entry: 'validate',
  name: 'approve-before-pr',
  nodes: mergeNodes(
    validatePhase({ next: 'implement', successCriteria: false }),
    {
      implement: {
        group: 'implement',
        next: 'runTests',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      runTests: qualityGate('runTests', 'approve', { group: 'verify' }),
      approve: {
        description:
          'Tests passed. Approve to open the PR, request changes (with a note) to send it ' +
          'back for a fix, or reject to discard.',
        group: 'approval',
        onApprove: 'openPR',
        onReject: 'terminateRejected',
        onRequestChanges: 'approvalFix',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Approve implementation before opening PR',
        type: 'humanApproval',
      },
      // The third change request fails the run: the fixer is entered twice at most.
      approvalFix: {
        group: 'approval',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'nodes.approve.output.comment' },
        },
        maxVisits: 2,
        next: 'runTests',
        onExhausted: 'terminateRejected',
        step: 'executeReviewFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Fix the change the approver sent back',
        type: 'step',
      },
      terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
      terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),
    },
    openPullRequest({ next: ciWaitEntry(), status: 'AWAITING_CI' }),
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
