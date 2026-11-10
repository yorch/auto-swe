import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  CI_ATTEMPTS_PATH,
  ciLoop,
  ciWaitEntry,
  failureLesson,
  mergeNodes,
  openPullRequest,
  prResult,
  reviewLoop,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Two-person rule: two independent humanApproval gates, asked about code that is
 * already green.
 *
 * Order: implement, agent review loop, open the pull request (ready for review:
 * the `createOrUpdatePullRequest` step's `draft` option is left at its default, off), wait for CI and fix a
 * failing CI (2 fix attempts, a third failure fails the run), and only then ask the
 * two humans. The implementer's fix session pushes its own commit, so no human has
 * signed off when a CI fix lands and there is no approval for it to invalidate; the
 * `repushAfterFix` step re-arms the PR's CI wait right after (only a status update
 * runs in between on the sign-off path).
 *
 * A rejection stops the run. Requesting changes — which needs a written reason —
 * goes to a fix (the review fix session, which pushes, and is told the reason), CI
 * again with a fresh CI budget, and BOTH gates again. Each round creates new pending
 * human steps, so an approval never carries over to different code. A third change
 * request fails the run.
 *
 * A fix that changes nothing makes no commit, so the head stays the one CI already
 * passed and no new CI event would ever arrive. The run therefore does not wait for CI
 * again: the same code goes back to both people with `noChangeMade` set in what they
 * are shown. The change request was already counted, so repeated no-ops end in the
 * same third-request failure.
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, open the PR and wait for CI (a failing CI is ' +
    'fixed by the agent: 2 fix attempts, and a third failure fails the run), then require two ' +
    'sequential human approvals (e.g. author sign-off followed by independent reviewer sign-off) ' +
    'on the code that passed CI. Requesting changes — with a required note — sends the change ' +
    'back for a fix and through CI again (2 fix attempts, a third change request fails the run), ' +
    'and both people sign off again; rejecting stops the run. A fix that changes nothing goes ' +
    'straight back to the two people, marked as unchanged. Models a four-eyes / two-person-rule ' +
    'change-management requirement.',
  entry: 'validate',
  name: 'four-eyes',
  nodes: mergeNodes(
    validatePhase({ next: 'implement' }),
    {
      implement: {
        group: 'implement',
        next: 'review',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
    },
    reviewLoop({ approved: 'openPR', exhausted: 'lessonReviewFailed' }),
    openPullRequest({ next: ciWaitEntry(), status: 'AWAITING_CI' }),
    // The pull request is open, so a CI fix is pushed by the fix session itself and
    // `repushAfterFix` only re-arms the CI wait for the new head. A fix that changed
    // nothing is counted as a spent attempt instead of waiting for a CI event that
    // cannot come.
    ciLoop({
      exhausted: 'lessonCIFailed',
      fix: {
        handoff: { repush: 'repushAfterFix', status: 'AWAITING_CI' },
        retryIfUnchanged: true,
      },
      passed: 'storeSignoffContext',
    }),
    {
      // The agent review and CI loops store what blocked them before the run fails. The
      // sign-off loop does not: its rejections are people's, often with no written reason,
      // and a REVIEW_FAILED lesson tells the writer the review network rejected the change.
      lessonReviewFailed: failureLesson('REVIEW_FAILED', 'terminateReviewFailed', {
        group: 'review loop',
      }),
      lessonCIFailed: failureLesson('CI_FAILED', 'terminateCIFailed', { group: 'CI loop' }),
      storeSignoffContext: {
        group: 'approval',
        next: 'firstSignoff',
        // `nodes.signoffFix.visits` is the number of change requests sent back so far.
        status: 'IN_REVIEW',
        title: 'Show the approvers the green change',
        type: 'set',
        values: {
          'context.signoffContext.changedSinceLastSignoff': {
            expr: '(nodes.signoffFix.visits ?? 0) > 0',
          },
          'context.signoffContext.ciPassed': { literal: true },
          'context.signoffContext.headSha': { from: 'context.currentCodeResult.headSha' },
          'context.signoffContext.noChangeMade': { literal: false },
          'context.signoffContext.prUrl': { from: 'context.prUrl' },
          'context.signoffContext.rejectedBefore': { default: 0, from: 'nodes.signoffFix.visits' },
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
          'context.signoffContext.rejectedBefore': { default: 0, from: 'nodes.signoffFix.visits' },
        },
      },
      firstSignoff: {
        contextFrom: 'context.signoffContext',
        description:
          'CI has passed on the head commit in the context, and the pull request is open. ' +
          'Confirm you have read the implementation and are satisfied it meets the requirements. ' +
          'If rejectedBefore is above 0 this is a repeat round and both people sign off again: ' +
          'changedSinceLastSignoff says whether the code changed, and noChangeMade means the ' +
          'fix made no change and this is the code that was sent back before. Approve to move to ' +
          'the second sign-off, request changes (with a note) to send it back for a fix, or ' +
          'reject to stop the run.',
        group: 'approval',
        onApprove: 'secondSignoff',
        onReject: 'terminateRejected',
        onRequestChanges: 'noteFirstSignoffChanges',
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
          'says whether the code changed, and noChangeMade means the fix made no change. ' +
          'Approve to finish, request changes (with a note) to send it back for a fix, or ' +
          'reject to stop the run.',
        group: 'approval',
        onApprove: 'done',
        onReject: 'terminateRejected',
        onRequestChanges: 'noteSecondSignoffChanges',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Second sign-off — independent reviewer',
        type: 'humanApproval',
      },
      // ── A change request: keep the note, fix, CI again, both sign-offs again ──
      noteFirstSignoffChanges: {
        group: 'approval',
        next: 'signoffFix',
        title: 'Keep the requested changes',
        type: 'set',
        values: {
          'context.signoffRejectionSummary': { from: 'nodes.firstSignoff.output.comment' },
        },
      },
      noteSecondSignoffChanges: {
        group: 'approval',
        next: 'signoffFix',
        title: 'Keep the requested changes',
        type: 'set',
        values: {
          'context.signoffRejectionSummary': { from: 'nodes.secondSignoff.output.comment' },
        },
      },
      // The third change request fails the run: the fixer is entered twice at most.
      signoffFix: {
        group: 'approval',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'context.signoffRejectionSummary' },
        },
        maxVisits: 2,
        next: 'checkSignoffFixChanged',
        onExhausted: 'terminateRejected',
        step: 'executeReviewFixImplementation',
        title: 'Fix the change a reviewer sent back',
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
        next: 'repushAfterFix',
        title: 'Keep the fixed code and reset the CI attempts',
        type: 'set',
        values: {
          [CI_ATTEMPTS_PATH]: { literal: 0 },
          'context.currentCodeResult': { from: 'nodes.signoffFix.output' },
        },
      },
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
