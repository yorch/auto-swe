/**
 * The decision logic of a campaign that is reconciled until its goal holds
 * (docs/specs/2026-11-25-campaigns-as-tracked-goals.md): target-state transitions, the gate and
 * backpressure decision, the transitive dependents of a failed upstream, the discovery diff,
 * staleness, regression handling, the campaign's own state decision and the counts the list shows.
 *
 * Pure and deterministic: no I/O, no clock (callers pass `now` as epoch milliseconds), no Prisma
 * and no Node API. The workflow isolate imports this file, so it uses only `import type` for
 * anything external. Every function is total: an input it cannot act on is answered with "no
 * change", never a throw.
 *
 * The state names mirror the `CampaignState` and `CampaignTargetState` Prisma enums. The retired
 * target values `NOT_AFFECTED` and `FAILED`, and the legacy campaign values `RUNNING` and
 * `COMPLETED_WITH_FAILURES`, are still accepted as input because old rows and the old workflow
 * write them; {@link normalizeTargetState} folds the first two into their replacements, and the
 * reconciler never writes any of the four.
 */

// ── Names ──

export const CAMPAIGN_TARGET_STATE_VALUES = [
  'PENDING',
  'BLOCKED',
  'RUNNING',
  'PR_OPENED',
  'MERGED',
  'SATISFIED',
  'NEEDS_ATTENTION',
  'SKIPPED',
  'CANCELLED',
  // Retired: written only by the legacy workflow and by rows that predate the migration.
  'NOT_AFFECTED',
  'FAILED',
] as const;
export type TargetState = (typeof CAMPAIGN_TARGET_STATE_VALUES)[number];

/** The states the reconciler writes. */
export type ReconcilerTargetState = Exclude<TargetState, 'NOT_AFFECTED' | 'FAILED'>;

export const CAMPAIGN_STATE_VALUES = [
  'STARTING',
  'PLANNING',
  'ACTIVE',
  'PAUSED',
  'MONITORING',
  'CANCELLING',
  'COMPLETED',
  'CANCELLED',
  // Legacy: written only by the old campaign workflow.
  'RUNNING',
  'COMPLETED_WITH_FAILURES',
  'FAILED_TO_START',
] as const;
export type CampaignStateValue = (typeof CAMPAIGN_STATE_VALUES)[number];

export type CampaignPlanValue = 'UNIFORM' | 'PLANNED';
export type CampaignGateValue = 'OPENED' | 'MERGED';
export type CampaignScopeKindValue = 'TEAM' | 'ORG';
export type CampaignWorkflowKindValue = 'LEGACY' | 'RECONCILER';
export type CampaignAttemptOutcomeValue = 'PR_OPENED' | 'NO_CHANGE' | 'FAILED' | 'CANCELLED';
export type PullRequestStatusValue = 'OPEN' | 'MERGED' | 'CLOSED';

/** Why a campaign is `PAUSED`. */
export const CAMPAIGN_PAUSED_REASONS = [
  'manual',
  'launcher-unavailable',
  'disabled',
  'budget',
] as const;
export type CampaignPausedReason = (typeof CAMPAIGN_PAUSED_REASONS)[number];

/** Passes a reconciler runs before it `continueAsNew`s. */
export const CAMPAIGN_RECONCILER_MAX_PASSES = 200;
/** The daily backstop that reads the database for anything a signal missed. */
export const CAMPAIGN_BACKSTOP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How many times a target may regress before it needs a person. */
export const DEFAULT_CAMPAIGN_REGRESSION_LIMIT = 3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Fold the retired target states into the ones that replace them. */
export function normalizeTargetState(state: TargetState): ReconcilerTargetState {
  if (state === 'NOT_AFFECTED') {
    return 'SATISFIED';
  }
  if (state === 'FAILED') {
    return 'NEEDS_ATTENTION';
  }
  return state;
}

/** A target in one of these states is final: the reconciler never moves it again. */
export const CAMPAIGN_TARGET_FINAL_STATES: readonly ReconcilerTargetState[] = [
  'SATISFIED',
  'SKIPPED',
  'CANCELLED',
];

