import type {
  ApprovalResolvedSignal,
  AttachResolvedSignal,
  ChildFinishedSignal,
  UserMessageSignal,
} from '@auto-swe/shared/lib/orchestrationApi';
import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import type {
  OrchestrationCarried,
  OrchestrationEvent,
  OrchestrationWorkflowInput,
} from '../lib/orchestrationTypes.js';
import { RETRY_RUN_RECORD, RETRY_SINGLE_ATTEMPT, T_2M, T_15M, T_30S } from './proxyOptions.js';

/**
 * OrchestrationWorkflow — one orchestrated agent run (`docs/specs/2026-11-17-orchestrated-agent-runs.md`).
 *
 * A durable conversation: the gateway starts it with `signalWithStart` under `orch-<orchestrationId>`.
 * Signals feed one event queue; events that arrive together are batched into ONE orchestrator turn.
 * Each turn returns the intents the orchestrator recorded, and `applyOrchestrationIntents` (fixed
 * code, calling the gateway) applies them in order. The workflow then waits for the next event.
 *
 *  - While a child runs (or an approval is pending) it also wakes every {@link BACKSTOP_MS} to
 *    reconcile a `childFinished` signal that was lost.
 *  - With nothing in flight and no event for {@link IDLE_MS} it completes (status WAITING);
 *    the next message starts it again.
 *  - It `continueAsNew`s every {@link MAX_TURNS_PER_EXECUTION} turns, carrying its queue.
 *  - After {@link MAX_FAILED_TURNS} failed turns in a row it stops taking turns for machine events
 *    and waits for a person's.
 *  - The bounds (`maxTurns`, `maxWallClockSeconds`) are read from the run-pinned `input.pinned`
 *    only; the workflow never reads the settings registry, so a replay cannot take another path.
 *  - Turn and apply are single-attempt: a retry would answer the same events twice or start a
 *    child twice.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`; runtime imports
 * come from `@temporalio/workflow` and the local pure `proxyOptions`. The signal names are
 * therefore written here and checked against `ORCHESTRATION_SIGNALS` by the workflow test.
 */

export const userMessageSignal = defineSignal<[UserMessageSignal]>('userMessage');
export const childFinishedSignal = defineSignal<[ChildFinishedSignal]>('childFinished');
export const attachResolvedSignal = defineSignal<[AttachResolvedSignal]>('attachResolved');
export const approvalResolvedSignal = defineSignal<[ApprovalResolvedSignal]>('approvalResolved');
export const cancelSignal = defineSignal<[unknown?]>('cancel');

/** How long a quiet orchestration with nothing in flight waits before it completes. */
const IDLE_MS = 30 * 60_000;
/** How often the lost-signal backstop runs while a child is in flight. */
const BACKSTOP_MS = 60_000;
/** Turns per execution before continuing as new, so the history stays small. */
const MAX_TURNS_PER_EXECUTION = 50;
/** Consecutive turns that only a refusal triggered; past it the orchestrator waits for a person. */
const MAX_REFUSAL_STREAK = 3;
/**
 * Consecutive failed turns; past it no machine event (the backstop re-reporting a finished child,
 * say) starts another turn, and the orchestrator waits for a person's event. Without it a turn that
 * keeps failing would be retried by the backstop every minute or two for the orchestration's life.
 */
const MAX_FAILED_TURNS = 3;

/** An event a person caused: it ends a wait that failed turns started. */
const isHumanEvent = (e: OrchestrationEvent) =>
  e.type === 'userMessage' || e.type === 'attachResolved' || e.type === 'approvalResolved';

const { runOrchestratorTurn, applyOrchestrationIntents } = proxyActivities<
  Pick<typeof activitiesType, 'runOrchestratorTurn' | 'applyOrchestrationIntents'>
>({
  // runAgent pumps heartbeats while the model works, so a dead worker is noticed in minutes.
  heartbeatTimeout: T_2M,
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: T_15M,
});

const { beginOrchestrationRun, recordOrchestrationStatus, refreshOrchestrationChildren } =
  proxyActivities<
    Pick<
      typeof activitiesType,
      'beginOrchestrationRun' | 'recordOrchestrationStatus' | 'refreshOrchestrationChildren'
    >
  >({
    retry: RETRY_RUN_RECORD,
    startToCloseTimeout: T_30S,
  });

const { cancelOrchestrationChildren } = proxyActivities<
  Pick<typeof activitiesType, 'cancelOrchestrationChildren'>
>({
  retry: RETRY_RUN_RECORD,
  startToCloseTimeout: T_2M,
});

