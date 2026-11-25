import {
  CAMPAIGN_BACKSTOP_INTERVAL_MS,
  type CampaignAttemptOutcomeValue,
  type CampaignStateValue,
  decideCampaignState,
  decideStaleSince,
  describeBlockReason,
  isDue,
  nextDueAt,
  normalizeTargetState,
  type ReconcilerTargetState,
  type ScheduleDecision,
  type TargetEvent,
  type TargetState,
  transitionTarget,
} from '@auto-swe/shared/lib/campaignState';
import type {
  CampaignStateWrite,
  PassCampaign,
  PassTarget,
  RunCampaignCheckResult,
  TargetUpdate,
} from '../lib/campaignReconcilerTypes.js';

/**
 * The reconciler's decisions that need no I/O, kept out of the workflow body so a unit test can
 * walk them without a Temporal environment. Pure and deterministic: no clock (`now` is the
 * snapshot's, epoch milliseconds), no randomness, no Node API. The workflow isolate imports this
 * file, so it uses `import type` for everything that is not a shared pure module.
 */

/** A `MERGED` target whose check did not answer is tried again after this long. */
export const CHECK_RETRY_MS = 15 * 60 * 1000;
/** A campaign with an attempt in flight reads the database at least this often, signal or not. */
export const INFLIGHT_POLL_MS = 5 * 60 * 1000;
/** After an activity failed, the next pass waits this long before trying the same thing again. */
export const FAILURE_RETRY_MS = 5 * 60 * 1000;
/** After the gateway refused a start for a reason the pass could not foresee (a race). */
export const REFUSAL_RETRY_MS = 60 * 1000;
/** Re-checks one pass runs; the rest are due on the very next pass. */
export const MAX_CHECKS_PER_PASS = 10;
/** The shortest sleep: a pass that finds work due now still yields to signals and the history. */
export const MIN_SLEEP_MS = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const PR_CLOSED_REASON = 'the pull request was closed without merging';
export const CANCELLED_OUTSIDE_REASON =
  'the run was cancelled outside the campaign; the campaign itself was not cancelled';
export const ATTEMPT_FAILED_REASON = 'the attempt failed';
export const MERGE_NOT_SATISFIED_REASON =
  'the pull request merged, but the check still fails on the base branch';

// ── Delivery state: attempts and pull requests ──

export interface DeliveryResult {
  /** The targets as they stand after the events, for the rest of the pass. */
  targets: PassTarget[];
  updates: TargetUpdate[];
}

/** The state a target is read as (a retired value is its replacement). */
function stateOf(t: PassTarget): ReconcilerTargetState {
  return normalizeTargetState(t.state);
}

/**
 * Turn what the database says about each target's latest attempt and its pull request into target
 * transitions, and set or clear the stale flag. Events are applied in the order they happened: an
 * attempt that finished, then the pull request it opened. A target whose attempt is still in
 * flight, or whose pull request is unchanged, produces no update.
 *
 * - An attempt that was cancelled while its campaign was not is a failure that needs a person
 *   (`CANCELLED` is for a cancelled campaign).
 * - A `NEEDS_ATTENTION` target is moved only by a pull request that is `OPEN` again: its merge, if
 *   it comes, is found by the next check or a retry, so a failed merge check cannot flip-flop.
 */
export function deriveDeliveryUpdates(
  targets: readonly PassTarget[],
  options: { now: number; staleAfterDays: number | null; regressionLimit?: number }
): DeliveryResult {
  const updates: TargetUpdate[] = [];
  const next: PassTarget[] = [];
  for (const t of targets) {
    let state: ReconcilerTargetState = stateOf(t);
    let regressions = t.regressions;
    let needsReason: string | null = null;
    let moved = false;
    const apply = (event: TargetEvent, reasonIfNeedsAttention: string | null) => {
      const r = transitionTarget({ regressions, state }, event, {
        regressionLimit: options.regressionLimit,
      });
      if (!r.accepted || r.state === state) {
        return;
      }
      moved = true;
      state = r.state;
      regressions = r.regressions;
      needsReason = reasonIfNeedsAttention ?? ATTEMPT_FAILED_REASON;
    };

    if (state === 'RUNNING' && t.attemptOutcome) {
      const outcome: CampaignAttemptOutcomeValue =
        t.attemptOutcome === 'CANCELLED' ? 'FAILED' : t.attemptOutcome;
      apply(
        { outcome, type: 'attemptFinished' },
        t.attemptOutcome === 'CANCELLED'
          ? CANCELLED_OUTSIDE_REASON
          : (t.attemptFailureReason ?? ATTEMPT_FAILED_REASON)
      );
    }
    if (t.prStatus && !(state === 'NEEDS_ATTENTION' && t.prStatus !== 'OPEN')) {
      apply(
        { status: t.prStatus, type: 'pullRequest' },
        t.prStatus === 'CLOSED' ? PR_CLOSED_REASON : null
      );
    }
    // A reason is kept only while the target needs a person; leaving that state clears it.
    const failureReason: string | null | undefined = !moved
      ? undefined
      : state === 'NEEDS_ATTENTION'
        ? needsReason
        : t.failureReason !== null
          ? null
          : undefined;

    const staleSince = decideStaleSince({
      now: options.now,
      prOpenedAt: t.prOpenedAt,
      prStatus: t.prStatus,
      staleAfterDays: options.staleAfterDays,
      staleSince: t.staleSince,
      state,
    });
    const staleChanged = staleSince !== t.staleSince;

    if (moved || staleChanged) {
      updates.push({
        expect: t.state,
        ...(moved && failureReason !== undefined ? { failureReason } : {}),
        ...(moved ? { regressions } : {}),
        ...(staleChanged ? { staleSince } : {}),
        state,
        targetId: t.id,
        teamId: t.teamId,
      });
    }
    next.push({
      ...t,
      failureReason: failureReason === undefined ? t.failureReason : failureReason,
      regressions,
      staleSince,
      state: moved ? state : t.state,
    });
  }
  return { targets: next, updates };
}