export function isTargetFinal(state: TargetState): boolean {
  return CAMPAIGN_TARGET_FINAL_STATES.includes(normalizeTargetState(state));
}

/**
 * Whether a target is final for a campaign. A campaign with no check ends when its targets' pull
 * requests merge, so for it `MERGED` is final (no regression detection, no proof). With a check,
 * `MERGED` is transient: the check still has to confirm it.
 */
export function isTargetFinalFor(state: TargetState, opts: { hasCheck: boolean }): boolean {
  return isTargetFinal(state) || (!opts.hasCheck && normalizeTargetState(state) === 'MERGED');
}

/** A campaign in one of these states never moves again. */
export const CAMPAIGN_FINAL_STATES: readonly CampaignStateValue[] = [
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'CANCELLED',
  'FAILED_TO_START',
];

export function isCampaignFinal(state: CampaignStateValue): boolean {
  return CAMPAIGN_FINAL_STATES.includes(state);
}

// ── Target transitions ──

/** What happened to a target. The reconciler turns database facts into these. */
export type TargetEvent =
  /** The gate or a limit holds the target back. */
  | { type: 'block' }
  /** Nothing holds the target any more. */
  | { type: 'unblock' }
  /** The gateway wrote an attempt and the child run is starting. */
  | { type: 'attemptStarted' }
  /** The latest attempt's run ended. */
  | { type: 'attemptFinished'; outcome: CampaignAttemptOutcomeValue }
  /** The latest attempt's pull request, as `PullRequest.status` reads now. */
  | { type: 'pullRequest'; status: PullRequestStatusValue }
  /**
   * The check ran on the base branch. `couldNotRun` means it did not give an answer (an exit code
   * other than 0 or 1): the target stays where it is, since an unanswered check is neither a pass
   * nor a regression.
   */
  | { type: 'check'; satisfied: boolean; couldNotRun?: boolean }
  /** A person retried a `NEEDS_ATTENTION` target. */
  | { type: 'retry' }
  /** A person removed the target, or the launch decision no longer held for it. */
  | { type: 'remove' }
  /** The campaign was cancelled. */
  | { type: 'cancel' };

export interface TransitionTarget {
  state: TargetState;
  regressions: number;
}

export interface TransitionOptions {
  /** A target that regresses more often than this needs a person. */
  regressionLimit?: number;
}

export interface TransitionResult {
  state: ReconcilerTargetState;
  regressions: number;
  /** False when the event does not apply in this state; nothing then changed. */
  accepted: boolean;
  /** True when `state` differs from the input's state (after normalising a retired one). */
  changed: boolean;
}

function noChange(from: TransitionTarget, accepted: boolean): TransitionResult {
  const state = normalizeTargetState(from.state);
  return {
    accepted,
    changed: state !== from.state,
    regressions: from.regressions,
    state,
  };
}

function moved(from: TransitionTarget, to: ReconcilerTargetState, regressions?: number) {
  return {
    accepted: true,
    changed: to !== from.state,
    regressions: regressions ?? from.regressions,
    state: to,
  };
}

/**
 * The next target state for one event. A retired state is read as its replacement first, so the
 * old workflow's rows are handled. An event that makes no sense in the current state is refused
 * (`accepted: false`) and changes nothing.
 *
 * - A cancel stops what has not delivered anything. A draft that was opened (`PR_OPENED`,
 *   `MERGED`) and a target that finished keep their state, as `docs/campaigns.md` §9 has it.
 * - `check` with `satisfied: true` finishes any target that is not started, awaiting review,
 *   merged or needing a person. A `RUNNING` target is never finished by a check: its attempt
 *   reports first.
 * - `check` with `satisfied: false` on a `SATISFIED` target is a regression: back to `PENDING`
 *   with `regressions + 1`, or `NEEDS_ATTENTION` once that count passes the limit. On a `MERGED`
 *   target it means the merge did not satisfy the goal: `NEEDS_ATTENTION`.
 * - A pull request that is `OPEN` again, or `MERGED`, moves a `NEEDS_ATTENTION` target back to
 *   `PR_OPENED` or on to `MERGED`, since `NEEDS_ATTENTION` may have been a close that was undone.
 */
