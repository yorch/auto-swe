import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { ciWaitEntry, failureLesson, prResult, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

/**
 * Automated agent review loop → PR → CI. No HITL, and the run ends when CI is
 * green rather than waiting for a human merge. A faster alternative to
 * ticket-to-merge when human sign-off inside the run is not required.
 */
export const AGENT_REVIEWED_PR_SPEC: WorkflowSpec = {
  description:
    'Implement the change, have the review agents check it (up to 3 attempts), open a pull ' +
    'request, then wait for CI. No human approval steps, and it never merges: the run ends ' +
    'when CI is green and the pull request waits for a person. Use this when the agent ' +
    'review is a sufficient quality gate before a pull request.',
  entry: 'validate',
  name: 'agent-reviewed-pr',
  ...authored(
    macro('validate', 'validatePhase@1', { next: 'implement' }),
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
    macro('review', 'reviewLoop@1', { approved: 'openPR', exhausted: 'lessonReviewFailed' }),
    macro('pr', 'openPullRequest@1', { next: ciWaitEntry(), status: 'AWAITING_CI' }),
    macro('ci', 'ciLoop@1', {
      exhausted: 'lessonCIFailed',
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'done',
    }),
    {
      // A loop that runs out of attempts stores what blocked it before the run fails.
      lessonReviewFailed: failureLesson('REVIEW_FAILED', 'terminateReviewFailed', {
        group: 'review loop',
      }),
      lessonCIFailed: failureLesson('CI_FAILED', 'terminateCIFailed', { group: 'CI loop' }),
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
