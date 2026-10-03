import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
  mergeNodes,
  openPullRequest,
  prResult,
  reviewLoop,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Two-person rule: two independent humanApproval gates, asked about code that is
 * already green.
 *
 * Order: implement, agent review loop, open the pull request (ready for review:
 * the `createOrUpdatePullRequest` step has no draft option), wait for CI and fix a
 * failing CI (2 fix attempts, a third failure fails the run), and only then ask the
 * two humans. The implementer's fix session pushes its own commit, so no human has
 * signed off when a CI fix lands and there is no approval for it to invalidate; the
 * `repushAfterFix` step re-arms the PR's CI wait seconds later.
 *
 * A rejection goes to a fix (the review fix session, which pushes), then CI again
 * with a fresh CI budget, then BOTH gates again. Each round creates new pending
 * human steps, so an approval never carries over to different code. A third
 * rejection fails the run. `humanApproval` carries no written reason, so the fix
 * session is told only that a reviewer rejected the change.
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, open the PR and wait for CI (a failing CI is ' +
    'fixed by the agent: 2 fix attempts, and a third failure fails the run), then require two ' +
    'sequential human approvals (e.g. author sign-off followed by independent reviewer sign-off) ' +
    'on the code that passed CI. A rejection sends the change back for a fix and through CI ' +
    'again (2 fix attempts, a third rejection fails the run), and both people sign off again. ' +
    'Models a four-eyes / two-person-rule change-management requirement.',
  entry: 'setValidating',
  name: 'four-eyes',
  nodes: mergeNodes(
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
      initCounters: initCounters('setReviewing', {
        counters: ['context.signoffRetries'],
        group: 'implement',
      }),
    },
    reviewLoop({ approved: 'setAwaitingCi' }),
    {
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    openPullRequest({ next: ciWaitEntry() }),
    // The pull request is open, so a CI fix is pushed by the fix session itself and
    // `repushAfterFix` only re-arms the CI wait for the new head.
    ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' } },
      passed: 'setAwaitingSignoff',
    }),
    {
      setAwaitingSignoff: statusStamp('IN_REVIEW', 'storeSignoffContext', { group: 'approval' }),
      storeSignoffContext: {
        group: 'approval',
        next: 'firstSignoff',
        title: 'Show the approvers the green change',
        type: 'set',
        values: {
          'context.signoffContext.changedSinceLastSignoff': {
            expr: 'context.signoffRetries > 0',
          },
          'context.signoffContext.ciPassed': { literal: true },
          'context.signoffContext.headSha': { from: 'context.currentCodeResult.headSha' },
          'context.signoffContext.prUrl': { from: 'context.prUrl' },
          'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
        },
      },
      firstSignoff: {
        contextFrom: 'context.signoffContext',
        description:
          'CI has passed on the head commit in the context, and the pull request is open. ' +
          'Confirm you have read the implementation and are satisfied it meets the requirements. ' +
          'If rejectedBefore is above 0, the code changed after an earlier rejection: earlier ' +
          'sign-offs do not apply and both people sign off again.',
        group: 'approval',
        onApprove: 'secondSignoff',
        onReject: 'incSignoffRetries',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'First sign-off — author / team-lead review',
        type: 'humanApproval',
      },
      secondSignoff: {
        contextFrom: 'context.signoffContext',
        description:
          'You are a second, independent reviewer. CI has passed on the head commit in the ' +
          'context. Confirm the change is safe to merge. If rejectedBefore is above 0, the code ' +
          'changed after an earlier rejection and the first reviewer has signed off on it again.',
        group: 'approval',
        onApprove: 'done',
        onReject: 'incSignoffRetries',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Second sign-off — independent reviewer',
        type: 'humanApproval',
      },
      // ── A rejection: fix, CI again, both sign-offs again ────────────────
      incSignoffRetries: {
        group: 'approval',
        next: 'checkSignoffLimit',
        title: 'Count the rejection',
        type: 'set',
        values: { 'context.signoffRetries': { expr: 'context.signoffRetries + 1' } },
      },
      checkSignoffLimit: {
        expr: 'context.signoffRetries >= 3',
        group: 'approval',
        onFalse: 'signoffFix',
        onTrue: 'terminateRejected',
        title: 'Out of attempts?',
        type: 'cond',
      },
      signoffFix: {
        group: 'approval',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: {
            literal:
              'A human reviewer rejected this change at sign-off and left no written reason. ' +
              'Re-check it against the success criteria and the pull request description.',
          },
        },
        next: 'updateCodeAfterSignoffFix',
        step: 'executeReviewFixImplementation',
        title: 'Fix the change a reviewer rejected',
        type: 'step',
      },
      updateCodeAfterSignoffFix: {
        group: 'approval',
        next: 'setAwaitingCiAfterSignoff',
        title: 'Keep the fixed code and reset the CI attempts',
        type: 'set',
        values: {
          'context.ciRetries': { literal: 0 },
          'context.currentCodeResult': { from: 'nodes.signoffFix.output' },
        },
      },
      setAwaitingCiAfterSignoff: statusStamp('AWAITING_CI', 'repushAfterFix', {
        group: 'approval',
      }),
      terminateRejected: terminate('FAILED', {
        group: 'approval',
        result: prResult(),
        title: 'Rejected',
      }),
      terminateTimedOut: terminate('TIMED_OUT', {
        group: 'approval',
        result: prResult(),
        title: 'Approval timed out',
      }),
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
