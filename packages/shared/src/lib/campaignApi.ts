import { z } from 'zod';
import { BUDGET_TIERS, CAMPAIGN_DESCRIPTION_MAX_LENGTH } from '../types/workflow.js';
import { campaignTextProblem } from './campaignOutcome.js';
import {
  CAMPAIGN_PAUSED_REASONS,
  CAMPAIGN_STATE_VALUES,
  CAMPAIGN_TARGET_STATE_VALUES,
} from './campaignState.js';

/**
 * Wire shapes of the campaign REST API (`/api/v1/campaigns`), shared by the gateway (which
 * produces them), the dashboard (which consumes them) and the worker (which calls the attempt
 * route with a campaign token). Dates are ISO strings on the wire. Every field the reconciler
 * added is additive: a response from the legacy workflow answers the same shapes with the new
 * fields at their defaults.
 */

/** The registry's ceiling for `workflow.campaignMaxTargets`; bounds an id list before any lookup. */
export const CAMPAIGN_MAX_REPO_IDS = 200;

export const CampaignStateSchema = z.enum(CAMPAIGN_STATE_VALUES);
export const CampaignTargetStateSchema = z.enum(CAMPAIGN_TARGET_STATE_VALUES);
export const CampaignPlanSchema = z.enum(['UNIFORM', 'PLANNED']);
export const CampaignGateSchema = z.enum(['OPENED', 'MERGED']);
export const CampaignScopeKindSchema = z.enum(['TEAM', 'ORG']);
export const CampaignWorkflowKindSchema = z.enum(['LEGACY', 'RECONCILER']);
export const CampaignPausedReasonSchema = z.enum(CAMPAIGN_PAUSED_REASONS);
export const CampaignAttemptOutcomeSchema = z.enum([
  'PR_OPENED',
  'NO_CHANGE',
  'FAILED',
  'CANCELLED',
]);
export const CampaignTargetPathSchema = z.enum(['RECIPE', 'AGENT', 'RECIPE_THEN_AGENT', 'NONE']);
export const CampaignVerificationSchema = z.enum(['PASSED', 'FAILED', 'NOT_RUN']);

function refineCampaignText(text: string, ctx: z.RefinementCtx): void {
  const problem = campaignTextProblem(text);
  if (problem) {
    ctx.addIssue({ code: 'custom', message: problem });
  }
}

// ── Requests ──

/**
 * Where a campaign may discover new targets. A `TEAM` scope names the team; an `ORG` scope is the
 * campaign's own organization, so it takes no id (one that is given must match, which the route
 * checks).
 */
export const CampaignScopeBodySchema = z
  .object({ id: z.string().uuid().optional(), kind: CampaignScopeKindSchema })
  .superRefine((scope, ctx) => {
    if (scope.kind === 'TEAM' && !scope.id) {
      ctx.addIssue({ code: 'custom', message: 'a TEAM scope needs the team id', path: ['id'] });
    }
  });
export type CampaignScopeBody = z.infer<typeof CampaignScopeBodySchema>;

/** `POST /campaigns`. The first block is what the endpoint always took. */
export const CampaignCreateBodySchema = z.object({
  budget: z.enum(BUDGET_TIERS).optional(),
  // Added by the reconciler. Each is clamped or defaulted by the gateway from the setting registry
  // and frozen on the campaign.
  /** Dollars the campaign's attempts may spend in a month; frozen at launch. */
  budgetUsd: z.number().positive().max(1_000_000).optional(),
  description: z
    .string()
    .min(1, 'description is required — it is the agent brief and the pull request text')
    .max(CAMPAIGN_DESCRIPTION_MAX_LENGTH)
    .superRefine(refineCampaignText),
  gate: CampaignGateSchema.optional(),
  lifetimeDays: z.number().int().min(1).max(365).optional(),
  maxOpenPullRequests: z.number().int().min(1).max(CAMPAIGN_MAX_REPO_IDS).optional(),
  maxParallel: z.number().int().min(1).optional(),
  name: z.string().trim().min(1).max(120).superRefine(refineCampaignText),
  ownerTeamId: z.string().uuid(),
  plan: CampaignPlanSchema.optional(),
  recipe: z
    .object({
      params: z.record(z.string(), z.unknown()),
      ref: z.string().max(64),
    })
    .optional(),
  repoIds: z
    .array(z.string().uuid())
    .min(1)
    .max(CAMPAIGN_MAX_REPO_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'repoIds must be unique'),
  rescanIntervalHours: z.number().int().min(1).max(720).optional(),
  scope: CampaignScopeBodySchema.optional(),
  staleAfterDays: z.number().int().min(1).max(365).optional(),
});
export type CampaignCreateBody = z.infer<typeof CampaignCreateBodySchema>;

export const CampaignListQuerySchema = z.object({
  ownerTeamId: z.string().uuid().optional(),
  plan: CampaignPlanSchema.optional(),
  state: CampaignStateSchema.optional(),
});
export type CampaignListQuery = z.infer<typeof CampaignListQuerySchema>;