// ── Re-checks ──

/**
 * The targets whose check runs on this pass, in `position` order, at most
 * {@link MAX_CHECKS_PER_PASS}. A `MERGED` target is checked until the check answers (and again
 * after {@link CHECK_RETRY_MS} when it did not); a `SATISFIED` one when the campaign's rescan
 * interval has passed. A campaign without a check, or one with no rescan interval, checks only
 * its `MERGED` targets, and the first only when the recipe has a check at all.
 */
export function planDueChecks(
  targets: readonly PassTarget[],
  campaign: Pick<PassCampaign, 'hasCheck' | 'rescanIntervalHours'>,
  now: number,
  exclude: ReadonlySet<string> = new Set()
): { due: string[]; more: boolean } {
  if (!campaign.hasCheck) {
    return { due: [], more: false };
  }
  const due: string[] = [];
  const ordered = [...targets].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  for (const t of ordered) {
    if (exclude.has(t.id)) {
      continue;
    }
    const state = stateOf(t);
    const isDueNow =
      state === 'MERGED'
        ? t.lastCheckedAt === null || now - t.lastCheckedAt >= CHECK_RETRY_MS
        : state === 'SATISFIED'
          ? isDue(t.lastCheckedAt, now, campaign.rescanIntervalHours)
          : false;
    if (isDueNow) {
      due.push(t.id);
    }
  }
  return { due: due.slice(0, MAX_CHECKS_PER_PASS), more: due.length > MAX_CHECKS_PER_PASS };
}

/** The target after a check activity answered. */
export function applyCheckResult(t: PassTarget, result: RunCampaignCheckResult): PassTarget {
  return {
    ...t,
    failureReason: result.failureReason === undefined ? t.failureReason : result.failureReason,
    lastCheckedAt: result.lastCheckedAt ?? t.lastCheckedAt,
    regressions: result.regressions,
    staleSince: result.changed && result.state !== 'PR_OPENED' ? null : t.staleSince,
    state: result.changed ? result.state : t.state,
  };
}

// ── Scheduling ──

/**
 * The writes that record why targets wait (`BLOCKED` with the reason) and release those that no
 * longer do. A `PENDING` target the schedule holds back becomes `BLOCKED`; a `BLOCKED` one whose
 * reason changed is rewritten; a `BLOCKED` one the schedule starts is made `PENDING` first, so the
 * block reason does not outlive the block. Nothing is written for a target that stays as it is.
 */
export function decideBlockUpdates(
  schedule: ScheduleDecision,
  targets: readonly PassTarget[]
): { updates: TargetUpdate[]; targets: PassTarget[] } {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const updates: TargetUpdate[] = [];
  const changed = new Map<string, PassTarget>();
  for (const { reason, targetId } of schedule.blocked) {
    const t = byId.get(targetId);
    if (!t) {
      continue;
    }
    const text = describeBlockReason(reason);
    const state = stateOf(t);
    if (state === 'PENDING') {
      updates.push({
        expect: t.state,
        failureReason: text,
        state: 'BLOCKED',
        targetId: t.id,
        teamId: t.teamId,
      });
      changed.set(t.id, { ...t, failureReason: text, state: 'BLOCKED' });
    } else if (state === 'BLOCKED' && t.failureReason !== text) {
      updates.push({
        expect: t.state,
        failureReason: text,
        state: 'BLOCKED',
        targetId: t.id,
        teamId: t.teamId,
      });
      changed.set(t.id, { ...t, failureReason: text });
    }
  }
  for (const targetId of schedule.start) {
    const t = byId.get(targetId);
    if (t && stateOf(t) === 'BLOCKED') {
      updates.push({
        expect: t.state,
        failureReason: null,
        state: 'PENDING',
        targetId: t.id,
        teamId: t.teamId,
      });
      changed.set(t.id, { ...t, failureReason: null, state: 'PENDING' });
    }
  }
  return { targets: targets.map((t) => changed.get(t.id) ?? t), updates };
}

// ── The campaign's own state ──

