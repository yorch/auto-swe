import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';
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
 * A review or CI loop that runs out of attempts, and a merge wait that times
 * out, stores a lesson about what happened before the run ends. A step that
 * throws — the security gate's SECURITY_GATE_FAILURE, any other implementation
 * error — fails the run where it stands, so no lesson is written for it. It
 * could be routed to one only by continuing past the failure (`onFail: 'warn'`,
 * then a `cond` on `nodes.<id>.error`), which gives up the run's typed failure
 * exit and leaves only `String(err)` — the SDK wrapper's message — as evidence.
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
      initCounters: initCounters('clearCiResult', { group: 'implement' }),
    },
    // ── Review loop, then CI loop; a CI fix re-enters the review via clearCiResult ──
    reviewLoop({
      afterFix: 'clearCiResult',
      approved: 'setAwaitingCi',
      exhausted: 'lessonReviewFailed',
    }),
    {
      setAwaitingCi: statusStamp('AWAITING_CI', 'openPR', { group: 'pull request' }),
    },
    // CI wait: signal (webhook, default) vs poll (active GitHub query)
    openPullRequest({ next: ciWaitEntry('pollOrSignal') }),
    ciLoop({
      exhausted: 'lessonCIFailed',
      fix: { handoff: { rereview: 'setReviewing' } },
      passed: 'setAwaitingHumanMerge',
      wait: 'pollOrSignal',
    }),
    {
      // A run that fails teaches as much as one that merges, so each loop's
      // last failure is stored as a lesson before the run ends. Best-effort:
      // a failed write never changes how the run ends.
      lessonReviewFailed: {
        group: 'review loop',
        inputs: { outcome: { literal: 'REVIEW_FAILED' } },
        next: 'terminateReviewFailed',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store what the review rejected',
        type: 'step',
      },
      lessonCIFailed: {
        group: 'CI loop',
        inputs: { outcome: { literal: 'CI_FAILED' } },
        next: 'terminateCIFailed',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store what failed CI',
        type: 'step',
      },
    },
    {
      // ── Wait for human merge, then memory + completion ──
      setAwaitingHumanMerge: statusStamp('AWAITING_HUMAN_MERGE', 'waitForHumanMerge', {
        group: 'human merge',
      }),
      waitForHumanMerge: {
        group: 'human merge',
        name: 'humanMergeSignal',
        onReceive: 'commitLesson',
        onTimeout: 'lessonMergeTimedOut',
        timeout: '7d',
        title: 'Wait for a person to merge',
        type: 'signal',
      },
      lessonMergeTimedOut: {
        group: 'human merge',
        inputs: { outcome: { literal: 'MERGE_TIMED_OUT' } },
        next: 'terminateMergeTimedOut',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store that nobody merged it',
        type: 'step',
      },
      terminateMergeTimedOut: terminate('TIMED_OUT', {
        group: 'human merge',
        result: {},
        title: 'Merge timed out',
      }),
      commitLesson: {
        group: 'human merge',
        inputs: { outcome: { literal: 'MERGED' } },
        next: 'done',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store the lesson',
        type: 'step',
      },
      // No COMPLETED status stamp ahead of `done`: finalizeWorkflowRun writes it when the run
      // ends SUCCESS.
      done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
