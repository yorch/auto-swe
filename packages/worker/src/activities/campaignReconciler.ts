/**
 * Activities behind `CampaignReconcilerWorkflow`: what one pass reads, what it writes and how it
 * asks the gateway to start an attempt (docs/specs/2026-11-25-campaigns-as-tracked-goals.md §3, §4).
 *
 * The workflow decides; these only read rows and write them. Every write is idempotent under
 * Temporal retries and under a duplicate delivery, and none can move a finished row:
 *
 *  - a target write is an `updateMany` keyed on the target's id, campaign, team (the tenant key,
 *    frozen at launch) and the state the decision was made from. A count of 0 means a retry already
 *    landed, or something else moved the row first, and is a no-op;
 *  - a campaign write is an `update` by id with the state it was decided from in the `where`; the
 *    "no such row" error (P2025) is the same no-op;
 *  - a target in a final state (`SATISFIED`, `SKIPPED`, `CANCELLED`, or a retired value that reads
 *    as one) is never written.
 *
 * Reads that find a stale row mend it: an attempt whose run ended without the finalization hook
 * having recorded it is completed here, so a lost signal strands nothing.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  CampaignStartAttemptResponseSchema,
  isCampaignRefusalCode,
} from '@auto-swe/shared/lib/campaignApi';
import { boundFailureReason, CAMPAIGN_TERMINAL_STATES } from '@auto-swe/shared/lib/campaignOutcome';
import { recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import { campaignMonthStart, campaignSpendUsd } from '@auto-swe/shared/lib/campaignSpend';
import {
  CAMPAIGN_TARGET_STATE_VALUES,
  type CampaignAttemptOutcomeValue,
  type CampaignStateValue,
  isTargetFinal,
  isTargetFinalFor,
  type PullRequestStatusValue,
  type TargetState,
} from '@auto-swe/shared/lib/campaignState';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin } from '@auto-swe/shared/permissions';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';
import { reconcileCampaignAttempt } from '../lib/campaignAttempts.js';
import { createCampaignGateway, redactCampaignTokens } from '../lib/campaignGateway.js';
import {
  assertCurrentWorkflowOwnsCampaign,
  campaignWorkflowIdOf,
} from '../lib/campaignIdentity.js';
import type {
  CampaignPassSnapshot,
  FinalizeCampaignInput,
  PassTarget,
  RecordCampaignPassInput,
  RecordCampaignPassResult,
  StartCampaignAttemptInput,
  StartCampaignAttemptResult,
} from '../lib/campaignReconcilerTypes.js';
import { notifyCampaignStale } from '../lib/campaignStaleNotice.js';
import { maskCredentialShapes } from '../lib/redactToken.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import { parseGatewayError } from './orchestrationApply.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNoRowError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2025';
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw ApplicationFailure.nonRetryable(`${name} is not a uuid`, 'INVALID_INPUT');
  }
}

// ── The read ──

/**
 * Everything one pass decides from, in one read: the campaign's own settings, every target with
 * its latest attempt and that attempt's pull request, and the checks that gate the whole pass (the
 * kill switch, the launcher's account, the campaign's own budget). `null` when the campaign no
 * longer exists.
 *
 * The attempts of a campaign whose run ended without a recorded outcome are completed here first,
 * so the snapshot already says how they ended.
 */
