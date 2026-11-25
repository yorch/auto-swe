import type {
  CampaignAttemptDto,
  CampaignBlockedReason,
  CampaignCountsDto,
  CampaignTargetDto,
} from '@auto-swe/shared/lib/campaignApi';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import {
  type CampaignAttemptOutcomeValue,
  type CampaignGateValue,
  type CampaignPausedReason,
  type CampaignPlanValue,
  type CampaignScopeKindValue,
  type CampaignStateValue,
  type CampaignWorkflowKindValue,
  isTargetFinalFor,
  normalizeTargetState,
  type PullRequestStatusValue,
  type ReconcilerTargetState,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';

/**
 * Plain-language names for the recipes the gateway's catalogue knows. `@2` recipes define a
 * read-only check beside the change, which is what discovery and merge verification need; `@1`
 * recipes only make the change.
 */
export const RECIPE_OPTIONS = [
  {
    description: 'The brief is everything the agent has.',
    label: 'No recipe (agent only)',
    value: '',
  },
  {
    description:
      'Root package.json with a package-lock.json. Version such as 4.17.21. Also checks each repository, so the campaign can find repositories that start to match and confirm that a merge fixed one.',
    label: 'npm dependency (npm-dependency@2)',
    value: 'npm-dependency@2',
  },
  {
    description:
      'Root go.mod without vendor/ or go.work. Version such as v1.9.0. Also checks each repository, so the campaign can find repositories that start to match and confirm that a merge fixed one.',
    label: 'Go module (go-module@2)',
    value: 'go-module@2',
  },
  {
    description:
      'Makes the change only: no discovery of new repositories and no verification of merges.',
    label: 'npm dependency, change only (npm-dependency@1)',
    value: 'npm-dependency@1',
  },
  {
    description:
      'Makes the change only: no discovery of new repositories and no verification of merges.',
    label: 'Go module, change only (go-module@1)',
    value: 'go-module@1',
  },
] as const;

/**
 * The ranges the start form accepts, mirroring `CampaignCreateBodySchema`; a test checks the two
 * agree. The gateway clamps each to the owning team's own settings.
 */
export const CAMPAIGN_FORM_LIMITS = {
  budgetUsd: { label: 'Monthly budget', max: 1_000_000, min: 0 },
  lifetimeDays: { label: 'Lifetime', max: 365, min: 1 },
  maxOpenPullRequests: { label: 'Open pull requests at most', max: 200, min: 1 },
  rescanIntervalHours: { label: 'Re-check interval', max: 720, min: 1 },
  staleAfterDays: { label: 'Stale after', max: 365, min: 1 },
} as const;

/** What a campaign changes, for a list row: the recipe and its package, or "agent only". */
export function recipeSummary(
  recipeRef: string | null,
  recipeParams?: { packageName: string; targetVersion: string } | null
): string {
  if (!recipeRef) {
    return 'Agent only';
  }
  return recipeParams
    ? `${recipeParams.packageName} → ${recipeParams.targetVersion} (${recipeRef})`
    : recipeRef;
}

// ── Labels ──
//
// One table per enum, typed as a `Record` over the whole union so a value added in shared code
// is a compile error here, and `campaignDisplay.test.ts` walks the runtime value lists as well.

export const CAMPAIGN_STATE_LABELS: Record<CampaignStateValue, string> = {
  ACTIVE: 'Active',
  CANCELLED: 'Cancelled',
  CANCELLING: 'Cancelling',
  COMPLETED: 'Completed',
  COMPLETED_WITH_FAILURES: 'Completed with failures',
  FAILED_TO_START: 'Failed to start',
  MONITORING: 'Monitoring',
  PAUSED: 'Paused',
  PLANNING: 'Awaiting confirmation',
  RUNNING: 'Running',
  STARTING: 'Starting',
};

export const TARGET_STATE_LABELS: Record<TargetState, string> = {
  BLOCKED: 'Blocked',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  MERGED: 'Merged, checking',
  NEEDS_ATTENTION: 'Needs attention',
  NOT_AFFECTED: 'Not affected',
  PENDING: 'Not started',
  PR_OPENED: 'In review',
  RUNNING: 'Running',
  SATISFIED: 'Satisfied',
  SKIPPED: 'Skipped',
};

export type StateTone = 'accent' | 'danger' | 'info' | 'live' | 'neutral' | 'success' | 'warning';

export const CAMPAIGN_STATE_TONES: Record<CampaignStateValue, StateTone> = {
  ACTIVE: 'live',
  CANCELLED: 'neutral',
  CANCELLING: 'warning',
  COMPLETED: 'success',
  COMPLETED_WITH_FAILURES: 'warning',
  FAILED_TO_START: 'danger',
  MONITORING: 'info',
  PAUSED: 'warning',
  PLANNING: 'accent',
  RUNNING: 'live',
  STARTING: 'live',
};

export const TARGET_STATE_TONES: Record<TargetState, StateTone> = {
  BLOCKED: 'warning',
  CANCELLED: 'neutral',
  FAILED: 'danger',
  MERGED: 'info',
  NEEDS_ATTENTION: 'danger',
  NOT_AFFECTED: 'success',
  PENDING: 'neutral',
  PR_OPENED: 'accent',
  RUNNING: 'live',
  SATISFIED: 'success',
  SKIPPED: 'neutral',
};

/** The campaign's state as a person reads it. */
export function campaignStateLabel(state: CampaignStateValue): string {
  return CAMPAIGN_STATE_LABELS[state] ?? state.replace(/_/g, ' ').toLowerCase();
}

/**
 * Whether the campaign has a check that confirms a merge. A campaign without one is done when its
 * pull requests merge. A legacy campaign never ran the reconciler, so it keeps the original
 * reading (`MERGED` is not final for it).
 */
export function campaignHasCheck(campaign: {
  recipeRef: string | null;
  workflowKind: CampaignWorkflowKindValue;
}): boolean {
  return campaign.workflowKind === 'LEGACY' || recipeSupportsCheck(campaign.recipeRef);
}

/** What a merged target is called for a campaign with no check: nothing is left to confirm it. */
export const MERGED_NO_CHECK_LABEL = 'Merged (no check to confirm)';

/**
 * A target's state as a person reads it. The retired values the legacy workflow writes are read
 * as the states that replaced them first, so a legacy `FAILED` row says "Needs attention".
 */
export function targetStateLabel(state: TargetState, opts: { hasCheck?: boolean } = {}): string {
  const normalized = normalizeTargetState(state);
  if (normalized === 'MERGED' && opts.hasCheck === false) {
    return MERGED_NO_CHECK_LABEL;
  }
  return TARGET_STATE_LABELS[normalized] ?? normalized.replace(/_/g, ' ').toLowerCase();
}

export function targetStateTone(state: TargetState, opts: { hasCheck?: boolean } = {}): StateTone {
  const normalized = normalizeTargetState(state);
  if (normalized === 'MERGED' && opts.hasCheck === false) {
    return 'success';
  }
  return TARGET_STATE_TONES[normalized] ?? 'neutral';
}

/** Why a campaign is paused, in a few words for a list row. */
export const PAUSED_REASON_LABELS: Record<CampaignPausedReason, string> = {
  budget: 'budget reached',
  disabled: 'campaigns switched off',
  'launcher-unavailable': 'launcher unavailable',
  manual: 'paused by a person',
};

/** Why a campaign is paused, in words a reader can act on. */
export const PAUSED_REASON_TEXT: Record<CampaignPausedReason, string> = {
  budget:
    'The campaign reached its monthly budget, so no repository starts until it is raised or a new month begins. Runs already in flight finish.',
  disabled:
    'Campaigns were switched off for the owning team or for a team that owns a target. Nothing starts until they are switched back on and a team lead or administrator resumes it. Runs already in flight finish.',
  'launcher-unavailable':
    'The person this campaign acts as is no longer available: their account was deactivated or they left the organization. A lead of the owning team can take it over. Runs already in flight finish.',
  manual:
    'A person paused it. No repository starts until someone resumes it. Runs already in flight finish.',
};

export const BLOCKED_KIND_LABELS: Record<CampaignBlockedReason['kind'], string> = {
  'dependency-cycle': 'Dependency cycle',
  'max-open-pull-requests': 'Waiting for reviews',
  'max-parallel': 'Waiting for a free slot',
  'upstream-failed': 'Upstream needs attention',
  'waiting-upstream': 'Waiting for an upstream repository',
};

export const ATTEMPT_OUTCOME_LABELS: Record<CampaignAttemptOutcomeValue, string> = {
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  NO_CHANGE: 'Nothing to change',
  PR_OPENED: 'Draft pull request opened',
};

export const PATH_LABELS: Record<NonNullable<CampaignTargetDto['path']>, string> = {
  AGENT: 'Agent',
  NONE: 'No change',
  RECIPE: 'Recipe',
  RECIPE_THEN_AGENT: 'Recipe, then agent',
};

export const VERIFICATION_LABELS: Record<NonNullable<CampaignTargetDto['verification']>, string> = {
  FAILED: 'Failed',
  NOT_RUN: 'Not run',
  PASSED: 'Passed',
};

export const PULL_REQUEST_STATUS_LABELS: Record<PullRequestStatusValue, string> = {
  CLOSED: 'Closed without merging',
  MERGED: 'Merged',
  OPEN: 'Open',
};

export const PLAN_LABELS: Record<CampaignPlanValue, string> = {
  PLANNED: 'Planned per repository',
  UNIFORM: 'Same change everywhere',
};

export const GATE_LABELS: Record<CampaignGateValue, string> = {
  MERGED: 'An upstream pull request has merged and its check passed',
  OPENED: 'An upstream draft pull request is open',
};

export const SCOPE_KIND_LABELS: Record<CampaignScopeKindValue, string> = {
  ORG: 'Every repository of the organization',
  TEAM: 'Every repository of one team',
};

export const WORKFLOW_KIND_LABELS: Record<CampaignWorkflowKindValue, string> = {
  LEGACY: 'Original (opens drafts, then ends)',
  RECONCILER: 'Tracked until the goal holds',
};

// ── Counts ──

export interface CampaignProgress {
  /** Repositories whose part is finished: satisfied, plus merged for a campaign with no check. */
  done: number;
  needsAttention: number;
  percent: number;
  satisfied: number;
  total: number;
}

/**
 * Progress is how many repositories satisfy the goal, over every repository including hidden ones.
 * With no check (`hasCheck` false) a merged pull request is as far as a repository goes, so it
 * counts as done; `satisfied` stays the number the check confirmed.
 */
export function campaignProgress(
  counts: CampaignCountsDto,
  opts: { hasCheck?: boolean } = {}
): CampaignProgress {
  const total = counts.total;
  const done = counts.satisfied + (opts.hasCheck === false ? counts.merged : 0);
  return {
    done,
    needsAttention: counts.needsAttention,
    percent: total ? Math.round((done / total) * 100) : 0,
    satisfied: counts.satisfied,
    total,
  };
}

/**
 * "2 in review · 3 running · 1 blocked": what is left besides satisfied and needing a person,
 * which the list shows on their own. Non-zero buckets only, in the order a reader asks about them.
 */
export function breakdownText(
  counts: CampaignCountsDto,
  opts: { hasCheck?: boolean } = {}
): string {
  const parts: [number, string][] = [
    [counts.prOpened, 'in review'],
    // With no check a merge is counted as done, so it is not "left" and not listed here.
    [opts.hasCheck === false ? 0 : counts.merged, 'merged, checking'],
    [counts.running, 'running'],
    [counts.blocked, 'blocked'],
    [counts.pending, 'not started'],
    [counts.skipped, 'skipped'],
    [counts.cancelled, 'cancelled'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
}

/** The ticket ID every child of a campaign carries, which is how its pull requests are found. */
export function campaignTicketId(campaignId: string): string {
  return `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
}

// ── Targets ──

export type TargetGroupId = 'attention' | 'review' | 'progress' | 'satisfied' | 'closed';

export interface TargetGroup {
  hint: string;
  id: TargetGroupId;
  targets: CampaignTargetDto[];
  title: string;
}

const GROUP_OF: Record<ReconcilerTargetState, TargetGroupId> = {
  BLOCKED: 'progress',
  CANCELLED: 'closed',
  MERGED: 'review',
  NEEDS_ATTENTION: 'attention',
  PENDING: 'progress',
  PR_OPENED: 'review',
  RUNNING: 'progress',
  SATISFIED: 'satisfied',
  SKIPPED: 'closed',
};

const GROUPS: { hint: string; id: TargetGroupId; title: string }[] = [
  { hint: 'A person has to act before these can move.', id: 'attention', title: 'Needs attention' },
  {
    hint: 'A draft pull request is waiting for review or a merge.',
    id: 'review',
    title: 'In review',
  },
  {
    hint: 'Running now, waiting for a free slot or an upstream repository, or not started yet.',
    id: 'progress',
    title: 'Running or blocked',
  },
  { hint: 'The check passes on the base branch.', id: 'satisfied', title: 'Satisfied' },
  { hint: 'Left out of the campaign.', id: 'closed', title: 'Skipped or cancelled' },
];

/**
 * Targets grouped by the question a reader has, in the order they ask it: what needs me, what is
 * waiting for review, what is moving, what is done, what was dropped. Empty groups are left out and
 * each group keeps the launch order. A retired state is grouped as the state that replaced it.
 */
export function groupTargets(
  targets: readonly CampaignTargetDto[],
  opts: { hasCheck?: boolean } = {}
): TargetGroup[] {
  const sorted = [...targets].sort((a, b) => a.position - b.position);
  const hasCheck = opts.hasCheck !== false;
  const groupOf = (state: TargetState): TargetGroupId => {
    const normalized = normalizeTargetState(state);
    // A merge is final for a campaign with no check, so it sits with the done targets.
    return normalized === 'MERGED' && isTargetFinalFor(normalized, { hasCheck })
      ? 'satisfied'
      : GROUP_OF[normalized];
  };
  return GROUPS.map((group) => ({
    ...group,
    ...(group.id === 'satisfied' && !hasCheck
      ? {
          hint: 'Merged pull requests, and repositories that needed no change. The campaign has no check to confirm a merge.',
          title: 'Done',
        }
      : {}),
    targets: sorted.filter((t) => groupOf(t.state) === group.id),
  })).filter((group) => group.targets.length > 0);
}

/** The attempt with the highest number, or null for a target that has none. */
export function latestAttempt(target: CampaignTargetDto): CampaignAttemptDto | null {
  let latest: CampaignAttemptDto | null = null;
  for (const attempt of target.attempts) {
    if (!latest || attempt.n > latest.n) {
      latest = attempt;
    }
  }
  return latest;
}

/** Whether a person may retry the target (the gateway still decides). */
export function canRetryTarget(target: CampaignTargetDto): boolean {
  return normalizeTargetState(target.state) === 'NEEDS_ATTENTION';
}

/** Whether a person may take the target out of the campaign: not finished, not mid-attempt. */
export function canRemoveTarget(target: CampaignTargetDto): boolean {
  const state = normalizeTargetState(target.state);
  return (
    state !== 'SATISFIED' && state !== 'SKIPPED' && state !== 'CANCELLED' && state !== 'RUNNING'
  );
}

/** The `id` attribute a target's row carries, so a blocked target can link to what it waits for. */
export function targetAnchor(targetId: string): string {
  return `target-${targetId}`;
}