export function transitionTarget(
  target: TransitionTarget,
  event: TargetEvent,
  options: TransitionOptions = {}
): TransitionResult {
  const state = normalizeTargetState(target.state);
  const limit = options.regressionLimit ?? DEFAULT_CAMPAIGN_REGRESSION_LIMIT;
  const same = (accepted: boolean) => noChange(target, accepted);

  switch (state) {
    case 'SKIPPED':
    case 'CANCELLED':
      return same(false);

    case 'PENDING':
      switch (event.type) {
        case 'block':
          return moved(target, 'BLOCKED');
        case 'unblock':
          return same(false);
        case 'attemptStarted':
          return moved(target, 'RUNNING');
        case 'check':
          return event.satisfied && !event.couldNotRun ? moved(target, 'SATISFIED') : same(true);
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return moved(target, 'CANCELLED');
        default:
          return same(false);
      }

    case 'BLOCKED':
      switch (event.type) {
        case 'block':
          return same(true);
        case 'unblock':
          return moved(target, 'PENDING');
        case 'attemptStarted':
          return moved(target, 'RUNNING');
        case 'check':
          return event.satisfied && !event.couldNotRun ? moved(target, 'SATISFIED') : same(true);
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return moved(target, 'CANCELLED');
        default:
          return same(false);
      }

    case 'RUNNING':
      switch (event.type) {
        case 'attemptFinished':
          switch (event.outcome) {
            case 'PR_OPENED':
              return moved(target, 'PR_OPENED');
            case 'NO_CHANGE':
              return moved(target, 'SATISFIED');
            case 'FAILED':
              return moved(target, 'NEEDS_ATTENTION');
            case 'CANCELLED':
              return moved(target, 'CANCELLED');
            default:
              return same(false);
          }
        case 'cancel':
          return moved(target, 'CANCELLED');
        default:
          return same(false);
      }

    case 'PR_OPENED':
      switch (event.type) {
        case 'pullRequest':
          if (event.status === 'MERGED') {
            return moved(target, 'MERGED');
          }
          if (event.status === 'CLOSED') {
            return moved(target, 'NEEDS_ATTENTION');
          }
          return same(true);
        case 'check':
          return event.satisfied && !event.couldNotRun ? moved(target, 'SATISFIED') : same(true);
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return same(true);
        default:
          return same(false);
      }

    case 'MERGED':
      switch (event.type) {
        case 'check':
          if (event.couldNotRun) {
            return same(true);
          }
          return moved(target, event.satisfied ? 'SATISFIED' : 'NEEDS_ATTENTION');
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return same(true);
        default:
          return same(false);
      }

    case 'SATISFIED':
      switch (event.type) {
        case 'check': {
          if (event.satisfied || event.couldNotRun) {
            return same(true);
          }
          const regressions = target.regressions + 1;
          return moved(target, regressions > limit ? 'NEEDS_ATTENTION' : 'PENDING', regressions);
        }
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return same(true);
        default:
          return same(false);
      }

    case 'NEEDS_ATTENTION':
      switch (event.type) {
        case 'retry':
          return moved(target, 'PENDING');
        case 'check':
          return event.satisfied && !event.couldNotRun ? moved(target, 'SATISFIED') : same(true);
        case 'pullRequest':
          if (event.status === 'OPEN') {
            return moved(target, 'PR_OPENED');
          }
          if (event.status === 'MERGED') {
            return moved(target, 'MERGED');
          }
          return same(true);
        case 'remove':
          return moved(target, 'SKIPPED');
        case 'cancel':
          return moved(target, 'CANCELLED');
        default:
          return same(false);
      }

    default:
      return same(false);
  }
}

// ── Dependencies ──

export interface DependencyNode {
  id: string;
  dependsOn: readonly string[];
}

/**
 * The transitive closure of the targets that depend on `failedId`: if B depends on A and C on B,
 * the dependents of A are `{B, C}`. The failed target itself is never in the result, even when it
 * is reachable through a cycle, because the caller already holds its verdict. A dependency on an id
 * that is not a node is ignored.
 */
