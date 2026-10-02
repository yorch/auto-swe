import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
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
 */
export const FOUR_EYES_SPEC: WorkflowSpec = {
  description:
    'Implement, run the agent review loop, then require two sequential human approvals ' +
    '(e.g. author sign-off followed by independent reviewer sign-off) before opening the PR. ' +
    'Models a four-eyes / two-person-rule change-management requirement.',
  entry: 'setValidating',
  name: 'four-eyes',
  nodes: {
    ...validatePhase({ next: 'setImplementing' }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'initCounters',
      step: 'executeImplementation',
      title: 'Implement the ticket',
      type: 'step',
    },
    initCounters: initCounters('setReviewing', { ci: false, group: 'implement' }),

    ...reviewLoop({ approved: 'firstSignoff' }),

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
    ...openPullRequest({ next: ciWaitEntry() }),
    // A bare CI gate: this template does not loop on CI failures.
    ...ciLoop({ fix: false, passed: 'setCompleted' }),

    setCompleted: statusStamp('COMPLETED', 'done', { group: 'finish' }),
    done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
