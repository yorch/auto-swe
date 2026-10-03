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

/** What the fix session is told when the reviewer gives no reason. */
const GENERIC_REJECTION =
  'A human reviewer rejected this change at sign-off and left no written reason. ' +
  'Re-check it against the success criteria and the pull request description.';

/**
 * Two-person rule: two independent humanApproval gates, asked about code that is
 * already green.
 *
 * Order: implement, agent review loop, open the pull request (ready for review:
 * the `createOrUpdatePullRequest` step has no draft option), wait for CI and fix a
 * failing CI (2 fix attempts, a third failure fails the run), and only then ask the
 * two humans. The implementer's fix session pushes its own commit, so no human has
 * signed off when a CI fix lands and there is no approval for it to invalidate; the
 * `repushAfterFix` step re-arms the PR's CI wait right after (only a status update
 * runs in between on the sign-off path).
 *
 * A rejection asks the reviewer for a reason (a short `humanInput`, 1 h; a skipped or
 * timed-out question falls back to generic text), then goes to a fix (the review fix
 * session, which pushes), CI again with a fresh CI budget, and BOTH gates again. Each
 * round creates new pending human steps, so an approval never carries over to
 * different code. A third rejection fails the run.
 *
 * A fix that changes nothing makes no commit, so the head stays the one CI already
 * passed and no new CI event would ever arrive. The run therefore does not wait for CI
 * again: the same code goes back to both people with `noChangeMade` set in what they
 * are shown. The rejection was already counted, so repeated no-ops end in the same
 * third-rejection failure.
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, open the PR and wait for CI (a failing CI is ' +
    'fixed by the agent: 2 fix attempts, and a third failure fails the run), then require two ' +
    'sequential human approvals (e.g. author sign-off followed by independent reviewer sign-off) ' +
    'on the code that passed CI. A rejection asks for a reason, sends the change back for a fix ' +
    'and through CI again (2 fix attempts, a third rejection fails the run), and both people ' +
    'sign off again. A fix that changes nothing goes straight back to the two people, marked as ' +
    'unchanged. Models a four-eyes / two-person-rule change-management requirement.',
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
    // `repushAfterFix` only re-arms the CI wait for the new head. A fix that changed
    // nothing is counted as a spent attempt instead of waiting for a CI event that
    // cannot come.
    ciLoop({
      fix: { handoff: { repush: 'repushAfterFix' }, retryIfUnchanged: true },
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
          'context.signoffContext.changedSinceLastSignoff': { expr: 'context.signoffRetries > 0' },
          'context.signoffContext.ciPassed': { literal: true },
          'context.signoffContext.headSha': { from: 'context.currentCodeResult.headSha' },
          'context.signoffContext.noChangeMade': { literal: false },
          'context.signoffContext.prUrl': { from: 'context.prUrl' },
          'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
          'context.signoffRejection': { literal: null },
          'context.signoffRejectionSummary': { literal: GENERIC_REJECTION },
        },
      },
      // The fix changed nothing: the same green code, shown again and marked as unchanged.
      storeSignoffContextUnchanged: {
        group: 'approval',
        next: 'firstSignoff',
        title: 'Show the approvers the unchanged code',
        type: 'set',
        values: {
          'context.signoffContext.changedSinceLastSignoff': { literal: false },
          'context.signoffContext.noChangeMade': { literal: true },
          'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
          'context.signoffRejection': { literal: null },
          'context.signoffRejectionSummary': { literal: GENERIC_REJECTION },
        },
      },
      firstSignoff: {
        contextFrom: 'context.signoffContext',
        description:
          'CI has passed on the head commit in the context, and the pull request is open. ' +
          'Confirm you have read the implementation and are satisfied it meets the requirements. ' +
          'If rejectedBefore is above 0 this is a repeat round and both people sign off again: ' +
          'changedSinceLastSignoff says whether the code changed, and noChangeMade means the ' +
          'fix made no change and this is the code that was rejected before.',
        group: 'approval',
        onApprove: 'secondSignoff',
        onReject: 'askRejectionReason',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'First sign-off — author / team-lead review',
        type: 'humanApproval',
      },
      secondSignoff: {
        contextFrom: 'context.signoffContext',
        description:
          'You are a second, independent reviewer. CI has passed on the head commit in the ' +
          'context. Confirm the change is safe to merge. If rejectedBefore is above 0 this is a ' +
          'repeat round and the first reviewer has signed off again: changedSinceLastSignoff ' +
          'says whether the code changed, and noChangeMade means the fix made no change.',
        group: 'approval',
        onApprove: 'done',
        onReject: 'askRejectionReason',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Second sign-off — independent reviewer',
        type: 'humanApproval',
      },
      // ── A rejection: ask why, fix, CI again, both sign-offs again ───────
      askRejectionReason: {
        description:
          'Say what should change. The fix is told this. Leave it empty or let it time out ' +
          'and the fix gets only the fact that the change was rejected.',
        fields: [{ key: 'reason', label: 'What should change?', required: false, type: 'text' }],
        group: 'approval',
        onSubmit: 'checkRejectionReason',
        onTimeout: 'incSignoffRetries',
        storeAs: 'context.signoffRejection',
        timeout: '1h',
        title: 'Why was it rejected?',
        type: 'humanInput',
      },
      checkRejectionReason: {
        expr: "(context.signoffRejection.value.reason ?? '') != ''",
        group: 'approval',
        onFalse: 'incSignoffRetries',
        onTrue: 'keepRejectionReason',
        title: 'Was a reason given?',
        type: 'cond',
      },
      keepRejectionReason: {
        group: 'approval',
        next: 'incSignoffRetries',
        title: 'Keep the reason for the fix',
        type: 'set',
        values: {
          'context.signoffRejectionSummary': { from: 'context.signoffRejection.value.reason' },
        },
      },
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
          rejectionSummary: { from: 'context.signoffRejectionSummary' },
        },
        next: 'checkSignoffFixChanged',
        step: 'executeReviewFixImplementation',
        title: 'Fix the change a reviewer rejected',
        type: 'step',
      },
      checkSignoffFixChanged: {
        // `context.currentCodeResult` still holds the green head the people rejected; it is
        // replaced by `updateCodeAfterSignoffFix`, which only a changed fix reaches.
        expr: 'nodes.signoffFix.output.headSha == context.currentCodeResult.headSha',
        group: 'approval',
        onFalse: 'updateCodeAfterSignoffFix',
        onTrue: 'storeSignoffContextUnchanged',
        title: 'Did the fix change nothing?',
        type: 'cond',
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