export function computeTransitiveDependents(
  failedId: string,
  nodes: readonly DependencyNode[]
): Set<string> {
  const dependentsByDep = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      const list = dependentsByDep.get(dep) ?? [];
      list.push(node.id);
      dependentsByDep.set(dep, list);
    }
  }
  const visited = new Set<string>([failedId]);
  const dependents = new Set<string>();
  const stack = [failedId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) {
      continue;
    }
    for (const dependent of dependentsByDep.get(id) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        dependents.add(dependent);
        stack.push(dependent);
      }
    }
  }
  return dependents;
}

// ── Gate and backpressure ──

export type BlockReason =
  /** An upstream target has not opened its draft (gate `OPENED`) or has not finished (`MERGED`). */
  | { kind: 'waiting-upstream'; upstreamId: string; upstreamLabel: string }
  /** An upstream target, or one it waits for, needs a person or was skipped. */
  | { kind: 'upstream-failed'; upstreamId: string; upstreamLabel: string }
  /** The target's dependencies lead back to itself, so the gate can never open. */
  | { kind: 'dependency-cycle' }
  | { kind: 'max-parallel'; limit: number }
  | { kind: 'max-open-pull-requests'; limit: number };

export function describeBlockReason(reason: BlockReason): string {
  switch (reason.kind) {
    case 'waiting-upstream':
      return `Waiting for ${reason.upstreamLabel}`;
    case 'upstream-failed':
      return `${reason.upstreamLabel} did not finish and needs a person`;
    case 'dependency-cycle':
      return 'Its dependencies form a cycle';
    case 'max-parallel':
      return `${reason.limit} targets are already running`;
    case 'max-open-pull-requests':
      return `${reason.limit} draft pull requests are already awaiting review`;
    default:
      return 'Blocked';
  }
}

export interface ScheduleTarget {
  id: string;
  /** `org/repo`, used in block reasons. */
  label: string;
  state: TargetState;
  position: number;
  dependsOn: readonly string[];
}

export interface ScheduleInput {
  campaignState: CampaignStateValue;
  gate: CampaignGateValue;
  /** Whether the campaign has a check. Without one a merged upstream is as far as it can get. */
  hasCheck: boolean;
  maxParallel: number;
  /** Null (a legacy campaign) means no limit. */
  maxOpenPullRequests: number | null;
  targets: readonly ScheduleTarget[];
}

export interface ScheduleDecision {
  /** Target ids to start, in order. Each is `PENDING` or `BLOCKED` now. */
  start: string[];
  /** Every other `PENDING` or `BLOCKED` target, with why it waits. */
  blocked: Array<{ targetId: string; reason: BlockReason }>;
  /** Set when nothing may start because of the campaign's own state. */
  held: 'campaign-not-active' | null;
}

/** States of an upstream target that let a downstream one start under each gate. */
function gateOpen(upstream: ReconcilerTargetState, input: ScheduleInput): boolean {
  if (upstream === 'SATISFIED') {
    return true;
  }
  if (input.gate === 'OPENED') {
    return upstream === 'PR_OPENED' || upstream === 'MERGED';
  }
  // MERGED gate: the pull request merged and its check passed. A campaign with no check never
  // reaches SATISFIED by a merge, so for it the merge itself is the end.
  return upstream === 'MERGED' && !input.hasCheck;
}

const FAILED_UPSTREAM: readonly ReconcilerTargetState[] = [
  'NEEDS_ATTENTION',
  'SKIPPED',
  'CANCELLED',
];

/**
 * Why the dependencies of `target` hold it back, or null when every gate is open. A dependency
 * that names no target of the campaign is ignored. When the upstream that is not ready is itself
 * held by a failed one, the reason names the failed one, so a person sees the cause, not the
 * nearest link.
 */
