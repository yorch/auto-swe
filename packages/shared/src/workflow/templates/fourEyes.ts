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
 * Two-person rule: two independent humanApproval gates before the PR opens.
 * Models a change-management process where the author (or team lead) signs off
 * first, then a second independent reviewer must also approve.
 *
 * CI runs after the sign-offs. A failing CI is fixed by the agent (up to 3 times, like
 * default-engineering); the fix re-enters the review loop and both sign-offs, then updates
 * the pull request, so the approvals always describe the code that is pushed.
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, then require two sequential human approvals ' +
    '(e.g. author sign-off followed by independent reviewer sign-off) before opening the PR. ' +
    'Then wait for CI; a CI failure is fixed by the agent (up to 3 times) and the fix goes back ' +
    'through the review and both sign-offs before the PR is updated. ' +
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
      initCounters: initCounters('setReviewing', { group: 'implement' }),
    },
    reviewLoop({ approved: 'firstSignoff' }),
    {
      firstSignoff: {
        description:
          'Confirm you have read the implementation and are satisfied it meets the requirements.',
        group: 'approval',
        onApprove: 'secondSignoff',
        onReject: 'terminateRejected',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'First sign-off — author / team-lead review',
        type: 'humanApproval',
      },
      secondSignoff: {
        description: 'You are a second, independent reviewer. Confirm the change is safe to merge.',
        group: 'approval',
        onApprove: 'setAwaitingCi',
        onReject: 'terminateRejected',
        onTimeout: 'terminateTimedOut',
        timeout: '24h',
        title: 'Second sign-off — independent reviewer',
        type: 'humanApproval',
      },
      terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
      terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    openPullRequest({ next: ciWaitEntry() }),
    // A CI failure is fixed and the fixed code goes back through the agent review and BOTH
    // sign-offs before it is pushed, so no approval ever covers code it did not see.
    ciLoop({ fix: { handoff: { rereview: 'setReviewing' } }, passed: 'done' }),
    {
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
