import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';
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
} from './templates/authoring/index.js';

/**
 * The seeded default-engineering template. Mirrors the hardcoded
 * EngineeringWorkflow shape exactly so the interpreter can run in parity
 * mode before any teams customize their workflows.
 *
 * Sequence:
 *   start → validate (non-blocking) → implement → review loop → CI loop →
 *   wait-for-human-merge → commit-to-memory → done
 *
 * Written with the authoring helpers, which expand at module load into the same
 * flat nodes (and the same node ids) this template has always had.
 */
export const DEFAULT_ENGINEERING_SPEC: WorkflowSpec = {
  description:
    'Implement a ticket in an isolated sandbox until the tests pass, run the security, ' +
    'domain-logic, and performance reviewers, open a pull request, fix CI failures from ' +
    'the logs, then wait for a person to merge. The lesson is stored for the next run.',
  entry: 'setValidating',
  name: 'default-engineering',
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
    initCounters: initCounters('clearCiResult', { group: 'implement' }),

    // ── Review loop, then CI loop; a CI fix re-enters the review via clearCiResult ──
    ...reviewLoop({ afterFix: 'clearCiResult', approved: 'setAwaitingCi' }),

    setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    // CI wait: signal (webhook, default) vs poll (active GitHub query)
    ...openPullRequest({ next: ciWaitEntry('pollOrSignal') }),
    ...ciLoop({
      fix: { handoff: { rereview: 'setReviewing' } },
      passed: 'setAwaitingHumanMerge',
      wait: 'pollOrSignal',
    }),

    // ── Wait for human merge, then memory + completion ──
    setAwaitingHumanMerge: statusStamp('AWAITING_HUMAN_MERGE', 'waitForHumanMerge', {
      group: 'human merge',
    }),
    waitForHumanMerge: {
      group: 'human merge',
      name: 'humanMergeSignal',
      onReceive: 'commitLesson',
      onTimeout: 'terminateMergeTimedOut',
      timeout: '7d',
      title: 'Wait for a person to merge',
      type: 'signal',
    },
    terminateMergeTimedOut: terminate('TIMED_OUT', {
      group: 'human merge',
      result: {},
      title: 'Merge timed out',
    }),
    commitLesson: {
      group: 'human merge',
      next: 'done',
      onError: 'continue',
      step: 'commitToMemory',
      title: 'Store the lesson',
      type: 'step',
    },
    // No COMPLETED status stamp ahead of `done`: finalizeWorkflowRun writes it when the run
    // ends SUCCESS.
    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