export async function readCampaignPass(input: {
  campaignId: string;
}): Promise<CampaignPassSnapshot | null> {
  const { campaignId } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const campaign = await prisma.campaign.findUnique({
    select: {
      budgetUsd: true,
      expiresAt: true,
      gate: true,
      launchedById: true,
      maxOpenPullRequests: true,
      maxParallel: true,
      orgId: true,
      ownerTeamId: true,
      plan: true,
      planFailedAt: true,
      recipeRef: true,
      rescanIntervalHours: true,
      scopeKind: true,
      staleAfterDays: true,
      state: true,
    },
    where: { id: campaignId },
  });
  if (!campaign) {
    return null;
  }
  const nowMs = Date.now();
  const rows = await prisma.campaignTarget.findMany({
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: {
      attempts: {
        orderBy: { n: 'desc' },
        select: {
          childWorkflowId: true,
          failureReason: true,
          id: true,
          n: true,
          outcome: true,
          runId: true,
          startedAt: true,
        },
        take: 1,
      },
      brief: true,
      connectionId: true,
      dependsOn: true,
      failureReason: true,
      id: true,
      lastCheckedAt: true,
      position: true,
      regressions: true,
      repoLabel: true,
      staleSince: true,
      state: true,
      teamId: true,
    },
    where: { campaign: { orgId: campaign.orgId }, campaignId },
  });
  const campaignWorkflowId = campaignWorkflowIdOf(campaignId);

  // Settle the attempts of a running target whose run ended unrecorded, and name runs that exist.
  const latest = new Map<
    string,
    {
      n: number;
      outcome: CampaignAttemptOutcomeValue | null;
      failureReason: string | null;
      runId: string | null;
    }
  >();
  for (const row of rows) {
    const a = row.attempts[0];
    if (!a) {
      continue;
    }
    let outcome = a.outcome as CampaignAttemptOutcomeValue | null;
    let failureReason = a.failureReason;
    let runId = a.runId;
    if (outcome === null && row.state === 'RUNNING') {
      const settled = await reconcileCampaignAttempt(
        {
          campaignWorkflowId,
          childWorkflowId: a.childWorkflowId,
          id: a.id,
          n: a.n,
          reconciler: true,
          runId: a.runId,
          startedAt: a.startedAt,
          targetId: row.id,
        },
        nowMs
      );
      if (settled) {
        const fresh = await prisma.campaignAttempt.findUnique({
          select: { failureReason: true, outcome: true, runId: true },
          where: { id: a.id },
        });
        outcome = (fresh?.outcome as CampaignAttemptOutcomeValue | null) ?? null;
        failureReason = fresh?.failureReason ?? null;
        runId = fresh?.runId ?? runId;
      }
    }
    latest.set(row.id, { failureReason, n: a.n, outcome, runId });
  }

  // The pull request each latest attempt's run opened, as the host last reported it.
  const runIds = [...new Set([...latest.values()].flatMap((a) => (a.runId ? [a.runId] : [])))];
  const prByRun = new Map<string, { status: PullRequestStatusValue; openedAt: number }>();
  if (runIds.length > 0) {
    const prs = await prisma.pullRequest.findMany({
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true, runId: true, status: true },
      where: { runId: { in: runIds } },
    });
    for (const pr of prs) {
      if (pr.runId && !prByRun.has(pr.runId)) {
        prByRun.set(pr.runId, {
          openedAt: pr.openedAt.getTime(),
          status: pr.status as PullRequestStatusValue,
        });
      }
    }
  }

  const targets: PassTarget[] = rows.map((row) => {
    const a = latest.get(row.id);
    const pr = a?.runId ? prByRun.get(a.runId) : undefined;
    return {
      attemptFailureReason: a?.failureReason ?? null,
      attemptN: a?.n ?? 0,
      attemptOutcome: a?.outcome ?? null,
      connectionId: row.connectionId,
      dependsOn: row.dependsOn,
      failureReason: row.failureReason,
      id: row.id,
      label: row.repoLabel,
      lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
      position: row.position,
      prOpenedAt: pr?.openedAt ?? null,
      prStatus: pr?.status ?? null,
      regressions: row.regressions,
      staleSince: row.staleSince?.getTime() ?? null,
      state: row.state as TargetState,
      teamId: row.teamId,
    };
  });

  const proposals = await prisma.campaignProposal.findMany({
    select: { connectionId: true },
    where: { campaignId },
  });

  // The gates that pause the whole campaign: the kill switch for the owning team and every team
  // that owns a target still to be worked, the launcher's account, and the campaign's own budget.
  const hasCheck = campaign.recipeRef !== null && recipeSupportsCheck(campaign.recipeRef);
  const liveTeams = new Set<string>([campaign.ownerTeamId]);
  for (const t of targets) {
    // A campaign with no check is done with a target at MERGED, so that target is not live.
    if (!isTargetFinalFor(t.state, { hasCheck })) {
      liveTeams.add(t.teamId);
    }
  }
  // Each team is resolved under its own organization: a cross-organization target's team answers
  // for its organization's setting, not for the campaign's. A team that cannot be found (deleted)
  // falls back to the campaign's organization.
  const teamOrg = new Map(
    (
      await runUnscoped(
        'teams are looked up by id to resolve the kill switch under each one’s own organization',
        ['Team'],
        () =>
          prisma.team.findMany({
            select: { id: true, orgId: true },
            where: { id: { in: [...liveTeams] } },
          })
      )
    ).map((team) => [team.id, team.orgId])
  );
  let campaignsEnabled = true;
  for (const teamId of [...liveTeams].sort()) {
    const enabled = await resolveSetting('workflow.campaignsEnabled', {
      orgId: teamOrg.get(teamId) ?? campaign.orgId,
      teamId,
    });
    if (!enabled) {
      campaignsEnabled = false;
      break;
    }
  }
  const maxTargets = await resolveSetting('workflow.campaignMaxTargets', {
    orgId: campaign.orgId,
    teamId: campaign.ownerTeamId,
  });
  // The floor is the operator's: a campaign launched with a shorter interval (or before the floor
  // was raised) re-checks at the floor, so a change reaches campaigns already running.
  const rescanFloorHours = await resolveSetting('workflow.campaignRescanFloorHours', {
    orgId: campaign.orgId,
    teamId: campaign.ownerTeamId,
  });
  const launcherAvailable = await isLauncherAvailable(campaign.launchedById, campaign.orgId);
  const budgetExceeded =
    campaign.budgetUsd === null
      ? false
      : (await campaignSpendUsd(prisma, {
          campaignId,
          monthStart: campaignMonthStart(new Date(nowMs)),
          orgId: campaign.orgId,
        })) >= Number(campaign.budgetUsd);

  return {
    campaign: {
      budgetExceeded,
      campaignsEnabled,
      expiresAt: campaign.expiresAt?.getTime() ?? null,
      gate: campaign.gate,
      hasCheck,
      hasScope: campaign.scopeKind !== null,
      launcherAvailable,
      maxOpenPullRequests: campaign.maxOpenPullRequests,
      maxParallel: campaign.maxParallel,
      maxTargets,
      plan: campaign.plan,
      rescanIntervalHours:
        campaign.rescanIntervalHours === null
          ? null
          : Math.max(campaign.rescanIntervalHours, rescanFloorHours),
      staleAfterDays: campaign.staleAfterDays,
      state: campaign.state as CampaignStateValue,
    },
    nowMs,
    planFailureRecorded: Boolean(campaign.planFailedAt),
    planned: rows.some((r) => r.brief !== null),
    proposalConnectionIds: proposals.map((p) => p.connectionId),
    targets,
  };
}

