import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, prResult, qodoReview, terminate } from './authoring/index.js';
import { ticketToMergeNodes } from './ticketToMerge.js';

/**
 * `ticket-to-merge` with Qodo's review between green CI and the merge wait. When CI passes, the
 * run waits for Qodo's review of the final head commit. A review with an open `action_required`
 * finding asks a person whether to continue to the merge wait or stop; every other result,
 * including a Qodo that is switched off or not installed on the repository, goes straight on.
 *
 * Qodo reviews each push, so the step waits until CI is green: the head no longer moves, and the
 * review it reads is of the commit a person would merge. The step only reads the review Qodo's
 * pull request bot produces, so it does nothing useful where that bot is not installed.
 *
 * The person's choice ends the run on purpose. Continue goes to the merge wait with the finding
 * still open on the pull request. Stop ends the run FAILED, as `security-triage` does for an
 * abandoned scan, and no answer within a day ends it TIMED_OUT, as an unmerged pull request does.
 * Neither end stores a lesson: a lesson outcome says what the run's own review or CI learned, and
 * a finding from Qodo's review is neither.
 */
export const TICKET_TO_MERGE_QODO_SPEC: WorkflowSpec = {
  description:
    'ticket-to-merge, with a Qodo review of the final commit once CI is green: a review with an ' +
    'open action_required finding asks a person to continue or stop, and anything else goes on ' +
    'to the merge wait. It does nothing while qodo.enabled is off. With it on, a repository ' +
    'without the Qodo pull request bot waits the configured Qodo review wait on every run.',
  entry: 'setValidating',
  name: 'ticket-to-merge-qodo',
  nodes: mergeNodes(
    ticketToMergeNodes('qodoReview'),
    qodoReview({ next: 'setAwaitingHumanMerge', onBlocked: 'qodoDecision' }),
    {
      qodoDecision: {
        description:
          "Qodo's review of the final commit has an open action_required finding. Continue to the " +
          'merge wait, or stop the run.',
        group: 'Qodo review',
        onTimeout: 'terminateQodoTimedOut',
        options: [
          { label: 'Continue to the merge wait', next: 'setAwaitingHumanMerge', value: 'continue' },
          { label: 'Stop the run', next: 'terminateQodoStopped', value: 'stop' },
        ],
        storeAs: 'context.qodoChoice',
        timeout: '24h',
        title: 'Qodo found a blocking issue. Continue anyway?',
        type: 'humanDecision',
      },
      terminateQodoStopped: terminate('FAILED', {
        group: 'Qodo review',
        result: prResult(),
        title: 'Stopped after Qodo review',
      }),
      terminateQodoTimedOut: terminate('TIMED_OUT', {
        group: 'Qodo review',
        result: prResult(),
        title: 'Nobody answered about the Qodo review',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
