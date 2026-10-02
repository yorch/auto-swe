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
 * Automated agent review loop → PR → CI. No HITL, and the run ends when CI is
 * green rather than waiting for a human merge. A faster alternative to
 * default-engineering when human sign-off inside the run is not required.
 *
 * Seeded as `review-and-merge` before it was renamed, a name that suggested it
 * merges — nothing the platform ships does. `syncBuiltins` renames that row in
 * place (see `RENAMED_TEMPLATES`), so its history and overrides carry over.
 */
export const AGENT_REVIEWED_PR_SPEC: WorkflowSpec = {
  description:
    'Implement, run the automated review network (up to 3 attempts), open a PR, ' +
    'then wait for CI. No human approval steps, and it never merges: the run ends ' +
    'when CI is green and the pull request waits for a person. Use this when the ' +
    'agent review loop is a sufficient quality gate before a PR.',
  entry: 'setValidating',
  name: 'agent-reviewed-pr',
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
    initCounters: initCounters('setReviewing', { group: 'implement' }),

    ...reviewLoop({ approved: 'setAwaitingCi' }),

    setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    ...openPullRequest({ next: ciWaitEntry() }),
    ...ciLoop({
      fix: { handoff: { repush: 'repushAfterCIFix' } },
      passed: 'done',
    }),

    done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