/**
 * The campaign state write for this pass, or null when it stays. A `STARTING` campaign (and the
 * legacy `RUNNING`) is read as `ACTIVE`; the decision is the shared one (spec §2).
 */
export function decideCampaignWrite(
  campaign: Pick<PassCampaign, 'state' | 'hasScope' | 'expiresAt'>,
  targets: readonly PassTarget[],
  now: number
): { state: CampaignStateValue; write: CampaignStateWrite | null } {
  const reading: CampaignStateValue =
    campaign.state === 'STARTING' || campaign.state === 'RUNNING' ? 'ACTIVE' : campaign.state;
  const decided = decideCampaignState({
    expiresAt: campaign.expiresAt,
    hasScope: campaign.hasScope,
    now,
    state: reading,
    targetStates: targets.map((t) => t.state),
  });
  if (decided.state === campaign.state) {
    return { state: decided.state, write: null };
  }
  if (
    decided.state !== 'ACTIVE' &&
    decided.state !== 'MONITORING' &&
    decided.state !== 'COMPLETED'
  ) {
    return { state: decided.state, write: null };
  }
  return { state: decided.state, write: { from: campaign.state, to: decided.state } };
}

// ── Sleeping ──

export interface WakeInput {
  now: number;
  /** The campaign's state after this pass's decisions. */
  state: CampaignStateValue;
  campaign: Pick<
    PassCampaign,
    'hasCheck' | 'hasScope' | 'rescanIntervalHours' | 'expiresAt' | 'staleAfterDays'
  >;
  targets: readonly PassTarget[];
  lastDiscoveryAt: number | null;
  lastBackstopAt: number | null;
  /** Epoch ms before which nothing should be retried (a refused start, a failed activity). */
  retryAt: number | null;
  /** Targets whose check failed this pass: their due time is `retryAt`, not now. */
  excluded: ReadonlySet<string>;
  /** Discovery failed this pass: it is due again at `retryAt`. */
  discoveryFailed: boolean;
}

/**
 * How long the reconciler sleeps before reading the database again, when no signal wakes it:
 * until the earliest of the next due check, discovery, stale threshold, expiry, retry and the
 * in-flight poll, and never longer than the daily backstop that recovers any signal that was lost.
 */
export function nextSleepMs(input: WakeInput): number {
  const { now } = input;
  const runnable = input.state === 'ACTIVE' || input.state === 'MONITORING';
  const candidates: number[] = [(input.lastBackstopAt ?? now) + CAMPAIGN_BACKSTOP_INTERVAL_MS];
  if (input.retryAt !== null) {
    candidates.push(input.retryAt);
  }
  if (input.targets.some((t) => stateOf(t) === 'RUNNING')) {
    candidates.push(now + INFLIGHT_POLL_MS);
  }
  for (const t of input.targets) {
    if (
      input.campaign.staleAfterDays !== null &&
      input.campaign.staleAfterDays > 0 &&
      t.prStatus === 'OPEN' &&
      t.prOpenedAt !== null &&
      t.staleSince === null &&
      stateOf(t) === 'PR_OPENED'
    ) {
      const crossing = t.prOpenedAt + input.campaign.staleAfterDays * DAY_MS;
      if (crossing > now) {
        candidates.push(crossing);
      }
    }
  }
  if (runnable) {
    if (input.campaign.expiresAt !== null && input.campaign.expiresAt > now) {
      candidates.push(input.campaign.expiresAt);
    }
    if (input.campaign.hasCheck) {
      for (const t of input.targets) {
        if (input.excluded.has(t.id)) {
          continue;
        }
        const state = stateOf(t);
        if (state === 'SATISFIED') {
          const at = nextDueAt(t.lastCheckedAt, now, input.campaign.rescanIntervalHours);
          if (at !== null) {
            candidates.push(at);
          }
        } else if (state === 'MERGED') {
          candidates.push(t.lastCheckedAt === null ? now : t.lastCheckedAt + CHECK_RETRY_MS);
        }
      }
      const expired = input.campaign.expiresAt !== null && now >= input.campaign.expiresAt;
      if (input.campaign.hasScope && !input.discoveryFailed && !expired) {
        const at = nextDueAt(input.lastDiscoveryAt, now, input.campaign.rescanIntervalHours);
        if (at !== null) {
          candidates.push(at);
        }
      }
    }
  }
  const earliest = Math.min(...candidates);
  return Math.min(Math.max(earliest - now, MIN_SLEEP_MS), CAMPAIGN_BACKSTOP_INTERVAL_MS);
}

/** Whether discovery runs on this pass (spec §3 step 2). */
export function discoveryDue(
  campaign: Pick<PassCampaign, 'hasCheck' | 'hasScope' | 'rescanIntervalHours' | 'expiresAt'>,
  lastDiscoveryAt: number | null,
  now: number
): boolean {
  if (!campaign.hasScope || !campaign.hasCheck) {
    return false;
  }
  if (campaign.expiresAt !== null && now >= campaign.expiresAt) {
    return false;
  }
  return isDue(lastDiscoveryAt, now, campaign.rescanIntervalHours);
}

export type { TargetState };