function dependencyBlock(
  target: ScheduleTarget,
  byId: ReadonlyMap<string, ScheduleTarget>,
  input: ScheduleInput
): BlockReason | null {
  for (const depId of target.dependsOn) {
    const dep = byId.get(depId);
    if (!dep || depId === target.id) {
      continue;
    }
    if (gateOpen(normalizeTargetState(dep.state), input)) {
      continue;
    }
    // Follow the chain of unmet dependencies to its root, guarding against cycles.
    const visited = new Set<string>([target.id]);
    let current: ScheduleTarget = dep;
    for (;;) {
      if (visited.has(current.id)) {
        return { kind: 'dependency-cycle' };
      }
      visited.add(current.id);
      const currentState = normalizeTargetState(current.state);
      if (FAILED_UPSTREAM.includes(currentState)) {
        return { kind: 'upstream-failed', upstreamId: current.id, upstreamLabel: current.label };
      }
      if (currentState !== 'PENDING' && currentState !== 'BLOCKED') {
        break;
      }
      const next = current.dependsOn
        .map((id) => byId.get(id))
        .find(
          (candidate): candidate is ScheduleTarget =>
            candidate !== undefined &&
            candidate.id !== current.id &&
            !gateOpen(normalizeTargetState(candidate.state), input)
        );
      if (!next) {
        break;
      }
      current = next;
    }
    return { kind: 'waiting-upstream', upstreamId: dep.id, upstreamLabel: dep.label };
  }
  return null;
}

/**
 * Which `PENDING` and `BLOCKED` targets start now, in `position` order, and why the rest wait.
 * A target is blocked first by its gate, then by `maxParallel` (children in flight, counting the
 * ones this call starts), then by `maxOpenPullRequests` (open drafts plus running attempts, which will become drafts, plus
 * the starts of this call).
 * A campaign that is not `ACTIVE` (or `STARTING`) starts nothing and reports no blocks, so its
 * rows are left as they are.
 */
export function decideSchedule(input: ScheduleInput): ScheduleDecision {
  if (input.campaignState !== 'ACTIVE' && input.campaignState !== 'STARTING') {
    return { blocked: [], held: 'campaign-not-active', start: [] };
  }
  const byId = new Map(input.targets.map((t) => [t.id, t]));
  let inFlight = 0;
  let openDrafts = 0;
  for (const target of input.targets) {
    const state = normalizeTargetState(target.state);
    if (state === 'RUNNING') {
      inFlight += 1;
    } else if (state === 'PR_OPENED') {
      openDrafts += 1;
    }
  }
  // A running attempt becomes a draft, so it counts toward the draft bound now.
  const candidates = input.targets
    .filter((t) => t.state === 'PENDING' || t.state === 'BLOCKED')
    .slice()
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const maxParallel = Math.max(0, Math.floor(input.maxParallel));
  const start: string[] = [];
  const blocked: ScheduleDecision['blocked'] = [];
  for (const target of candidates) {
    const gateReason = dependencyBlock(target, byId, input);
    if (gateReason) {
      blocked.push({ reason: gateReason, targetId: target.id });
    } else if (inFlight + start.length >= maxParallel) {
      blocked.push({ reason: { kind: 'max-parallel', limit: maxParallel }, targetId: target.id });
    } else if (
      input.maxOpenPullRequests !== null &&
      openDrafts + inFlight + start.length >= input.maxOpenPullRequests
    ) {
      blocked.push({
        reason: { kind: 'max-open-pull-requests', limit: input.maxOpenPullRequests },
        targetId: target.id,
      });
    } else {
      start.push(target.id);
    }
  }
  return { blocked, held: null, start };
}

// ── Discovery ──

export interface DiscoveryCandidate {
  connectionId: string;
  teamId: string;
  /** `org/repo`. */
  label: string;
  /** Whether the launcher is still authorized to start work in the repository. */
  reachable: boolean;
  /** Why not, when `reachable` is false. */
  unreachableReason?: string;
  /** The check's answer on the base branch; null when it could not run. */
  satisfied: boolean | null;
}