export async function OrchestrationWorkflow(input: OrchestrationWorkflowInput): Promise<void> {
  const { orchestrationId, pinned } = input;
  const queue: OrchestrationEvent[] = [...(input.pending ?? [])];
  // A cancel that arrived before a `continueAsNew` is carried across it, never forgotten.
  let cancelRequested = input.carried?.cancelRequested === true;

  const push = (event: OrchestrationEvent) => {
    // The same child reported twice (signal and backstop) is one event.
    if (
      event.type === 'childFinished' &&
      queue.some((q) => q.type === 'childFinished' && q.childId === event.childId)
    ) {
      return;
    }
    queue.push(event);
  };
  setHandler(userMessageSignal, (s) => push({ type: 'userMessage', ...s }));
  setHandler(childFinishedSignal, (s) => push({ type: 'childFinished', ...s }));
  setHandler(attachResolvedSignal, (s) => push({ type: 'attachResolved', ...s }));
  setHandler(approvalResolvedSignal, (s) => push({ type: 'approvalResolved', ...s }));
  setHandler(cancelSignal, () => {
    cancelRequested = true;
  });

  let state: OrchestrationCarried;
  if (input.carried) {
    state = { ...input.carried };
  } else {
    const begun = await beginOrchestrationRun({ orchestrationId });
    if (!begun.proceed) {
      return;
    }
    state = {
      deadlineMs: begun.createdAtMs + pinned.maxWallClockSeconds * 1000,
      keyEpoch: workflowInfo().runId.replace(/-/g, '').slice(0, 8),
      pendingApprovals: begun.pendingApprovals,
      refusalStreak: 0,
      runningChildren: begun.runningChildren,
      turns: begun.turns,
    };
    // A restarted workflow reports finished children no turn has read.
    for (const childId of begun.unseenChildIds) {
      push({ childId, type: 'childFinished' });
    }
  }
  const executionStartTurns = state.turns;

  const finish = async (
    status: 'COMPLETED' | 'CANCELLED',
    notice?: { code: string; body: string }
  ) => {
    // Runs to completion even when the workflow's own scope was cancelled.
    await CancellationScope.nonCancellable(async () => {
      try {
        await cancelOrchestrationChildren({ orchestrationId, token: input.token });
      } catch (err) {
        log.warn('OrchestrationWorkflow: cancelling children failed', {
          err: err instanceof Error ? err.message : String(err),
          orchestrationId,
        });
      }
      await recordOrchestrationStatus({ notice, orchestrationId, status });
    });
  };

  /** Count a failed turn; at the cap, say the orchestrator is waiting for a person. */
  const noteFailedTurn = async () => {
    state.failedTurns = (state.failedTurns ?? 0) + 1;
    if (state.failedTurns === MAX_FAILED_TURNS) {
      try {
        await recordOrchestrationStatus({
          notice: {
            body: 'The orchestrator failed several turns in a row, so it has stopped trying on its own. Send a message to continue.',
            code: 'TURNS_FAILING',
          },
          orchestrationId,
          status: 'ACTIVE',
        });
      } catch {
        // The notice is lost; the wait for a person still holds.
      }
    }
  };

  try {
    for (;;) {
      if (cancelRequested) {
        await finish('CANCELLED');
        return;
      }
      if (Date.now() >= state.deadlineMs) {
        await finish('COMPLETED', {
          body: 'This orchestration reached its time limit. Running agents were cancelled; branches already pushed stay.',
          code: 'LIFETIME_REACHED',
        });
        return;
      }

      if ((state.failedTurns ?? 0) >= MAX_FAILED_TURNS) {
        // Turns keep failing: only a person's event starts another. Machine events are dropped
        // here (a finished child's result stays unread in the database and is shown with the next
        // turn), so the backstop cannot loop a failing turn.
        const human = queue.filter(isHumanEvent);
        queue.length = 0;
        queue.push(...human);
        if (queue.length === 0) {
          await condition(
            () => queue.some(isHumanEvent) || cancelRequested,
            Math.max(1, state.deadlineMs - Date.now())
          );
          continue;
        }
      }

      if (queue.length === 0) {
        const hold = state.runningChildren > 0 || state.pendingApprovals > 0;
        const remaining = Math.max(1, state.deadlineMs - Date.now());
        const wanted = hold ? BACKSTOP_MS : IDLE_MS;
        const woke = await condition(
          () => queue.length > 0 || cancelRequested,
          Math.min(wanted, remaining)
        );
        if (woke) {
          continue;
        }
        if (remaining <= wanted && Date.now() >= state.deadlineMs) {
          continue; // the lifetime ended; the top of the loop finishes it
        }
        if (hold) {
          const refreshed = await refreshOrchestrationChildren({ orchestrationId });
          state.runningChildren = refreshed.runningChildren;
          state.pendingApprovals = refreshed.pendingApprovals;
          for (const childId of refreshed.finishedChildIds) {
            push({ childId, type: 'childFinished' });
          }
          continue;
        }
        // Nothing in flight and nothing said for the idle window: complete; a later message
        // starts the workflow again.
        await recordOrchestrationStatus({ orchestrationId, status: 'WAITING' });
        if (queue.length > 0 || cancelRequested) {
          // A signal landed while the status activity ran (the gateway has already revived the
          // status to ACTIVE for it). Completing now would lose it: flip back and carry on.
          await recordOrchestrationStatus({ orchestrationId, status: 'ACTIVE' });
          continue;
        }
        return;
      }

      if (state.turns >= pinned.maxTurns) {
        await finish('COMPLETED', {
          body: 'This orchestration reached its turn limit. Running agents were cancelled; branches already pushed stay.',
          code: 'TURN_LIMIT_REACHED',
        });
        return;
      }

      const batch = queue.splice(0, queue.length);
      if (batch.some((e) => e.type !== 'notices')) {
        state.refusalStreak = 0;
      }
      if (batch.some(isHumanEvent)) {
        state.failedTurns = 0;
      }
      // Unique per turn: the counter is carried through `continueAsNew`, and the epoch (the run id
      // of the fresh start) keeps a restart that re-reads a smaller count from reusing a key.
      // The gateway folds this into the spawn idempotency key, so a repeat would answer an earlier
      // turn's child instead of starting a new one. A retried activity reuses the same key.
      const turnKey = `${orchestrationId}-${state.keyEpoch ?? 'e'}-t${state.turns + 1}`;
      state.turns += 1;

      let intents: Awaited<ReturnType<typeof runOrchestratorTurn>>['intents'] = [];
      try {
        const turn = await runOrchestratorTurn({
          events: batch,
          orchestrationId,
          turn: state.turns,
          turnKey,
        });
        intents = turn.intents;
        state.runningChildren = turn.runningChildren;
        state.pendingApprovals = turn.pendingApprovals;
        if (turn.status === 'FAILED') {
          await noteFailedTurn();
        } else {
          state.failedTurns = 0;
          // Results that did not fit this turn are still unread: wake the orchestrator for them
          // now, rather than leaving them for a backstop that only runs while a child is in flight.
          // A recorded history has no such field, so replay takes the same path as before.
          for (const childId of turn.deferredChildIds ?? []) {
            push({ childId, type: 'childFinished' });
          }
        }
      } catch (err) {
        // The turn could not run at all (timed out, or the worker died past its heartbeat). The
        // events are not re-queued: a failing turn must not loop. The person sees the notice.
        log.warn('OrchestrationWorkflow: turn did not complete', {
          err: err instanceof Error ? err.message : String(err),
          orchestrationId,
          turnKey,
        });
        try {
          await recordOrchestrationStatus({
            notice: {
              body: 'The orchestrator could not complete a turn. Send a message to try again.',
              code: 'TURN_LOST',
            },
            orchestrationId,
            status: 'ACTIVE',
          });
        } catch {
          // The notice is lost; the next turn proceeds.
        }
        await noteFailedTurn();
      }

      if (intents.length > 0 && !cancelRequested) {
        try {
          const applied = await applyOrchestrationIntents({
            intents,
            orchestrationId,
            token: input.token,
            turnKey,
          });
          state.runningChildren = applied.runningChildren;
          state.pendingApprovals = applied.pendingApprovals;
          if (applied.refused > 0 && state.refusalStreak < MAX_REFUSAL_STREAK) {
            // The notices are for the orchestrator: wake it once to read them.
            state.refusalStreak += 1;
            push({ type: 'notices' });
          }
        } catch (err) {
          log.warn('OrchestrationWorkflow: applying intents did not complete', {
            err: err instanceof Error ? err.message : String(err),
            orchestrationId,
            turnKey,
          });
        }
      }

      if (
        state.turns - executionStartTurns >= MAX_TURNS_PER_EXECUTION ||
        workflowInfo().continueAsNewSuggested
      ) {
        await continueAsNew<typeof OrchestrationWorkflow>({
          ...input,
          carried: { ...state, cancelRequested },
          pending: queue,
        });
      }
    }
  } catch (err) {
    if (isCancellation(err)) {
      // The workflow itself was cancelled (handle.cancel()): stop the children, then end.
      await finish('CANCELLED');
    }
    throw err;
  }
}
