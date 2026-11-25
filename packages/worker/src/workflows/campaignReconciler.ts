import {
  CAMPAIGN_RECONCILER_MAX_PASSES,
  type CampaignStateValue,
  decidePause,
  decideSchedule,
  diffDiscovery,
  isCampaignFinal,
  type ScheduleTarget,
} from '@auto-swe/shared/lib/campaignState';
import type {
  CampaignAttemptFinishedSignal,
  CampaignControlSignal,
  CampaignPullRequestChangedSignal,
  CampaignReconcilerInput,
  CampaignReconcilerResult,
} from '@auto-swe/shared/types/workflow';
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
  CampaignPassSnapshot,
  CampaignStateWrite,
  PassTarget,
  ReconcilerWorkflowInput,
  StartCampaignAttemptResult,
  TargetUpdate,
} from '../lib/campaignReconcilerTypes.js';
import {
  CAMPAIGN_ATTEMPT_FINISHED_SIGNAL,
  CAMPAIGN_CONTROL_SIGNAL,
  CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL,
} from '../lib/workflowEngine.js';
import {
  advanceWalk,
  applyCheckResult,
  DISCOVERY_ACTIVITY_TIMEOUT_MS,
  DISCOVERY_MAX_CHUNKS,
  decideBlockUpdates,
  decideCampaignWrite,
  deriveDeliveryUpdates,
  discoveryDue,
  FAILURE_RETRY_MS,
  NEW_DISCOVERY_WALK,
  nextChunkLimits,
  nextSleepMs,
  planDueChecks,
  REFUSAL_RETRY_MS,
} from './campaignReconcilerPass.js';
import {
  RETRY_FAIL_CLOSED_READ,
  RETRY_LLM_LIGHT,
  RETRY_SANDBOX,
  RETRY_STATE,
  T_2M,
  T_10M,
  T_30M,
  T_30S,
} from './proxyOptions.js';

export type { CampaignReconcilerInput, CampaignReconcilerResult };

/**
 * The campaign reconciler: a campaign is a goal over a set of repositories, and this workflow
 * works the rows toward it until it holds (docs/specs/2026-11-25-campaigns-as-tracked-goals.md §3).
 *
 * It holds no queue and no copy of any decision. Every pass reads the database through an activity
 * (`readCampaignPass`), decides with the pure functions in `campaignReconcilerPass.ts` and
 * `@auto-swe/shared/lib/campaignState`, and acts through activities: the gateway starts attempts
 * (the launch decision runs there, as the launcher, on every start), a sandboxed check re-measures
 * a target, and `recordCampaignPass` writes rows conditionally. A workflow that is restarted with
 * no memory, or one whose signal was lost, therefore loses nothing: the next pass re-reads.
 *
 * The signals are wake-ups, never state. Whatever a route or a webhook wanted done was written to
 * the rows first; the signal only ends the sleep early. A daily backstop (and a short poll while an
 * attempt is in flight) reads the database for any signal that never arrived.
 *
 * Determinism: no clock, no randomness, no I/O. Every instant the workflow compares comes from the
 * snapshot the read activity returned, and the only time it waits on is `condition`'s timeout.
 * Activities run in a fixed order (targets in `position` order, one start at a time, checks in
 * bounded batches whose results are read by index). From here on, a change to this scheduling or to
 * the command sequence goes behind `patched('campaign-…')`, and the replay fixtures under
 * `__fixtures__/campaign-reconciler/` are never re-recorded to make a test pass.
 *
 * A failed activity never fails the workflow: the pass ends, the failure is logged, and the next
 * pass (after `FAILURE_RETRY_MS`) tries again. Only the workflow's own cancellation, or a
 * cancelled campaign row, ends it early, and that closes the rows first.
 */

// ── Activity proxies ──

// A read the whole pass depends on: minutes of retrying before the pass gives up and waits.
const readActivities = proxyActivities<Pick<typeof activitiesType, 'readCampaignPass'>>({
  retry: RETRY_FAIL_CLOSED_READ,
  startToCloseTimeout: T_2M,
});

const writeActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'cancelCampaignAttempts' | 'finalizeCampaignReconciler' | 'recordCampaignPass'
  >
>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_2M,
});

// The gateway call is idempotent on a per-attempt key, so a retry answers the attempt the first
// call started.
const startActivities = proxyActivities<Pick<typeof activitiesType, 'startCampaignAttempt'>>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_2M,
});

// A check clones a repository into a sandbox.
const sandboxActivities = proxyActivities<Pick<typeof activitiesType, 'runCampaignCheck'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_30M,
});

// Discovery walks a chunk of repositories. The activity sizes its chunk to this timeout (it starts
// no repository whose worst case no longer fits), so the bound is one constant both sides read.
const discoverActivities = proxyActivities<Pick<typeof activitiesType, 'discoverCampaignTargets'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: DISCOVERY_ACTIVITY_TIMEOUT_MS,
});

const planActivities = proxyActivities<Pick<typeof activitiesType, 'planCampaignBriefs'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_LLM_LIGHT,
  startToCloseTimeout: T_10M,
});

const stateActivities = proxyActivities<Pick<typeof activitiesType, 'updateDomainState'>>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

// ── Signals ──

export const campaignAttemptFinishedSignal = defineSignal<[CampaignAttemptFinishedSignal]>(
  CAMPAIGN_ATTEMPT_FINISHED_SIGNAL
);
export const campaignPullRequestChangedSignal = defineSignal<[CampaignPullRequestChangedSignal]>(
  CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL
);
export const campaignControlSignal = defineSignal<[CampaignControlSignal]>(CAMPAIGN_CONTROL_SIGNAL);

// ── Tuning (constants of the schedule, not settings: a change goes behind patched()) ──

/** Checks run this many at a time within a pass. */
const CHECK_CONCURRENCY = 3;
/** Passes in a row that may read again at once before the workflow sleeps a minute. */
const MAX_IMMEDIATE_PASSES = 5;

type PassOutcome =
  | { done: 'COMPLETED' | 'CANCELLED' }
  /** Read again at once: the pass changed what the next one should see. */
  | { immediate: true }
  | { sleepMs: number };