async function isLauncherAvailable(launchedById: string | null, orgId: string): Promise<boolean> {
  if (!launchedById) {
    return false;
  }
  const user = await prisma.user.findUnique({
    select: { isActive: true, role: true },
    where: { id: launchedById },
  });
  if (!user?.isActive) {
    return false;
  }
  if (isPlatformAdmin(user)) {
    return true;
  }
  const member = await prisma.organizationMembership.findUnique({
    select: { userId: true },
    where: { userId_orgId: { orgId, userId: launchedById } },
  });
  return member !== null;
}

// ── The write ──

const REASON_MAX = 500;

function reasonText(text: string): string {
  return boundFailureReason(text, maskCredentialShapes).slice(0, REASON_MAX);
}

/**
 * Apply one pass's decisions: target transitions (each conditional on the state it was decided
 * from), targets discovery found, proposals for the ones the launcher may not start, and the
 * campaign's own state. Writes in that order, so a campaign that turns `ACTIVE` already carries
 * the targets that make it so. A write whose condition no longer holds is counted in `skipped`
 * and is not an error.
 */
export async function recordCampaignPass(
  input: RecordCampaignPassInput
): Promise<RecordCampaignPassResult> {
  const { campaignId } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  let skipped = 0;
  const now = new Date();
  // Whether the campaign has a check decides whether MERGED ends a target (finishedAt). Unknown
  // (the row is gone) reads as a check, the conservative answer: nothing is stamped finished.
  const hasCheck =
    input.updates.length === 0
      ? true
      : await prisma.campaign
          .findUnique({ select: { recipeRef: true }, where: { id: campaignId } })
          .then((row) =>
            row ? row.recipeRef !== null && recipeSupportsCheck(row.recipeRef) : true
          );
  /** Targets whose staleSince went from unset to set in this call: each is told once, below. */
  const newlyStale: Array<{ targetId: string; staleSince: number }> = [];

  for (const u of input.updates) {
    if (isTargetFinal(u.expect)) {
      skipped += 1;
      continue;
    }
    const final = isTargetFinalFor(u.state, { hasCheck });
    // A write that sets `staleSince` also requires it to be unset in the row. The workflow only
    // sets it on a target that was not stale (a stale one keeps its value), so this loses nothing,
    // and it makes the write a one-shot: a retry of an update that already landed matches no row,
    // so the notice below is sent at most once per stale episode.
    const setsStale = typeof u.staleSince === 'number';
    const moved = await prisma.campaignTarget.updateMany({
      data: {
        state: u.state,
        ...(u.regressions !== undefined ? { regressions: u.regressions } : {}),
        ...(u.failureReason !== undefined
          ? { failureReason: u.failureReason === null ? null : reasonText(u.failureReason) }
          : {}),
        ...(u.staleSince !== undefined
          ? { staleSince: u.staleSince === null ? null : new Date(u.staleSince) }
          : {}),
        ...(final ? { finishedAt: now } : u.state === 'PENDING' ? { finishedAt: null } : {}),
      },
      where: {
        campaignId,
        id: u.targetId,
        state: u.expect,
        teamId: u.teamId,
        ...(setsStale ? { staleSince: null } : {}),
      },
    });
    if (moved.count === 0) {
      skipped += 1;
    } else if (typeof u.staleSince === 'number') {
      newlyStale.push({ staleSince: u.staleSince, targetId: u.targetId });
    }
  }

  if (newlyStale.length > 0) {
    await sendStaleNotices(campaignId, newlyStale, now.getTime());
  }

  const added: RecordCampaignPassResult['added'] = [];
  if (input.addTargets.length > 0) {
    const campaign = await prisma.campaign.findUnique({
      select: { orgId: true },
      where: { id: campaignId },
    });
    if (campaign) {
      const last = await prisma.campaignTarget.aggregate({
        _max: { position: true },
        where: { campaign: { orgId: campaign.orgId }, campaignId },
      });
      const base = (last._max.position ?? -1) + 1;
      await prisma.campaignTarget.createMany({
        data: input.addTargets.map((a, i) => ({
          campaignId,
          connectionId: a.connectionId,
          evidence: { kind: 'discovered' },
          position: base + i,
          repoLabel: a.label.slice(0, 200),
          teamId: a.teamId,
        })),
        skipDuplicates: true,
      });
      // A target is no longer a "checked satisfied, not a target" repository.
      await prisma.campaignDiscoveryCheck.deleteMany({
        where: {
          campaign: { orgId: campaign.orgId },
          campaignId,
          connectionId: { in: input.addTargets.map((a) => a.connectionId) },
        },
      });
      const created = await prisma.campaignTarget.findMany({
        orderBy: { position: 'asc' },
        select: { connectionId: true, id: true, position: true, repoLabel: true, teamId: true },
        where: {
          campaign: { orgId: campaign.orgId },
          campaignId,
          connectionId: { in: input.addTargets.map((a) => a.connectionId) },
          position: { gte: base, lt: base + input.addTargets.length },
        },
      });
      for (const row of created) {
        if (row.connectionId) {
          added.push({
            connectionId: row.connectionId,
            label: row.repoLabel,
            position: row.position,
            targetId: row.id,
            teamId: row.teamId,
          });
        }
      }
    }
  }

  if (input.proposals.length > 0) {
    await prisma.campaignProposal.createMany({
      data: input.proposals.map((p) => ({
        campaignId,
        connectionId: p.connectionId,
        reason: reasonText(p.reason),
      })),
      skipDuplicates: true,
    });
  }

  let campaignChanged = false;
  if (input.campaign) {
    const { from, to, pausedReason } = input.campaign;
    if (!(CAMPAIGN_TERMINAL_STATES as readonly string[]).includes(from)) {
      const data =
        to === 'COMPLETED'
          ? { completedAt: now, pausedReason: null, state: to }
          : to === 'PAUSED'
            ? { pausedReason: pausedReason ?? 'manual', state: to }
            : { pausedReason: null, state: to };
      campaignChanged =
        to === 'COMPLETED' || to === 'MONITORING'
          ? await writeSettledState(campaignId, from, data)
          : await writeCampaignState(campaignId, from, data);
    }
  }
  return { added, campaignChanged, skipped };
}