export interface DiscoveryInput {
  /** The scope's repositories the check ran over, in the order they should be added. */
  candidates: readonly DiscoveryCandidate[];
  /** Repositories that are already targets, whatever their state. */
  targetConnectionIds: readonly string[];
  /** Repositories already recorded as proposals. */
  proposalConnectionIds: readonly string[];
  /** The campaign's current number of targets. */
  targetCount: number;
  /** `workflow.campaignMaxTargets`. */
  maxTargets: number;
}

export interface DiscoveryDiff {
  /** Become targets, appended in this order. */
  add: DiscoveryCandidate[];
  /** Matched but the launcher may not start work there: recorded, never started. */
  propose: Array<{ connectionId: string; teamId: string; label: string; reason: string }>;
  /** Matched and reachable, but the target limit is full; found again on a later pass. */
  overLimit: DiscoveryCandidate[];
  /** The check could not run, so nothing is decided about them. */
  unchecked: DiscoveryCandidate[];
}

/**
 * Which repositories of a scope become targets. A repository already a target or a proposal, a
 * duplicate, and one the check says is satisfied are left alone. An unsatisfied one the launcher
 * may reach is added while the target limit has room; one the launcher may not reach is proposed
 * with the reason. A repository whose check could not run is neither added nor proposed.
 */
export function diffDiscovery(input: DiscoveryInput): DiscoveryDiff {
  const known = new Set<string>([...input.targetConnectionIds, ...input.proposalConnectionIds]);
  const diff: DiscoveryDiff = { add: [], overLimit: [], propose: [], unchecked: [] };
  let room = Math.max(0, Math.floor(input.maxTargets) - Math.max(0, input.targetCount));
  for (const candidate of input.candidates) {
    if (known.has(candidate.connectionId)) {
      continue;
    }
    known.add(candidate.connectionId);
    if (candidate.satisfied === null) {
      diff.unchecked.push(candidate);
    } else if (candidate.satisfied) {
      // Satisfied already: not a target and nothing to record.
    } else if (!candidate.reachable) {
      diff.propose.push({
        connectionId: candidate.connectionId,
        label: candidate.label,
        reason: candidate.unreachableReason ?? 'The launcher may not start work in this repository',
        teamId: candidate.teamId,
      });
    } else if (room > 0) {
      room -= 1;
      diff.add.push(candidate);
    } else {
      diff.overLimit.push(candidate);
    }
  }
  return diff;
}

// ── Time: staleness and due checks ──

/**
 * When a draft became stale, as epoch milliseconds, or null when it is not stale. A target is
 * stale while its pull request is `OPEN` and has been open for `staleAfterDays` or longer. Once
 * set, `staleSince` is kept; it is the moment the draft crossed the line, so the answer does not
 * depend on when the reconciler happened to notice.
 */
export function decideStaleSince(input: {
  state: TargetState;
  /** `PullRequest.status` of the latest attempt's pull request; null when there is none. */
  prStatus: PullRequestStatusValue | null;
  prOpenedAt: number | null;
  staleSince: number | null;
  staleAfterDays: number | null;
  now: number;
}): number | null {
  if (
    normalizeTargetState(input.state) !== 'PR_OPENED' ||
    input.prStatus !== 'OPEN' ||
    input.prOpenedAt === null ||
    input.staleAfterDays === null ||
    !(input.staleAfterDays > 0)
  ) {
    return null;
  }
  const crossedAt = input.prOpenedAt + input.staleAfterDays * DAY_MS;
  if (input.now < crossedAt) {
    return null;
  }
  return input.staleSince ?? crossedAt;
}

/**
 * Whether a periodic job (a re-check, a discovery) is due. Never run counts as due; a missing or
 * non-positive interval never is, so a campaign with no rescan interval is not polled.
 */
export function isDue(lastAt: number | null, now: number, intervalHours: number | null): boolean {
  if (intervalHours === null || !(intervalHours > 0)) {
    return false;
  }
  return lastAt === null || now - lastAt >= intervalHours * HOUR_MS;
}

/** The time a periodic job next falls due, or null when it never does. */
export function nextDueAt(
  lastAt: number | null,
  now: number,
  intervalHours: number | null
): number | null {
  if (intervalHours === null || !(intervalHours > 0)) {
    return null;
  }
  return lastAt === null ? now : lastAt + intervalHours * HOUR_MS;
}