function toScheduleTarget(t: PassTarget): ScheduleTarget {
  return {
    dependsOn: t.dependsOn,
    id: t.id,
    label: t.label,
    position: t.position,
    state: t.state,
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export async function CampaignReconcilerWorkflow(
  input: ReconcilerWorkflowInput
): Promise<CampaignReconcilerResult> {
  const { campaignId, campaignWorkflowId } = input;
  const firstExecution = input.passes === undefined;
  let passes = input.passes ?? 0;
  let executionPasses = 0;
  let lastDiscoveryAt = input.lastDiscoveryAt ?? null;
  let lastBackstopAt = input.lastBackstopAt ?? null;
  // Where the walk of the scope stands. It is written to the rows chunk by chunk, so what a restart
  // loses is only this cursor, and `continueAsNew` carries it.
  let walk = input.discoveryWalk ?? NEW_DISCOVERY_WALK;
  let planFailed = false;
  /** Consecutive passes that asked to read again at once; bounded so a stuck row cannot spin. */
  let immediateStreak = 0;

  // Every signal is a wake-up and nothing else: the rows hold what was asked for. A signal that
  // lands while a pass runs makes the next sleep end at once.
  let wakeSeq = 0;
  setHandler(campaignAttemptFinishedSignal, () => {
    wakeSeq += 1;
  });
  setHandler(campaignPullRequestChangedSignal, () => {
    wakeSeq += 1;
  });
  setHandler(campaignControlSignal, () => {
    wakeSeq += 1;
  });

  /** Close the rows of a campaign that was cancelled, whatever scope the cancel arrived in. */
  const finishCancelled = async (): Promise<PassOutcome> => {
    await CancellationScope.nonCancellable(async () => {
      try {
        await writeActivities.cancelCampaignAttempts({ campaignId });
      } catch (err) {
        log.warn('CampaignReconcilerWorkflow: cancelling attempts failed', {
          campaignId,
          err: errorText(err),
        });
      }
      try {
        await writeActivities.finalizeCampaignReconciler({ campaignId, outcome: 'CANCELLED' });
      } catch (err) {
        log.warn('CampaignReconcilerWorkflow: finalizing a cancelled campaign failed', {
          campaignId,
          err: errorText(err),
        });
      }
      await stateActivities
        .updateDomainState(campaignWorkflowId, 'CANCELLED')
        .catch(() => undefined);
    });
    return { done: 'CANCELLED' };
  };

  const finishCompleted = async (): Promise<PassOutcome> => {
    await CancellationScope.nonCancellable(async () => {
      try {
        await writeActivities.finalizeCampaignReconciler({ campaignId, outcome: 'COMPLETED' });
      } catch (err) {
        log.warn('CampaignReconcilerWorkflow: finalizing a completed campaign failed', {
          campaignId,
          err: errorText(err),
        });
      }
      await stateActivities
        .updateDomainState(campaignWorkflowId, 'COMPLETED')
        .catch(() => undefined);
    });
    return { done: 'COMPLETED' };
  };

  /** One pass over a snapshot: decide with the pure logic, act through activities. */
  const runPass = async (snap: CampaignPassSnapshot): Promise<PassOutcome> => {
    const c = snap.campaign;
    const now = snap.nowMs;
    lastBackstopAt = now;

    if (c.state === 'CANCELLING' || c.state === 'CANCELLED') {
      return finishCancelled();
    }
    if (isCampaignFinal(c.state)) {
      return { done: 'COMPLETED' };
    }

    const sleepFor = (
      state: CampaignStateValue,
      targets: readonly PassTarget[],
      extra: {
        retryAt?: number | null;
        excluded?: ReadonlySet<string>;
        discoveryFailed?: boolean;
      } = {}
    ): PassOutcome => ({
      sleepMs: nextSleepMs({
        campaign: c,
        discoveryFailed: extra.discoveryFailed ?? false,
        excluded: extra.excluded ?? new Set(),
        lastBackstopAt,
        lastDiscoveryAt,
        now,
        retryAt: extra.retryAt ?? null,
        state,
        targets,
      }),
    });

    // A planned campaign is decomposed once, then waits for its launcher to confirm. Nothing
    // else runs while it is PLANNING: no check, no discovery, no start.
    if (c.state === 'PLANNING') {
      if (c.plan === 'PLANNED' && !snap.planned && !planFailed) {
        try {
          const planned = await planActivities.planCampaignBriefs({ campaignId });
          if (planned.planned === 0) {
            // Nothing to plan (the row is not a planned campaign in PLANNING): do not ask again.
            planFailed = true;
          }
        } catch (err) {
          if (isCancellation(err)) {
            throw err;
          }
          planFailed = true;
          log.warn('CampaignReconcilerWorkflow: planning failed; waiting for a person', {
            campaignId,
            err: errorText(err),
          });
        }
        return { immediate: true };
      }
      return sleepFor('PLANNING', snap.targets);
    }

    // Delivery: what the attempts and the pull requests did since the last pass.
    const delivery = deriveDeliveryUpdates(snap.targets, {
      now,
      staleAfterDays: c.staleAfterDays,
    });
    let targets: PassTarget[] = delivery.targets;
    let retryAt: number | null = null;
    const failedIds = new Set<string>();
    let discoveryFailed = false;
    let dbState: CampaignStateValue = c.state;

    const record = async (
      updates: TargetUpdate[],
      extra: {
        addTargets?: Array<{ connectionId: string; teamId: string; label: string }>;
        proposals?: Array<{ connectionId: string; reason: string }>;
        campaign?: CampaignStateWrite;
      } = {}
    ) =>
      writeActivities.recordCampaignPass({
        addTargets: extra.addTargets ?? [],
        campaign: extra.campaign,
        campaignId,
        proposals: extra.proposals ?? [],
        updates,
      });

    /**
     * What the gateway's refusal of one start means for the pass. A campaign-wide refusal pauses
     * the campaign (the cause is recorded) or stops the pass; a refusal about one target ends that
     * target `SKIPPED` ("the launch no longer held") and the pass carries on.
     */
    const handleRefusal = async (
      refusal: Extract<StartCampaignAttemptResult, { ok: false }>,
      t: PassTarget
    ): Promise<'stop' | 'continue'> => {
      const pauseFor = async (reason: 'disabled' | 'launcher-unavailable' | 'budget') => {
        await record([], { campaign: { from: dbState, pausedReason: reason, to: 'PAUSED' } });
        dbState = 'PAUSED';
      };
      switch (refusal.code) {
        case 'CAMPAIGNS_DISABLED':
          await pauseFor('disabled');
          return 'stop';
        case 'LAUNCHER_UNAVAILABLE':
          await pauseFor('launcher-unavailable');
          return 'stop';
        case 'BUDGET_EXCEEDED':
          await pauseFor('budget');
          return 'stop';
        case 'TARGET_UNAVAILABLE':
        case 'LAUNCH_REFUSED':
        case 'PUSH_PERMISSION_REQUIRED': {
          const update: TargetUpdate = {
            expect: t.state,
            failureReason: `not started: ${refusal.message}`,
            state: 'SKIPPED',
            targetId: t.id,
            teamId: t.teamId,
          };
          await record([update]);
          targets = targets.map(
            (x): PassTarget =>
              x.id === t.id
                ? { ...x, failureReason: update.failureReason ?? null, state: 'SKIPPED' }
                : x
          );
          return 'continue';
        }
        case 'GATE_CLOSED':
        case 'TARGET_NOT_STARTABLE':
          // The gateway read the rows differently a moment ago (a race with a person or a
          // webhook): read again soon.
          retryAt = now + REFUSAL_RETRY_MS;
          return 'continue';
        default:
          // CAMPAIGN_NOT_ACTIVE, MAX_PARALLEL, MAX_OPEN_PULL_REQUESTS or a code this version does
          // not know: nothing more can start now.
          retryAt = now + REFUSAL_RETRY_MS;
          return 'stop';
      }
    };

    try {
      if (delivery.updates.length > 0) {
        await record(delivery.updates);
      }

      // A paused campaign starts nothing and rescans nothing; running attempts finish, and the
      // delivery above still follows them.
      if (c.state === 'PAUSED') {
        return sleepFor('PAUSED', targets);
      }

      const pause = decidePause({
        budgetExceeded: c.budgetExceeded,
        campaignsEnabled: c.campaignsEnabled,
        launcherAvailable: c.launcherAvailable,
        state: c.state,
      });
      if (pause) {
        await record([], { campaign: { from: c.state, pausedReason: pause, to: 'PAUSED' } });
        return sleepFor('PAUSED', targets);
      }

      // Re-check the targets whose pull request merged, and those whose rescan is due.
      const { due } = planDueChecks(targets, c, now);
      for (let i = 0; i < due.length; i += CHECK_CONCURRENCY) {
        const batch = due.slice(i, i + CHECK_CONCURRENCY);
        const results = await Promise.all(
          batch.map((targetId) =>
            sandboxActivities.runCampaignCheck({ campaignId, targetId }).then(
              (result) => ({ result, targetId }),
              (err: unknown) => {
                if (isCancellation(err)) {
                  throw err;
                }
                return { err, targetId };
              }
            )
          )
        );
        for (const r of results) {
          if ('err' in r) {
            failedIds.add(r.targetId);
            retryAt = now + FAILURE_RETRY_MS;
            log.warn('CampaignReconcilerWorkflow: a check failed', {
              campaignId,
              err: errorText(r.err),
              targetId: r.targetId,
            });
          } else {
            const res = r.result;
            targets = targets.map((t) => (t.id === r.targetId ? applyCheckResult(t, res) : t));
            if (res.status === 'skipped') {
              // The check did not run (the rows moved under it): look again soon, not at once.
              failedIds.add(r.targetId);
              retryAt = Math.min(retryAt ?? now + REFUSAL_RETRY_MS, now + REFUSAL_RETRY_MS);
            }
          }
        }
      }

      // Discover new targets in the scope, one chunk at a time. Each chunk's findings are written
      // before the next is read, so a walk that times out or is interrupted resumes at its cursor
      // and loses nothing; only a walk that finished counts as a rescan.
      if (discoveryDue(c, lastDiscoveryAt, now)) {
        try {
          const proposed = new Set(snap.proposalConnectionIds);
          for (let chunk = 0; chunk < DISCOVERY_MAX_CHUNKS; chunk++) {
            const found: Awaited<ReturnType<typeof discoverActivities.discoverCampaignTargets>> =
              await discoverActivities.discoverCampaignTargets({
                campaignId,
                cursor: walk.cursor,
                ...nextChunkLimits(walk),
              });
            const diff = diffDiscovery({
              candidates: found.candidates,
              maxTargets: c.maxTargets,
              proposalConnectionIds: [...proposed],
              targetConnectionIds: targets.flatMap((t) => (t.connectionId ? [t.connectionId] : [])),
              targetCount: targets.length,
            });
            if (diff.add.length > 0 || diff.propose.length > 0) {
              const written = await record([], {
                addTargets: diff.add.map((a) => ({
                  connectionId: a.connectionId,
                  label: a.label,
                  teamId: a.teamId,
                })),
                proposals: diff.propose.map((p) => ({
                  connectionId: p.connectionId,
                  reason: p.reason,
                })),
              });
              for (const p of diff.propose) {
                proposed.add(p.connectionId);
              }
              for (const added of written.added) {
                targets.push({
                  attemptFailureReason: null,
                  attemptN: 0,
                  attemptOutcome: null,
                  connectionId: added.connectionId,
                  dependsOn: [],
                  failureReason: null,
                  id: added.targetId,
                  label: added.label,
                  lastCheckedAt: null,
                  position: added.position,
                  prOpenedAt: null,
                  prStatus: null,
                  regressions: 0,
                  staleSince: null,
                  state: 'PENDING',
                  teamId: added.teamId,
                });
              }
            }
            const step = advanceWalk(walk, {
              candidates: found.candidates.length,
              nextCursor: found.nextCursor,
            });
            walk = step.walk;
            if (step.done) {
              lastDiscoveryAt = now;
              break;
            }
          }
        } catch (err) {
          if (isCancellation(err)) {
            throw err;
          }
          discoveryFailed = true;
          retryAt = now + FAILURE_RETRY_MS;
          log.warn('CampaignReconcilerWorkflow: discovery failed', {
            campaignId,
            err: errorText(err),
          });
        }
      }

      // The campaign's own state, then who may start. The state is written first: the gateway
      // starts an attempt only for an ACTIVE (or STARTING) campaign.
      const decision = decideCampaignWrite(c, targets, now);
      const schedule = decideSchedule({
        campaignState: decision.state === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
        gate: c.gate,
        hasCheck: c.hasCheck,
        maxOpenPullRequests: c.maxOpenPullRequests,
        maxParallel: c.maxParallel,
        targets: targets.map(toScheduleTarget),
      });
      const blocks = decideBlockUpdates(schedule, targets);
      targets = blocks.targets;
      if (blocks.updates.length > 0 || decision.write) {
        const written = await record(blocks.updates, {
          campaign: decision.write ?? undefined,
        });
        if (decision.write) {
          if (written.campaignChanged) {
            dbState = decision.write.to;
          } else {
            // The campaign moved under this pass (a person paused it, say): decide again from
            // what the database now says.
            return { immediate: true };
          }
        }
      }
      if (decision.state === 'COMPLETED') {
        return finishCompleted();
      }

      // Start the attempts, one at a time and in order. The gateway runs the launch decision
      // for each, so a refusal here is the answer, not an error.
      for (const targetId of schedule.start) {
        const t = targets.find((x) => x.id === targetId);
        if (!t) {
          continue;
        }
        let result: StartCampaignAttemptResult;
        try {
          result = await startActivities.startCampaignAttempt({
            attemptN: t.attemptN + 1,
            campaignId,
            targetId,
          });
        } catch (err) {
          if (isCancellation(err)) {
            throw err;
          }
          retryAt = now + FAILURE_RETRY_MS;
          log.warn('CampaignReconcilerWorkflow: starting an attempt failed', {
            campaignId,
            err: errorText(err),
            targetId,
          });
          break;
        }
        if (result.ok) {
          targets = targets.map(
            (x): PassTarget =>
              x.id === targetId
                ? {
                    ...x,
                    attemptFailureReason: null,
                    attemptN: result.n,
                    attemptOutcome: null,
                    failureReason: null,
                    prOpenedAt: null,
                    prStatus: null,
                    state: 'RUNNING',
                  }
                : x
          );
          continue;
        }
        const stop = await handleRefusal(result, t);
        if (stop === 'stop') {
          break;
        }
      }

      return sleepFor(dbState === 'PAUSED' ? 'PAUSED' : decision.state, targets, {
        discoveryFailed,
        excluded: failedIds,
        retryAt,
      });
    } catch (err) {
      if (isCancellation(err)) {
        throw err;
      }
      // A write or read the pass depended on kept failing: end the pass, try again soon.
      log.warn('CampaignReconcilerWorkflow: a pass failed', { campaignId, err: errorText(err) });
      return sleepFor(c.state, targets, {
        discoveryFailed,
        excluded: failedIds,
        retryAt: now + FAILURE_RETRY_MS,
      });
    }
  };

  try {
    if (firstExecution) {
      try {
        await stateActivities.updateDomainState(campaignWorkflowId, 'FANNING_OUT');
      } catch (err) {
        if (isCancellation(err)) {
          throw err;
        }
      }
    }

    for (;;) {
      const seen = wakeSeq;
      let snap: CampaignPassSnapshot | null;
      try {
        snap = await readActivities.readCampaignPass({ campaignId });
      } catch (err) {
        if (isCancellation(err)) {
          throw err;
        }
        log.warn('CampaignReconcilerWorkflow: the read of the campaign kept failing', {
          campaignId,
          err: errorText(err),
        });
        await condition(() => wakeSeq !== seen, FAILURE_RETRY_MS);
        continue;
      }
      if (snap === null) {
        // The campaign row is gone (deleted with its team): nothing is left to reconcile.
        return { passes, status: 'CANCELLED' };
      }
      passes += 1;
      executionPasses += 1;

      let outcome = await runPass(snap);
      if ('done' in outcome) {
        return { passes, status: outcome.done };
      }
      if ('immediate' in outcome) {
        immediateStreak += 1;
        if (immediateStreak > MAX_IMMEDIATE_PASSES) {
          outcome = { sleepMs: REFUSAL_RETRY_MS };
        }
      } else {
        immediateStreak = 0;
      }

      if (
        executionPasses >= CAMPAIGN_RECONCILER_MAX_PASSES ||
        workflowInfo().continueAsNewSuggested
      ) {
        await continueAsNew<typeof CampaignReconcilerWorkflow>({
          campaignId,
          campaignWorkflowId,
          discoveryWalk: walk,
          lastBackstopAt,
          lastDiscoveryAt,
          passes,
        });
      }
      if ('sleepMs' in outcome) {
        await condition(() => wakeSeq !== seen, outcome.sleepMs);
      }
    }
  } catch (err) {
    if (isCancellation(err)) {
      // The workflow itself was cancelled (handle.cancel()): stop the attempts, close the rows.
      await finishCancelled();
    }
    throw err;
  }
}