export const CampaignParamsSchema = z.object({ id: z.string().uuid() });
export const CampaignTargetParamsSchema = z.object({
  id: z.string().uuid(),
  targetId: z.string().uuid(),
});

/** `POST /:id/targets`: repositories to append. They count against the target limit. */
export const CampaignAddTargetsBodySchema = z.object({
  repoIds: z
    .array(z.string().uuid())
    .min(1)
    .max(CAMPAIGN_MAX_REPO_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'repoIds must be unique'),
});
export type CampaignAddTargetsBody = z.infer<typeof CampaignAddTargetsBodySchema>;

/** `DELETE /:id/targets/:targetId`: the reason is recorded on the skipped target. */
export const CampaignRemoveTargetBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).superRefine(refineCampaignText).optional(),
});
export type CampaignRemoveTargetBody = z.infer<typeof CampaignRemoveTargetBodySchema>;

/** `POST /:id/pause`. A pause by a person is recorded as `manual`. */
export const CampaignPauseBodySchema = z.object({
  note: z.string().trim().min(1).max(500).superRefine(refineCampaignText).optional(),
});
export type CampaignPauseBody = z.infer<typeof CampaignPauseBodySchema>;

/**
 * `POST /:id/targets/:targetId/attempts`: the worker's call to start an attempt. The idempotency
 * key (also accepted as a header) makes a retried call answer the attempt its first call started.
 */
export const CampaignStartAttemptBodySchema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type CampaignStartAttemptBody = z.infer<typeof CampaignStartAttemptBodySchema>;

// ── Responses ──

export const CampaignCountsSchema = z.object({
  blocked: z.number().int(),
  cancelled: z.number().int(),
  merged: z.number().int(),
  needsAttention: z.number().int(),
  pending: z.number().int(),
  prOpened: z.number().int(),
  running: z.number().int(),
  satisfied: z.number().int(),
  skipped: z.number().int(),
  total: z.number().int(),
});
export type CampaignCountsDto = z.infer<typeof CampaignCountsSchema>;

/** The pull request a target's latest attempt opened, read from `PullRequest`. */
export const CampaignTargetDeliverySchema = z.object({
  ciStatus: z.string().nullable(),
  isDraft: z.boolean().nullable(),
  mergedAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  /** `PullRequest.status`: OPEN, MERGED or CLOSED (closed unmerged). */
  status: z.enum(['OPEN', 'MERGED', 'CLOSED']).nullable(),
});
export type CampaignTargetDelivery = z.infer<typeof CampaignTargetDeliverySchema>;

export const CampaignAttemptDtoSchema = z.object({
  childWorkflowId: z.string().nullable(),
  failureReason: z.string().nullable(),
  finishedAt: z.string().nullable(),
  id: z.string(),
  n: z.number().int(),
  outcome: CampaignAttemptOutcomeSchema.nullable(),
  path: CampaignTargetPathSchema.nullable(),
  runId: z.string().nullable(),
  startedAt: z.string(),
  verification: CampaignVerificationSchema.nullable(),
});
export type CampaignAttemptDto = z.infer<typeof CampaignAttemptDtoSchema>;

/** Why a `BLOCKED` target waits; names the upstream where there is one. */
export const CampaignBlockedReasonSchema = z.object({
  kind: z.enum([
    'waiting-upstream',
    'upstream-failed',
    'dependency-cycle',
    'max-parallel',
    'max-open-pull-requests',
  ]),
  text: z.string(),
  upstreamId: z.string().nullable(),
  upstreamLabel: z.string().nullable(),
});
export type CampaignBlockedReason = z.infer<typeof CampaignBlockedReasonSchema>;