// ── The campaign's own state ──

export interface CampaignStateDecisionInput {
  state: CampaignStateValue;
  targetStates: readonly TargetState[];
  /** Whether a scope is set, so the campaign can find new targets. */
  hasScope: boolean;
  /** Whether the campaign's recipe has a check. Without one, `MERGED` is a final target state. */
  hasCheck: boolean;
  /** Epoch milliseconds; null means no expiry. */
  expiresAt: number | null;
  now: number;
}

/**
 * Where an `ACTIVE` or `MONITORING` campaign goes next (spec §2). Every other state is returned
 * unchanged: a paused, planning, cancelling or finished campaign is moved by a person or by the
 * cancel path, not by this decision.
 *
 * - Some target is not final: `ACTIVE`. A `MONITORING` campaign whose target regressed returns here.
 * - Every target is final (`SATISFIED`, `SKIPPED`, `CANCELLED`, and `MERGED` when there is no
 *   check; none at all counts) and there is no
 *   scope, or `expiresAt` has passed: `COMPLETED`.
 * - Every target is final and a scope is set, and the campaign has not expired: `MONITORING`.
 */
export function decideCampaignState(input: CampaignStateDecisionInput): {
  state: CampaignStateValue;
  changed: boolean;
} {
  if (input.state !== 'ACTIVE' && input.state !== 'MONITORING') {
    return { changed: false, state: input.state };
  }
  let next: CampaignStateValue;
  if (!input.targetStates.every((s) => isTargetFinalFor(s, { hasCheck: input.hasCheck }))) {
    next = 'ACTIVE';
  } else {
    const expired = input.expiresAt !== null && input.now >= input.expiresAt;
    next = !input.hasScope || expired ? 'COMPLETED' : 'MONITORING';
  }
  return { changed: next !== input.state, state: next };
}

/**
 * Why an `ACTIVE`, `MONITORING` or `STARTING` campaign must pause on this pass, or null. The kill
 * switch outranks an unavailable launcher, which outranks the budget.
 */
export function decidePause(input: {
  state: CampaignStateValue;
  campaignsEnabled: boolean;
  launcherAvailable: boolean;
  budgetExceeded: boolean;
}): CampaignPausedReason | null {
  if (input.state !== 'ACTIVE' && input.state !== 'MONITORING' && input.state !== 'STARTING') {
    return null;
  }
  if (!input.campaignsEnabled) {
    return 'disabled';
  }
  if (!input.launcherAvailable) {
    return 'launcher-unavailable';
  }
  if (input.budgetExceeded) {
    return 'budget';
  }
  return null;
}

// ── Counts ──

export interface CampaignCounts {
  total: number;
  pending: number;
  blocked: number;
  running: number;
  prOpened: number;
  merged: number;
  satisfied: number;
  needsAttention: number;
  skipped: number;
  cancelled: number;
}

/** Counts over the reconciler's states; the retired ones are folded into their replacements. */
export function countTargets(states: readonly TargetState[]): CampaignCounts {
  const counts: CampaignCounts = {
    blocked: 0,
    cancelled: 0,
    merged: 0,
    needsAttention: 0,
    pending: 0,
    prOpened: 0,
    running: 0,
    satisfied: 0,
    skipped: 0,
    total: 0,
  };
  for (const raw of states) {
    counts.total += 1;
    switch (normalizeTargetState(raw)) {
      case 'PENDING':
        counts.pending += 1;
        break;
      case 'BLOCKED':
        counts.blocked += 1;
        break;
      case 'RUNNING':
        counts.running += 1;
        break;
      case 'PR_OPENED':
        counts.prOpened += 1;
        break;
      case 'MERGED':
        counts.merged += 1;
        break;
      case 'SATISFIED':
        counts.satisfied += 1;
        break;
      case 'NEEDS_ATTENTION':
        counts.needsAttention += 1;
        break;
      case 'SKIPPED':
        counts.skipped += 1;
        break;
      case 'CANCELLED':
        counts.cancelled += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}
