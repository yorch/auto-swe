import { mergeNodes, type NodeMap, prResult, terminate } from './common.js';

/** How the run waits for CI: the webhook signal alone, or routed to polling by config. */
export type CiWaitMode = 'signal' | 'pollOrSignal';

/** The node a pull request hands over to in order to start waiting for CI. */
export function ciWaitEntry(wait: CiWaitMode = 'signal'): string {
  return wait === 'pollOrSignal' ? 'loadCiWaitConfig' : 'waitForCI';
}

/**
 * The CI wait: a `ciPipelineSignal` signal node that stores the CI result at
 * `context.ciResultPayload` and routes to `checkCI`, timing out into
 * `terminateCITimedOut` after four hours.
 *
 * With `pollOrSignal` the wait is preceded by `loadCiWaitConfig -> routeCiWait`,
 * which reads the `ci.*` settings and sends the run either to this signal or to
 * `pollForCI` (an active GitHub query). The poll activity returns `ciPassed`, not
 * `passed`, so its raw output is never mistaken for a failed quality gate;
 * `storePollResult` remaps it into the same `ciResultPayload` shape the signal
 * stores before `checkCI` reads it.
 */
export function waitForCi(wait: CiWaitMode = 'signal'): NodeMap {
  const group = 'CI wait';
  return {
    terminateCITimedOut: terminate('TIMED_OUT', {
      group,
      result: prResult(),
      title: 'CI timed out',
    }),
    waitForCI: {
      group,
      name: 'ciPipelineSignal',
      onReceive: 'checkCI',
      onTimeout: 'terminateCITimedOut',
      storeAs: 'context.ciResultPayload',
      timeout: '4h',
      title: 'Wait for CI',
      type: 'signal',
    },
    ...(wait === 'pollOrSignal'
      ? {
          loadCiWaitConfig: {
            group,
            next: 'routeCiWait',
            step: 'resolveCiWaitConfig',
            title: 'Read the CI wait settings',
            type: 'step',
          },
          pollForCI: {
            group,
            inputs: {
              deadlineSec: { from: 'nodes.loadCiWaitConfig.output.deadlineSec' },
              graceSec: { from: 'nodes.loadCiWaitConfig.output.graceSec' },
              intervalSec: { from: 'nodes.loadCiWaitConfig.output.intervalSec' },
              ref: { from: 'context.currentCodeResult.branch' },
            },
            next: 'storePollResult',
            onError: 'fail',
            step: 'waitForCiByPolling',
            title: 'Poll GitHub for CI',
            type: 'step',
          },
          routeCiWait: {
            expr: "nodes.loadCiWaitConfig.output.mode == 'poll'",
            group,
            onFalse: 'waitForCI',
            onTrue: 'pollForCI',
            title: 'Poll instead of waiting?',
            type: 'cond',
          },
          storePollResult: {
            group,
            next: 'checkCI',
            title: 'Normalise the poll result',
            type: 'set',
            values: {
              'context.ciResultPayload.logsUrl': { from: 'nodes.pollForCI.output.logsUrl' },
              'context.ciResultPayload.passed': { from: 'nodes.pollForCI.output.ciPassed' },
            },
          },
        }
      : {}),
  };
}

/** What happens to the code a CI fix produced. */
export type CiFixHandoff =
  /** Push the fix to the pull request (a step with this id), then wait for CI again. */
  | { repush: string }
  /** Clear the CI result and go back into the review, to `then`, via `clearCiResult`. */
  | { rereview: string };

export interface CiLoopOptions {
  /** Where a passing CI goes next. */
  passed: string;
  /** How CI is awaited. Default `'signal'`. */
  wait?: CiWaitMode;
  /**
   * The fix loop. `false` is a bare gate: a failing CI ends the run
   * (`checkCI -> terminateCIFailed`) with no fix attempt. Otherwise a failure
   * fetches the logs and asks the implementer for a fix, up to `limit` times
   * (default 3), then `handoff` decides where the fixed code goes.
   */
  fix: false | { limit?: number; handoff: CiFixHandoff };
}

/**
 * The CI wait and fix loop. With a fix loop and a repush handoff the nodes are:
 *
 *   waitForCI -> checkCI --passed--> `passed`
 *                   |
 *               (failed)
 *                   v
 *   incCIRetries -> checkCILimit --over limit--> terminateCIFailed
 *                        |
 *                    (under)
 *                        v
 *   fetchLogs -> storeLogs -> ciFix -> updateCodeAfterCIFix -> <repush> -> waitForCI
 *
 * plus the two CI terminals. The counter lives at `context.ciRetries` and must be
 * initialised to 0 first (`initCounters`, or the pull-request step). Entry node:
 * {@link ciWaitEntry}.
 */
export function ciLoop(opts: CiLoopOptions): NodeMap {
  const loop = 'CI loop';
  const wait = opts.wait ?? 'signal';
  const fix = opts.fix;
  const nodes: NodeMap = mergeNodes(waitForCi(wait), {
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      group: loop,
      onFalse: fix ? 'incCIRetries' : 'terminateCIFailed',
      onTrue: opts.passed,
      title: 'CI passed?',
      type: 'cond',
    },
    terminateCIFailed: terminate('FAILED', { group: loop, result: prResult(), title: 'CI failed' }),
  });
  if (!fix) {
    return nodes;
  }
  const handoff = fix.handoff;
  return mergeNodes(
    nodes,
    {
      checkCILimit: {
        expr: `context.ciRetries >= ${fix.limit ?? 3}`,
        group: loop,
        onFalse: 'fetchLogs',
        onTrue: 'terminateCIFailed',
        title: 'Out of attempts?',
        type: 'cond',
      },
      ciFix: {
        group: loop,
        inputs: {
          failureContext: { from: 'context.lastCILogs' },
          previousCodeResult: { from: 'context.currentCodeResult' },
        },
        next: 'updateCodeAfterCIFix',
        step: 'executeCIFixImplementation',
        title: 'Fix the CI failure',
        type: 'step',
      },
      fetchLogs: {
        group: loop,
        inputs: { logsUrl: { from: 'context.ciResultPayload.logsUrl' } },
        next: 'storeLogs',
        step: 'fetchCILogs',
        title: 'Fetch the CI logs',
        type: 'step',
      },
      incCIRetries: {
        group: loop,
        next: 'checkCILimit',
        title: 'Count the attempt',
        type: 'set',
        values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
      },
      storeLogs: {
        group: loop,
        next: 'ciFix',
        title: 'Keep the logs',
        type: 'set',
        values: { 'context.lastCILogs': { from: 'nodes.fetchLogs.output' } },
      },
      updateCodeAfterCIFix: {
        group: loop,
        next: 'repush' in handoff ? handoff.repush : 'clearCiResult',
        title: 'Keep the fixed code',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
      },
    },
    'repush' in handoff
      ? {
          [handoff.repush]: {
            group: loop,
            inputs: { codeResult: { from: 'context.currentCodeResult' } },
            next: 'waitForCI',
            step: 'createOrUpdatePullRequest',
            title: 'Push the fix',
            type: 'step',
          },
        }
      : {
          clearCiResult: {
            // It belongs to the review it leads into: the implementation enters it too, so a
            // reader meets it as the first step of the review, not as part of the CI loop.
            group: 'review loop',
            next: handoff.rereview,
            title: 'Clear the stale CI result',
            type: 'set',
            values: { 'context.ciResultPayload': { literal: null } },
          },
        }
  );
}
