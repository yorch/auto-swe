import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  CI_ATTEMPTS_PATH,
  ciLoop,
  ciWaitEntry,
  failureLesson,
  mergeNodes,
  openPullRequest,
  prResult,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * Two independent agent review network calls run in parallel via fanOut, on code
 * that is already green. Both must approve (failed == 0) for the run to succeed.
 *
 * Order: implement, open the pull request (ready for review: the
 * `createOrUpdatePullRequest` step's `draft` option is left at its default, off), wait for CI and fix a failing
 * CI (2 fix attempts, a third failure fails the run), then the two-reviewer consensus
 * on the code that passed CI. The implementer's fix session pushes its own commit, so
 * the `repushAfterFix` step only re-arms the PR's CI wait, seconds later.
 *
 * If either reviewer rejects, the agent fixes (the fix session pushes), CI runs again
 * with a fresh CI budget, and both reviewers run again on the new code. Up to 3
 * consensus attempts in all. The reviewers are agents whose rejection text feeds the fix,
 * so there is no human rejection to ask a reason of. A fix that changes nothing makes no
 * commit and no CI event would follow, so the unchanged code goes straight back to the
 * reviewers; the rejection was already counted, so repeated no-ops hit the same limit.
 *
 * Demonstrates: fanOut for quality aggregation (not work splitting),
 * with onBranchFail: 'continue' so a single rejection doesn't abort early.
 */
export const CONSENSUS_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Implement the change, open the pull request and wait for CI (a failing CI is fixed by ' +
    'the agent: 2 fix attempts, and a third failure fails the run). Then two independent ' +
    'agent reviewers check the code that passed CI at the same time. Both must approve; if ' +
    'either rejects, the agent addresses the combined feedback, CI runs again, and both ' +
    'reviewers look again (up to 3 rounds). Use it when you want two independent opinions ' +
    'before a person sees the pull request.',
  entry: 'validate',
  name: 'consensus-review',
  nodes: mergeNodes(
    {
      // ── Branch nodes (run inside fanOut) ─────────────────────────────────
      branchApproved: terminate('SUCCESS', { group: 'reviewer branch', title: 'Branch approved' }),
      branchRejected: terminate('FAILED', { group: 'reviewer branch', title: 'Branch rejected' }),
      checkBranchApproval: {
        expr: 'nodes.runBranchReview.output.approved == true',
        group: 'reviewer branch',
        onFalse: 'storeBranchRejection',
        onTrue: 'branchApproved',
        title: 'Approved?',
        type: 'cond',
      },
      runBranchReview: {
        group: 'reviewer branch',
        inputs: {
          codeResult: { from: 'context.currentCodeResult' },
          successCriteria: { from: 'context.successCriteria' },
        },
        next: 'checkBranchApproval',
        step: 'runReviewNetwork',
        title: 'Review network (one reviewer slot)',
        type: 'step',
      },
      storeBranchRejection: {
        group: 'reviewer branch',
        next: 'branchRejected',
        title: 'Record why it was rejected',
        type: 'set',
        values: {
          'context.branchRejectionSummary': {
            default: '',
            from: 'nodes.runBranchReview.output.rejectionSummary',
          },
        },
      },
    },
    // ── Main graph ────────────────────────────────────────────────────────
    validatePhase({ next: 'implement' }),
    {
      implement: {
        group: 'implement',
        next: 'openPR',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Implement the ticket',
        type: 'step',
      },
      // The consensus review: two reviewer slots, both must approve.
      fanOutReview: {
        // Two reviewer slots — each branch runs runBranchReview independently.
        concurrency: 2,
        exports: ['context.branchRejectionSummary'],
        group: 'consensus review',
        itemKey: 'reviewerSlot',
        join: 'storeConsensusResult',
        onBranchFail: 'continue',
        over: { literal: [{ id: 1 }, { id: 2 }] },
        // CI passed: the reviewers see exactly the code that is on the pull request.
        status: 'IN_REVIEW',
        subgraph: 'runBranchReview',
        title: 'Run both reviewers',
        type: 'fanOut',
      },
      storeConsensusResult: {
        group: 'consensus review',
        next: 'checkConsensus',
        title: 'Keep the verdicts',
        type: 'set',
        values: { 'context.fanOutReview': { from: 'nodes.fanOutReview.output' } },
      },
      checkConsensus: {
        expr: 'nodes.fanOutReview.output.failed == 0',
        group: 'consensus review',
        onFalse: 'storeLastRejection',
        onTrue: 'done',
        title: 'Both approved?',
        type: 'cond',
      },
      storeLastRejection: {
        group: 'consensus review',
        next: 'consensusFix',
        title: 'Record why it was rejected',
        type: 'set',
        values: {
          'context.lastRejectionSummary': {
            default: 'One or more reviewers rejected the implementation.',
            from: 'context.fanOutReview.results',
          },
        },
      },
      // The third rejection ends the run: the fixer is entered twice at most.
      consensusFix: {
        group: 'consensus review',
        inputs: {
          previousCodeResult: { from: 'context.currentCodeResult' },
          rejectionSummary: { from: 'context.lastRejectionSummary' },
        },
        maxVisits: 2,
        next: 'checkConsensusFixChanged',
        onExhausted: 'lessonReviewFailed',
        step: 'executeReviewFixImplementation',
        title: 'Fix the review findings',
        type: 'step',
      },
      checkConsensusFixChanged: {
        // `context.currentCodeResult` still holds the green head the reviewers rejected; it is
        // replaced by `updateCodeAfterFix`, which only a changed fix reaches. An unchanged fix
        // makes no commit, so no CI event would come: the reviewers see the same code again,
        // and the rejection was already counted, so repeated no-ops hit the attempt limit.
        expr: 'nodes.consensusFix.output.headSha == context.currentCodeResult.headSha',
        group: 'consensus review',
        onFalse: 'updateCodeAfterFix',
        onTrue: 'fanOutReview',
        title: 'Did the fix change nothing?',
        type: 'cond',
      },
      updateCodeAfterFix: {
        group: 'consensus review',
        next: 'repushAfterFix',
        title: 'Keep the fixed code and reset the CI attempts',
        type: 'set',
        values: {
          [CI_ATTEMPTS_PATH]: { literal: 0 },
          'context.currentCodeResult': { from: 'nodes.consensusFix.output' },
        },
      },
      // A consensus that runs out of attempts stores what the reviewers rejected before the
      // run fails. The rejection is the last round's per-branch results, read as text.
      lessonReviewFailed: failureLesson('REVIEW_FAILED', 'terminateReviewFailed', {
        group: 'consensus review',
      }),
      terminateReviewFailed: terminate('FAILED', {
        group: 'consensus review',
        result: prResult(),
        title: 'Review failed',
      }),
    },
    openPullRequest({ next: ciWaitEntry(), status: 'AWAITING_CI' }),
    // The pull request is open, so a CI fix is pushed by the fix session itself and
    // `repushAfterFix` only re-arms the CI wait for the new head. The reviewers run after.
    // A CI fix that changed nothing is counted as a spent attempt instead of waiting.
    ciLoop({
      exhausted: 'lessonCIFailed',
      fix: {
        handoff: { repush: 'repushAfterFix', status: 'AWAITING_CI' },
        retryIfUnchanged: true,
      },
      passed: 'fanOutReview',
    }),
    {
      lessonCIFailed: failureLesson('CI_FAILED', 'terminateCIFailed', { group: 'CI loop' }),
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