export const CampaignTargetDtoSchema = z.object({
  attempts: z.array(CampaignAttemptDtoSchema),
  blockedReason: CampaignBlockedReasonSchema.nullable(),
  brief: z.string().nullable(),
  // The last attempt's values, as read-time fields.
  childWorkflowId: z.string().nullable(),
  connectionId: z.string().nullable(),
  delivery: CampaignTargetDeliverySchema.nullable(),
  dependsOn: z.array(z.string()),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  failureReason: z.string().nullable(),
  finishedAt: z.string().nullable(),
  id: z.string(),
  lastCheckedAt: z.string().nullable(),
  lastCheckedSha: z.string().nullable(),
  liveStatus: z.string().nullable(),
  path: CampaignTargetPathSchema.nullable(),
  position: z.number().int(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  regressions: z.number().int(),
  repoLabel: z.string(),
  staleSince: z.string().nullable(),
  startedAt: z.string().nullable(),
  state: CampaignTargetStateSchema,
  verification: CampaignVerificationSchema.nullable(),
});
export type CampaignTargetDto = z.infer<typeof CampaignTargetDtoSchema>;

export const CampaignProposalDtoSchema = z.object({
  connectionId: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  id: z.string(),
  reason: z.string(),
  repoLabel: z.string().nullable(),
});
export type CampaignProposalDto = z.infer<typeof CampaignProposalDtoSchema>;

export const CampaignSummaryDtoSchema = z.object({
  counts: CampaignCountsSchema,
  createdAt: z.string(),
  createdById: z.string().nullable(),
  description: z.string(),
  expiresAt: z.string().nullable(),
  gate: CampaignGateSchema,
  id: z.string(),
  launchedById: z.string().nullable(),
  name: z.string(),
  ownerTeamId: z.string(),
  pausedReason: CampaignPausedReasonSchema.nullable(),
  plan: CampaignPlanSchema,
  recipeRef: z.string().nullable(),
  state: CampaignStateSchema,
  updatedAt: z.string(),
  workflowKind: CampaignWorkflowKindSchema,
});
export type CampaignSummaryDto = z.infer<typeof CampaignSummaryDtoSchema>;

export const CampaignDetailDtoSchema = CampaignSummaryDtoSchema.extend({
  budgetUsd: z.number().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledById: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Discovery proposals naming a repository the viewer may not reach: counted, never named. */
  hiddenProposalCount: z.number().int(),
  /** Targets the viewer may not see: counted, never named. */
  hiddenTargetCount: z.number().int(),
  launcherChangedAt: z.string().nullable(),
  maxOpenPullRequests: z.number().int().nullable(),
  maxParallel: z.number().int(),
  proposals: z.array(CampaignProposalDtoSchema),
  rescanIntervalHours: z.number().int().nullable(),
  scopeId: z.string().nullable(),
  scopeKind: CampaignScopeKindSchema.nullable(),
  staleAfterDays: z.number().int().nullable(),
  targets: z.array(CampaignTargetDtoSchema),
  templateId: z.string(),
  templateVersion: z.number().int(),
});
export type CampaignDetailDto = z.infer<typeof CampaignDetailDtoSchema>;

export const CampaignListResponseSchema = z.object({
  data: z.array(CampaignSummaryDtoSchema),
  meta: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
});
export type CampaignListResponse = z.infer<typeof CampaignListResponseSchema>;

/** The answer to a launch. A planned campaign answers in `PLANNING`. */
export const CampaignLaunchResponseSchema = z.object({
  campaignId: z.string(),
  state: CampaignStateSchema,
  targetCount: z.number().int(),
  workflowId: z.string(),
});
export type CampaignLaunchResponse = z.infer<typeof CampaignLaunchResponseSchema>;

/** The answer to confirm, pause, resume, take over and cancel. */
export const CampaignActionResponseSchema = z.object({
  id: z.string(),
  pausedReason: CampaignPausedReasonSchema.nullable().optional(),
  state: CampaignStateSchema,
});
export type CampaignActionResponse = z.infer<typeof CampaignActionResponseSchema>;

/** The answer to `POST /:id/targets`. */
export const CampaignAddTargetsResponseSchema = z.object({
  added: z.array(z.object({ connectionId: z.string(), id: z.string(), repoLabel: z.string() })),
  /** Repositories the person may not start work in, or that were already targets. */
  refused: z.array(z.object({ connectionId: z.string(), reason: z.string() })),
});
export type CampaignAddTargetsResponse = z.infer<typeof CampaignAddTargetsResponseSchema>;

/** The answer to retry and remove. */
export const CampaignTargetActionResponseSchema = z.object({
  id: z.string(),
  state: CampaignTargetStateSchema,
});
export type CampaignTargetActionResponse = z.infer<typeof CampaignTargetActionResponseSchema>;

/** The answer to the worker's attempt call. */
export const CampaignStartAttemptResponseSchema = z.object({
  attemptId: z.string(),
  /** The work branch the attempt pushes. */
  branch: z.string().nullable(),
  n: z.number().int(),
  runId: z.string().nullable(),
  workflowId: z.string(),
});
export type CampaignStartAttemptResponse = z.infer<typeof CampaignStartAttemptResponseSchema>;

/**
 * Coded refusals of an attempt start, in the order the gateway checks them (spec §4). The worker
 * records the refusal on the target and the reconciler decides what to do with it.
 */
export const CAMPAIGN_REFUSAL_CODES = [
  'CAMPAIGN_NOT_ACTIVE',
  'CAMPAIGNS_DISABLED',
  'LAUNCHER_UNAVAILABLE',
  'TARGET_UNAVAILABLE',
  'TARGET_NOT_STARTABLE',
  'GATE_CLOSED',
  'MAX_PARALLEL',
  'MAX_OPEN_PULL_REQUESTS',
  'LAUNCH_REFUSED',
  'PUSH_PERMISSION_REQUIRED',
  'BUDGET_EXCEEDED',
] as const;
export type CampaignRefusalCode = (typeof CAMPAIGN_REFUSAL_CODES)[number];

export function isCampaignRefusalCode(value: unknown): value is CampaignRefusalCode {
  return typeof value === 'string' && (CAMPAIGN_REFUSAL_CODES as readonly string[]).includes(value);
}

export const CampaignRefusalSchema = z.object({
  code: z.enum(CAMPAIGN_REFUSAL_CODES),
  message: z.string(),
});
export type CampaignRefusal = z.infer<typeof CampaignRefusalSchema>;
