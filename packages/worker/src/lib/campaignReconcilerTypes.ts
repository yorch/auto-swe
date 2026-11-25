import type {
  CampaignAttemptOutcomeValue,
  CampaignGateValue,
  CampaignPausedReason,
  CampaignPlanValue,
  CampaignStateValue,
  PullRequestStatusValue,
  ReconcilerTargetState,
  TargetState,
} from '@auto-swe/shared/lib/campaignState';
import type { CampaignReconcilerInput } from '@auto-swe/shared/types/workflow';

/**
 * The shapes that cross the boundary between `CampaignReconcilerWorkflow` and its activities.
 *
 * Type-only (every import above is erased), so the workflow isolate and the activities share one
 * definition. Times are epoch milliseconds: the workflow has no clock, so every instant it decides
 * on arrives in an activity result and is compared there with another instant from the same read.
 */

// ── What one pass reads ──

export interface PassTarget {
  id: string;
  /** Null when the repository was deleted after launch. */
  connectionId: string | null;
  teamId: string;
  /** `org/repo`, used in block reasons. */
  label: string;
  position: number;
  /** As stored; may be a retired value the old workflow wrote. */
  state: TargetState;
  dependsOn: string[];
  regressions: number;
  staleSince: number | null;
  lastCheckedAt: number | null;
  /** The reason the target is `BLOCKED` or `NEEDS_ATTENTION`; null otherwise. */
  failureReason: string | null;
  /** The latest attempt's number; 0 when the target has no attempt yet. */
  attemptN: number;
  /** The latest attempt's outcome; null while it is in flight or when there is none. */
  attemptOutcome: CampaignAttemptOutcomeValue | null;
  attemptFailureReason: string | null;
  /** `PullRequest.status` of the pull request the latest attempt's run opened. */
  prStatus: PullRequestStatusValue | null;
  prOpenedAt: number | null;
}

export interface PassCampaign {
  state: CampaignStateValue;
  plan: CampaignPlanValue;
  gate: CampaignGateValue;
  /** A scope is set, so the campaign can discover new targets. */
  hasScope: boolean;
  /** The recipe has a read-only check. */
  hasCheck: boolean;
  maxParallel: number;
  maxOpenPullRequests: number | null;
  staleAfterDays: number | null;
  rescanIntervalHours: number | null;
  expiresAt: number | null;
  /** `workflow.campaignsEnabled` holds for the owning team and every team that owns a live target. */
  campaignsEnabled: boolean;
  /** The launcher's account is active and (unless an admin) still in the organization. */
  launcherAvailable: boolean;
  /** The campaign's own monthly spend is at its `budgetUsd`. */
  budgetExceeded: boolean;
  /** `workflow.campaignMaxTargets` for the owning team. */
  maxTargets: number;
}

export interface CampaignPassSnapshot {
  /** The database's clock when the snapshot was read. */
  nowMs: number;
  campaign: PassCampaign;
  /** A planned campaign's briefs have been written. */
  planned: boolean;
  targets: PassTarget[];
  /** Repositories discovery already recorded as proposals. */
  proposalConnectionIds: string[];
}

// ── What a pass writes ──

export interface TargetUpdate {
  targetId: string;
  teamId: string;
  /** The state the decision was made from; the write is conditional on it. */
  expect: TargetState;
  state: ReconcilerTargetState;
  regressions?: number;
  /** Absent: leave. `null`: clear. A string: set (bounded and masked by the activity). */
  failureReason?: string | null;
  /** Absent: leave. `null`: clear. A number: epoch milliseconds. */
  staleSince?: number | null;
}

export type CampaignStateWrite = {
  from: CampaignStateValue;
  to: 'ACTIVE' | 'MONITORING' | 'COMPLETED' | 'PAUSED';
  pausedReason?: CampaignPausedReason;
};

export interface RecordCampaignPassInput {
  campaignId: string;
  updates: TargetUpdate[];
  addTargets: Array<{ connectionId: string; teamId: string; label: string }>;
  proposals: Array<{ connectionId: string; reason: string }>;
  campaign?: CampaignStateWrite;
}

export interface RecordCampaignPassResult {
  /** Targets created by `addTargets`, in order; one the campaign already had is absent. */
  added: Array<{
    targetId: string;
    connectionId: string;
    teamId: string;
    label: string;
    position: number;
  }>;
  /** Updates whose condition no longer held (a retry already landed, or the row moved). */
  skipped: number;
  /** Whether the campaign state write took effect. */
  campaignChanged: boolean;
}

// ── Attempts ──

export interface StartCampaignAttemptInput {
  campaignId: string;
  targetId: string;
  /** The number the new attempt will have: the latest attempt's `n` plus one. */
  attemptN: number;
}

export type StartCampaignAttemptResult =
  | { ok: true; attemptId: string; n: number; runId: string | null; workflowId: string }
  | { ok: false; code: string; message: string };

// ── Checks ──

export interface RunCampaignCheckInput {
  campaignId: string;
  targetId: string;
}

export interface RunCampaignCheckResult {
  targetId: string;
  /**
   * `skipped`: the check was not run (no check, the target moved, the campaign is not active).
   * `could-not-run`: it ran and gave no answer; the state did not move.
   */
  status: 'satisfied' | 'not-satisfied' | 'could-not-run' | 'skipped';
  state: ReconcilerTargetState;
  regressions: number;
  lastCheckedAt: number | null;
  /** The write landed and moved the state (false for a skip, a lost race or an unchanged state). */
  changed: boolean;
  /** The reason now on the target, when the check set or cleared one; absent when it did not. */
  failureReason?: string | null;
  /** Why the check could not run or was skipped; fixed-shape text, safe to store. */
  reason?: string;
}

export interface DiscoverCampaignTargetsInput {
  campaignId: string;
  /** Where the previous call stopped; 0 for the first. */
  cursor: number;
  /** Repositories to check at most (never more than one chunk); a chunk when absent. */
  limit?: number;
  /** Candidates to collect at most; the call stops right after the one that reaches it. */
  maxCandidates?: number;
}

/** Where a scope walk stands (see `DiscoveryWalk` in the workflow's pure module). */
export interface DiscoveryWalkState {
  cursor: number;
  walked: number;
  candidates: number;
}

/**
 * The reconciler's input: the shared start input plus the walk a previous execution left, which
 * only `continueAsNew` sets.
 */
export type ReconcilerWorkflowInput = CampaignReconcilerInput & {
  discoveryWalk?: DiscoveryWalkState | null;
};

export interface DiscoveredCandidate {
  connectionId: string;
  teamId: string;
  label: string;
  reachable: boolean;
  unreachableReason?: string;
  satisfied: boolean | null;
}

export interface DiscoverCampaignTargetsResult {
  candidates: DiscoveredCandidate[];
  /** Null when the scope has been walked to its end. */
  nextCursor: number | null;
}

export interface PlanCampaignBriefsResult {
  planned: number;
  edges: number;
}

export interface FinalizeCampaignInput {
  campaignId: string;
  outcome: 'COMPLETED' | 'CANCELLED';
}