/**
 * Tell the owning team's Slack channel about targets that just went stale, in one message. Reads
 * each target's label, team and repository under the campaign's tenant key; the notice names only
 * repositories that team may see. Best effort, so a failure here never fails the pass.
 */
async function sendStaleNotices(
  campaignId: string,
  stale: ReadonlyArray<{ targetId: string; staleSince: number }>,
  nowMs: number
): Promise<void> {
  try {
    const campaign = await prisma.campaign.findUnique({
      select: { orgId: true },
      where: { id: campaignId },
    });
    if (!campaign) {
      return;
    }
    const rows = await prisma.campaignTarget.findMany({
      select: { connectionId: true, id: true, repoLabel: true, teamId: true },
      where: {
        campaign: { orgId: campaign.orgId },
        campaignId,
        id: { in: stale.map((t) => t.targetId) },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    await notifyCampaignStale({
      campaignId,
      now: nowMs,
      targets: stale.flatMap((t) => {
        const row = byId.get(t.targetId);
        return row === undefined
          ? []
          : [
              {
                connectionId: row.connectionId,
                repoLabel: row.repoLabel,
                staleSince: t.staleSince,
                teamId: row.teamId,
              },
            ];
      }),
    });
  } catch (err) {
    logWarn('campaign stale notice skipped', {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The campaign write, conditional on the state it was decided from. */
async function writeCampaignState(
  campaignId: string,
  from: CampaignStateValue,
  data: Record<string, unknown>
): Promise<boolean> {
  try {
    await prisma.campaign.update({ data, where: { id: campaignId, state: from } });
    return true;
  } catch (err) {
    if (isNoRowError(err)) {
      return false;
    }
    throw err;
  }
}

/** Thrown inside the settle transaction to roll its write back. */
class TargetStillOpen extends Error {}

/**
 * Write `COMPLETED` or `MONITORING`: a campaign whose targets are all final. The pass decided that
 * from the targets it read, and a person can add a target (or discovery another pass's worth) after
 * the read, so the decision is made again here, in the write's own transaction: the campaign row is
 * updated first (which takes its row lock, the one an attempt start takes `FOR UPDATE`), the
 * targets that are not final are counted, and a count above zero rolls the write back. The campaign
 * then stays as it was and the next pass reads the new target. A campaign with a check is waiting
 * on `MERGED` targets too; one without a check is done at `MERGED` (the owner's decision).
 */
async function writeSettledState(
  campaignId: string,
  from: CampaignStateValue,
  data: Record<string, unknown>
): Promise<boolean> {
  const campaign = await prisma.campaign.findUnique({
    select: { orgId: true, recipeRef: true },
    where: { id: campaignId },
  });
  if (!campaign) {
    return false;
  }
  const hasCheck = campaign.recipeRef !== null && recipeSupportsCheck(campaign.recipeRef);
  const final = CAMPAIGN_TARGET_STATE_VALUES.filter((state) =>
    isTargetFinalFor(state, { hasCheck })
  );
  try {
    // Lock order: the campaign row first (this update), then the target rows (the count below, and
    // any target write another transaction makes). An attempt start takes the same order (the
    // campaign `FOR UPDATE`, then its targets). Deleting a team cascades the other way, from the
    // team's targets up to the campaign they belong to, so a settle and a team deletion that meet on
    // one campaign can each hold the row the other wants. That is a rare deadlock Postgres resolves
    // by aborting one side: the settle's error is thrown, the pass fails and the next pass retries,
    // or the deletion is retried by its caller. Taking the target locks first here would only move
    // the collision to the attempt start, so the order is kept as it is.
    return await prisma.$transaction(async (tx) => {
      const moved = await tx.campaign.updateMany({
        data,
        where: { id: campaignId, orgId: campaign.orgId, state: from },
      });
      if (moved.count === 0) {
        return false;
      }
      const open = await tx.campaignTarget.count({
        where: {
          campaign: { orgId: campaign.orgId },
          campaignId,
          state: { notIn: [...final] },
        },
      });
      if (open > 0) {
        throw new TargetStillOpen();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof TargetStillOpen) {
      return false;
    }
    throw err;
  }
}

// ── Starting an attempt ──

/** The attempt route's idempotency key: stable across a Temporal retry and a workflow restart. */
export function attemptIdempotencyKey(campaignId: string, targetId: string, n: number): string {
  return `${campaignId}:${targetId}:${n}`;
}

/**
 * Ask the gateway to start attempt `attemptN` of one target
 * (`POST /api/v1/campaigns/:id/targets/:targetId/attempts`, a campaign token scoped to that one
 * call). The gateway runs the launch decision as the launcher and either starts the attempt or
 * refuses with a code (`CAMPAIGN_REFUSAL_CODES`); a refusal is the activity's answer, not an error,
 * and is never retried. A transport failure, a 5xx or an answer the worker cannot read throws, and
 * Temporal retries it: the idempotency key makes a repeat answer the attempt its first call
 * started.
 */
export async function startCampaignAttempt(
  input: StartCampaignAttemptInput,
  options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<StartCampaignAttemptResult> {
  const { campaignId, targetId, attemptN } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  assertUuid(campaignId, 'campaignId');
  assertUuid(targetId, 'targetId');
  const idempotencyKey = attemptIdempotencyKey(campaignId, targetId, attemptN);
  const gateway = createCampaignGateway(options);
  const res = await gateway.post(
    `/api/v1/campaigns/${campaignId}/targets/${targetId}/attempts`,
    { idempotencyKey },
    { call: 'startAttempt', campaignId, targetId },
    { 'Idempotency-Key': idempotencyKey }
  );

  if (res.status >= 200 && res.status < 300) {
    const parsed = CampaignStartAttemptResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new Error('the gateway started an attempt but its answer was not readable');
    }
    return {
      attemptId: parsed.data.attemptId,
      n: parsed.data.n,
      ok: true,
      runId: parsed.data.runId,
      workflowId: parsed.data.workflowId,
    };
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    throw new Error(`the gateway could not start the attempt (HTTP ${res.status})`);
  }
  const err = parseGatewayError(res.body);
  const message = redactCampaignTokens(err?.message ?? `the gateway refused (HTTP ${res.status})`);
  if (isCampaignRefusalCode(err?.code)) {
    return { code: err.code, message, ok: false };
  }
  if (res.status === 404) {
    // Only the gateway's own answer is a refusal. A 404 with no code is a route that does not
    // exist (a gateway still on the previous release during a rolling deploy) or an ingress that
    // lost its upstream: reading it as TARGET_UNAVAILABLE would skip the target for good. Throw,
    // and Temporal retries it.
    if (err?.code === 'CAMPAIGN_NOT_FOUND') {
      // The campaign is gone: nothing more can start. The workflow reads this as "stop".
      return { code: 'CAMPAIGN_NOT_ACTIVE', message, ok: false };
    }
    throw new Error('the gateway answered HTTP 404 without a refusal code');
  }
  // 401/403 without a coded refusal: the token was not accepted. Retrying cannot change that.
  throw ApplicationFailure.nonRetryable(
    `the gateway answered HTTP ${res.status} without a refusal code`,
    'GATEWAY_REFUSED_WITHOUT_CODE'
  );
}

// ── Cancel and finish ──

/**
 * Cancel every attempt of the campaign that is still in flight, through the run cancel path: the
 * child workflow is cancelled in Temporal (an execution Temporal no longer knows has nothing left
 * to cancel), its run row is marked `CANCELLED` while `RUNNING` (the workflow's own finalization
 * bills it), and the attempt is closed `CANCELLED`. Pushed branches and opened drafts stay.
 * Best effort per attempt: one that cannot be cancelled is logged and the rest still are.
 */
export async function cancelCampaignAttempts(input: {
  campaignId: string;
}): Promise<{ cancelled: number }> {
  const { campaignId } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const inFlight = await prisma.campaignAttempt.findMany({
    select: { childWorkflowId: true, id: true, runId: true },
    where: { outcome: null, target: { campaignId } },
  });
  let cancelled = 0;
  for (const attempt of inFlight) {
    try {
      if (attempt.childWorkflowId) {
        try {
          await getTemporalClient().workflow.getHandle(attempt.childWorkflowId).cancel();
        } catch (err) {
          const name = (err as { name?: string } | null)?.name ?? '';
          // Not found, or already closed: nothing left to cancel.
          if (!/NotFound|NotRunning|AlreadyCompleted/i.test(name)) {
            throw err;
          }
        }
      }
      if (attempt.runId) {
        await prisma.workflowRun.updateMany({
          data: { status: 'CANCELLED' },
          where: { id: attempt.runId, status: 'RUNNING' },
        });
      }
      await prisma.campaignAttempt.updateMany({
        data: { finishedAt: new Date(), outcome: 'CANCELLED' },
        where: { id: attempt.id, outcome: null },
      });
      cancelled += 1;
    } catch (err) {
      logWarn('campaign attempt cancel failed', {
        attemptId: attempt.id,
        error: redactCampaignTokens(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return { cancelled };
}

/** Targets a cancel ends: nothing was delivered for them, or what was delivered needs no one. */
const CANCELLED_FROM: TargetState[] = [
  'PENDING',
  'BLOCKED',
  'RUNNING',
  'NEEDS_ATTENTION',
  'FAILED',
];

/**
 * Close the campaign.
 *
 *  - `CANCELLED`: targets that delivered nothing (`PENDING`, `BLOCKED`, `RUNNING`,
 *    `NEEDS_ATTENTION`) become `CANCELLED`; an open or merged draft and a satisfied target keep
 *    their state, since a cancel never un-opens a pull request (`docs/campaigns.md` §9). The
 *    campaign becomes `CANCELLED`.
 *  - `COMPLETED`: the pass already wrote the state; this makes sure `completedAt` is set.
 *
 * Idempotent, and it never moves a campaign that is already final.
 */
export async function finalizeCampaignReconciler(input: FinalizeCampaignInput): Promise<void> {
  const { campaignId, outcome } = input;
  assertCurrentWorkflowOwnsCampaign(campaignId);
  const now = new Date();
  if (outcome === 'COMPLETED') {
    try {
      await prisma.campaign.update({
        data: { completedAt: now },
        where: { completedAt: null, id: campaignId, state: 'COMPLETED' },
      });
    } catch (err) {
      if (!isNoRowError(err)) {
        throw err;
      }
    }
    return;
  }
  const campaign = await prisma.campaign.findUnique({
    select: { orgId: true },
    where: { id: campaignId },
  });
  if (!campaign) {
    return;
  }
  await prisma.campaignTarget.updateMany({
    data: { finishedAt: now, state: 'CANCELLED' },
    where: {
      campaign: { orgId: campaign.orgId },
      campaignId,
      state: { in: CANCELLED_FROM },
    },
  });
  try {
    await prisma.campaign.update({
      data: { completedAt: now, pausedReason: null, state: 'CANCELLED' },
      where: { id: campaignId, state: { notIn: [...CAMPAIGN_TERMINAL_STATES] } },
    });
  } catch (err) {
    if (!isNoRowError(err)) {
      throw err;
    }
  }
}
