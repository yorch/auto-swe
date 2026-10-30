import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  initCounters,
  mergeNodes,
  type NodeMap,
  openPullRequest,
  prResult,
  reviewLoop,
  statusStamp,
  terminate,
  validatePhase,
} from './authoring/index.js';

/**
 * The seeded ticket-to-merge template, and the global default: a ticket in, a
 * reviewed pull request out, and the run ends when a person merges it. Unlike
 * `agent-reviewed-pr`, which stops at green CI, it waits for that merge and
 * stores a lesson about the run.
 *
 * Sequence:
 *   start → gather ticket (non-blocking) → validate (non-blocking) → implement →
 *   review loop → CI loop →
 *   wait-for-human-merge → commit-to-memory → done
 *
 * A request validation cannot act on (every criterion it found is an `AMBIGUOUS:` entry, as
 * when the description is only a link the gatherer could not read) ends the run FAILED at
 * `terminateNotActionable`, before `implement` spends a budget guessing. A request with a real
 * description is never stopped by an unreachable ticket: only validation's verdict stops a run.
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
export const TICKET_TO_MERGE_SPEC: WorkflowSpec = {
  description:
    'Implement a ticket in an isolated sandbox until the tests pass, run the security, ' +
    'domain-logic, and performance reviewers, open a pull request, fix CI failures from ' +
    'the logs, then wait for a person to merge. The lesson is stored for the next run.',
  entry: 'setValidating',
  name: 'ticket-to-merge',
  nodes: ticketToMergeNodes('setAwaitingHumanMerge', { uiVerify: true }),
  schemaVersion: SPEC_SCHEMA_VERSION,
};

/**
 * The ticket-to-merge node graph, as a function of where the CI loop goes when CI passes.
 * `ticket-to-merge` hands off to the merge wait; a template that checks something between green CI
 * and the merge wait passes its own first node and adds the nodes it needs beside the result.
 */
export function ticketToMergeNodes(passed: string, options: { uiVerify?: boolean } = {}): NodeMap {
  return mergeNodes(
    validatePhase({ next: 'setImplementing', stopIfNotActionable: true, ticketContext: true }),
    {
      implement: {
        group: 'implement',
        // The gatherer's digest of the run's tracker ticket (`''` when the run has none).
        inputs: {
          // What `validate` extracted, ambiguity entries included: the implementer is told what
          // done means and which questions are open, and does not guess at them.
          successCriteria: { default: [], from: 'context.successCriteria' },
          ticket: { from: 'context.ticket' },
        },
        next: options.uiVerify ? 'uiVerify' : 'initCounters',
        step: 'executeImplementation',
        title: 'Implement the ticket',
        type: 'step',
      },
      ...(options.uiVerify
        ? {
            uiVerify: {
              group: 'implement',
              next: 'initCounters',
              onFail: 'warn' as const,
              step: 'uiVerify',
              title: 'Verify the app preview',
              type: 'step' as const,
            },
          }
        : {}),
      initCounters: initCounters('clearCiResult', { group: 'implement' }),
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
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
      passed,
      wait: 'pollOrSignal',
    }),
    {
      lessonCIFailed: {
        group: 'CI loop',
        inputs: { outcome: { literal: 'CI_FAILED' } },
        next: 'terminateCIFailed',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store what failed CI',
        type: 'step',
      },
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
    },
    {
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
      lessonMergeTimedOut: {
        group: 'human merge',
        inputs: { outcome: { literal: 'MERGE_TIMED_OUT' } },
        next: 'terminateMergeTimedOut',
        onError: 'continue',
        step: 'commitToMemory',
        title: 'Store that nobody merged it',
        type: 'step',
      },
      // ── Wait for human merge, then memory + completion ──
      setAwaitingHumanMerge: statusStamp('AWAITING_HUMAN_MERGE', 'waitForHumanMerge', {
        group: 'human merge',
      }),
      terminateMergeTimedOut: terminate('TIMED_OUT', {
        group: 'human merge',
        result: {},
        title: 'Merge timed out',
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
    }
  );
}
