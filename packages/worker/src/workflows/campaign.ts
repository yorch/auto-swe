import type {
  CampaignResult,
  CampaignTargetInput,
  CampaignWorkflowInput,
  RepoWorkRequest,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import {
  CancellationScope,
  defineSignal,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { CAMPAIGN_CANCEL_SIGNAL } from '../lib/workflowEngine.js';
import { RETRY_STATE, T_30S } from './proxyOptions.js';

export type { CampaignResult, CampaignWorkflowInput };

/**
 * The campaign workflow: one pinned template fanned out to a set of repositories, at most
 * `maxParallel` at a time.
 *
 * A new workflow type with no history before it, so v1 carries no `patched()` gate. Any later
 * change to the scheduling or the command sequence goes behind `patched('campaign-…')`, and its
 * replay fixtures (`campaign-mixed`, `campaign-cancel`) are never re-recorded to make a test pass.
 *
 * Everything the workflow decides is frozen in its input by the gateway (the limits, the pinned
 * template and the target order): the isolate reads no settings and no rows.
 *
 * Determinism: children start in input order from a queue; the scheduler waits with
 * `Promise.race` over a `Map` (insertion-ordered) of in-flight targets, so there is no clock and
 * no randomness in what it does next.
 *
 * Failure is per target. A child that fails, is rejected or cannot be started becomes a failed
 * target and never stops the scheduler, and neither does a record activity that keeps failing:
 * `finalizeCampaign` reconciles every row from the results this workflow holds.
 *
 * Known edge, deliberately not handled: a recipe that pushed its commit but whose finalize step
 * then failed reports `passed: false`, so the template falls back to the agent with a branch that
 * already carries the recipe's commit. The agent's first attempt starts from the base and its push
 * is refused as not a fast-forward; the step's retry syncs to the pushed branch and builds on it.
 */

// ── Activity Proxies ──

const stateActivities = proxyActivities<Pick<typeof activitiesType, 'updateDomainState'>>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

const campaignActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'finalizeCampaign'
    | 'recordCampaignState'
    | 'recordCampaignTargetResult'
    | 'recordCampaignTargetStarted'
  >
>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

// ── Signals ──

// The gateway sends this signal by the same shared constant; `@auto-swe/shared/types/workflow` holds
// only types and plain constants, so the value import (through `lib/workflowEngine`) is isolate-safe.
export const campaignCancelSignal = defineSignal(CAMPAIGN_CANCEL_SIGNAL);

// ── Workflow ──

/** Longest rejection text carried in a synthesized result (the activity bounds it again). */
const REASON_MAX = 500;

/** The failure reason of a target whose child run was cancelled outside the campaign. */
const CHILD_CANCELLED_REASON =
  'the child run was cancelled outside the campaign; the campaign itself was not cancelled';

/** The messages along an error's cause chain: a child's real failure sits below its wrapper. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    if (cur.message && !parts.includes(cur.message)) {
      parts.push(cur.message);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(': ').slice(0, REASON_MAX);
}

export async function CampaignWorkflow(input: CampaignWorkflowInput): Promise<CampaignResult> {
  let cancelled = false;
  // Every child is started inside this scope, so cancelling it (the signal, or the campaign's own
  // cancellation, which cancels this child scope with its parent) cancels the children in flight
  // and not only the loop that would start more.
  const childScope = new CancellationScope();
  childScope.cancelRequested.catch(() => {
    cancelled = true;
  });
  setHandler(campaignCancelSignal, () => {
    cancelled = true;
    childScope.cancel();
  });

  const queue: CampaignTargetInput[] = [...input.targets];
  const childResults: Record<string, WorkflowResult> = {};
  const finished: Array<{ connectionId: string; teamId: string; result: WorkflowResult }> = [];

  await stateActivities.updateDomainState(input.campaignWorkflowId, 'FANNING_OUT');
  await campaignActivities.recordCampaignState(input.campaignId, 'RUNNING').catch(() => undefined);

  /** Run one target's child to a terminal verdict. Never rejects. */
  const runTarget = async (target: CampaignTargetInput): Promise<string> => {
    const childWorkflowId = `${input.campaignWorkflowId}-${target.connectionId}`;
    let result: WorkflowResult;
    try {
      const request: RepoWorkRequest = {
        connectionId: target.connectionId,
        description: input.description,
        externalTicketId: input.externalTicketId,
        launchedById: input.launchedById,
        parentWorkflowId: input.campaignWorkflowId,
        payload: { ...input.childPayload, connectionId: target.connectionId },
        repoId: target.connectionId,
        requestPayload: input.requestPayload,
        workRequestId: input.workRequestId,
      };
      // The start command is issued before any activity is awaited. An activity's completion
      // time is not in the workflow's control, so awaiting the "started" record first would let
      // two targets swap places; issuing the command here keeps the start order the input order.
      const starting = startChild('RunnableWorkflow', {
        args: [{ request, templateId: input.templateId, templateVersion: input.templateVersion }],
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
        taskQueue: 'engineering-workflow',
        workflowId: childWorkflowId,
      });
      const recordStarted = campaignActivities
        .recordCampaignTargetStarted({
          campaignId: input.campaignId,
          childWorkflowId,
          connectionId: target.connectionId,
          teamId: target.teamId,
        })
        .catch(() => undefined);
      const handle = await starting;
      await recordStarted;
      result = (await handle.result()) as WorkflowResult;
    } catch (err: unknown) {
      // Only the campaign's own cancel (the signal, or a cancel of this workflow, both through
      // `childScope`) sets `cancelled`. A child that was cancelled on its own, through the run's
      // cancel route or the Temporal UI, is that target's outcome: it ends FAILED with the reason,
      // and the campaign carries on starting the rest. Letting it set the campaign-wide flag would
      // stop every queued target without the campaign cancel's permission check or audit row.
      result = {
        lessonsGenerated: [],
        skippedReason: cancelled
          ? 'campaign cancelled'
          : isCancellation(err)
            ? CHILD_CANCELLED_REASON
            : `child failed to start or errored: ${errorText(err)}`,
        status: 'FAILED',
        totalCIRetries: 0,
        totalReviewRetries: 0,
      };
    }
    childResults[target.connectionId] = result;
    finished.push({ connectionId: target.connectionId, result, teamId: target.teamId });
    // Non-cancellable: after a cancel this runs inside the cancelled child scope, and the row must
    // still be written. A failure here is not the scheduler's problem; finalize reconciles it.
    await CancellationScope.nonCancellable(() =>
      campaignActivities
        .recordCampaignTargetResult({
          campaignId: input.campaignId,
          cancelled,
          connectionId: target.connectionId,
          result,
          teamId: target.teamId,
        })
        .catch(() => undefined)
    );
    return target.connectionId;
  };

  await childScope.run(async () => {
    const inFlight = new Map<string, Promise<string>>();
    const startReady = (): void => {
      while (!cancelled && queue.length > 0 && inFlight.size < Math.max(1, input.maxParallel)) {
        const next = queue.shift();
        if (!next) {
          return;
        }
        inFlight.set(next.connectionId, runTarget(next));
      }
    };
    startReady();
    while (inFlight.size > 0) {
      const doneId = await Promise.race(inFlight.values());
      inFlight.delete(doneId);
      startReady();
    }
  });

  // Finalize outside any cancellation: a cancelled campaign is exactly when the rows most need
  // closing (the lesson `runnable.ts` documents).
  const notStarted = queue.map((t) => ({ connectionId: t.connectionId, teamId: t.teamId }));
  const localStatus: CampaignResult['status'] = cancelled
    ? 'CANCELLED'
    : finished.some((f) => f.result.status !== 'SUCCESS')
      ? 'COMPLETED_WITH_FAILURES'
      : 'COMPLETED';
  const status = await CancellationScope.nonCancellable(async () => {
    let finalState: CampaignResult['status'] = localStatus;
    try {
      finalState = await campaignActivities.finalizeCampaign({
        campaignId: input.campaignId,
        cancelled,
        notStarted,
        results: finished,
      });
    } catch {
      // The rows stay as the per-target records left them; the result below is still honest.
    }
    await stateActivities
      .updateDomainState(
        input.campaignWorkflowId,
        finalState === 'CANCELLED'
          ? 'CANCELLED'
          : finalState === 'COMPLETED'
            ? 'COMPLETED'
            : 'FAILED'
      )
      .catch(() => undefined);
    return finalState;
  });

  return { childResults, status };
}
