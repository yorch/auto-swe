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
  /**
   * Push the fix to the pull request (a step with this id), then wait for CI again. `status`
   * is the domain status the push step stamps when it is entered (the wait that follows).
   */
  | { repush: string; status?: string }
  /** Clear the CI result and go back into the review, to `then`, via `clearCiResult`. */
  | { rereview: string };

/**
 * Where the loop's fix budget is counted: `fetchLogs` is entered once per fix attempt, so
 * its visit count is the number of attempts made. A template that gives a rejected change a
 * fresh CI budget sets this path back to 0.
 */
export const CI_ATTEMPTS_PATH = 'nodes.fetchLogs.visits';

export interface CiLoopOptions {
  /** Where a passing CI goes next. */
  passed: string;
  /** How CI is awaited. Default `'signal'`. */
  wait?: CiWaitMode;
  /**
   * Where a run goes when CI has failed for good — every fix attempt spent, or
   * the first failure when there is no fix loop. Default `terminateCIFailed`; a
   * template that records the failure first routes through its own node and on
   * to `terminateCIFailed` itself.
   */
  exhausted?: string;
  /**
   * The fix loop. `false` is a bare gate: a failing CI ends the run
   * (`checkCI -> terminateCIFailed`) with no fix attempt. Otherwise a failure
   * fetches the logs and asks the implementer for a fix, then `handoff` decides where
   * the fixed code goes.
   *
   * `limit` (default 3) counts CI failures, so `limit - 1` fixes are attempted before the
   * run goes to `exhausted`. A number becomes `maxVisits` on `fetchLogs`. A string is an
   * expression evaluated against the run context each time it is checked — e.g. a run-input
   * option with a fallback, `request.payload.maxFixes ?? 2` — which `maxVisits` cannot hold
   * (it is a constant), so that form keeps a `context.ciRetries` counter with its
   * `incCIRetries` / `checkCILimit` nodes. The counter must be initialised to 0 first
   * (`openPullRequest({ resetCiRetries: true })`).
   *
   * `retryIfUnchanged` guards a fix that changed nothing. The fix session commits only
   * when there is a diff, so a no-op leaves the head the failed CI already judged, no new
   * CI event ever arrives for it, and a signal wait would run to its timeout. With the
   * option, `checkCiFixChanged` compares the fix's head with the one that failed and sends
   * an unchanged fix back round the loop: it counts as a spent attempt and the loop
   * tries again until the limit, instead of waiting. Off by default, so the other
   * templates keep the nodes they were seeded with.
   */
  fix: false | { limit?: number | string; handoff: CiFixHandoff; retryIfUnchanged?: boolean };
}

/**
 * The CI wait and fix loop. With a fix loop and a repush handoff the nodes are:
 *
 *   waitForCI -> checkCI --passed--> `passed`
 *                   |
 *               (failed)
 *                   v
 *   fetchLogs --(attempt `limit`)--> terminateCIFailed
 *       |          (stores context.lastCILogs)
 *       v
 *   ciFix -> updateCodeAfterCIFix -> <repush> -> wait entry
 *
 * plus the two CI terminals. `ciFix` keeps its output as `context.currentCodeResult`
 * (`storeAs`) — except with `retryIfUnchanged`, where `updateCodeAfterCIFix` keeps it only
 * after `checkCiFixChanged` has compared the new head with the old one. Entry node, and
 * where a repush re-enters the wait: {@link ciWaitEntry}.
 */
export function ciLoop(opts: CiLoopOptions): NodeMap {
  const loop = 'CI loop';
  const wait = opts.wait ?? 'signal';
  const fix = opts.fix;
  const exhausted = opts.exhausted ?? 'terminateCIFailed';
  const counted = fix !== false && typeof fix.limit === 'string';
  const failedTo = !fix ? exhausted : counted ? 'incCIRetries' : 'fetchLogs';
  const nodes: NodeMap = mergeNodes(waitForCi(wait), {
    checkCI: {
      expr: 'context.ciResultPayload.passed == true',
      group: loop,
      onFalse: failedTo,
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
  const limit = fix.limit ?? 3;
  const maxFixes = typeof limit === 'number' ? limit - 1 : 0;
  if (typeof limit === 'number' && limit < 2) {
    throw new Error(`ciLoop: limit must be at least 2 (got ${limit})`);
  }
  // Where an unchanged fix goes to spend an attempt, and which node holds the budget.
  const retry = counted ? 'incCIRetries' : 'fetchLogs';
  const afterFix = 'repush' in handoff ? handoff.repush : 'clearCiResult';
  return mergeNodes(
    nodes,
    {
      ciFix: {
        group: loop,
        inputs: {
          failureContext: { from: 'context.lastCILogs' },
          previousCodeResult: { from: 'context.currentCodeResult' },
        },
        next: fix.retryIfUnchanged ? 'checkCiFixChanged' : afterFix,
        step: 'executeCIFixImplementation',
        // With the unchanged-fix check the new code must not replace the old head before the
        // comparison, so `updateCodeAfterCIFix` keeps it afterwards.
        ...(fix.retryIfUnchanged ? {} : { storeAs: 'context.currentCodeResult' }),
        title: 'Fix the CI failure',
        type: 'step',
      },
      fetchLogs: {
        group: loop,
        inputs: { logsUrl: { from: 'context.ciResultPayload.logsUrl' } },
        ...(counted ? {} : { maxVisits: maxFixes, onExhausted: exhausted }),
        next: 'ciFix',
        step: 'fetchCILogs',
        storeAs: 'context.lastCILogs',
        title: 'Fetch the CI logs',
        type: 'step',
      },
    },
    counted
      ? {
          // An expression limit: the counter is context state, checked before the fetch.
          checkCILimit: {
            expr: `context.ciRetries >= (${limit})`,
            group: loop,
            onFalse: 'fetchLogs',
            onTrue: exhausted,
            title: 'Out of attempts?',
            type: 'cond',
          },
          incCIRetries: {
            group: loop,
            next: 'checkCILimit',
            title: 'Count the attempt',
            type: 'set',
            values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
          },
        }
      : undefined,
    fix.retryIfUnchanged
      ? {
          checkCiFixChanged: {
            // `context.currentCodeResult` still holds the head CI failed on: it is replaced
            // by `updateCodeAfterCIFix`, which only a changed fix reaches.
            expr: 'nodes.ciFix.output.headSha == context.currentCodeResult.headSha',
            group: loop,
            onFalse: 'updateCodeAfterCIFix',
            onTrue: retry,
            title: 'Did the fix change nothing?',
            type: 'cond',
          },
          updateCodeAfterCIFix: {
            group: loop,
            next: afterFix,
            title: 'Keep the fixed code',
            type: 'set',
            values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
          },
        }
      : undefined,
    'repush' in handoff
      ? {
          [handoff.repush]: {
            group: loop,
            inputs: { codeResult: { from: 'context.currentCodeResult' } },
            // The wait starts over the way it first did: with `pollOrSignal`, through the
            // router, so a deployment that only polls does not sit out the webhook timeout.
            next: ciWaitEntry(wait),
            ...(handoff.status ? { status: handoff.status } : {}),
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
