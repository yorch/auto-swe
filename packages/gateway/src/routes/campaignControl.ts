import crypto from 'node:crypto';
import type { PlatformRole } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  CampaignAddTargetsBodySchema,
  type CampaignAddTargetsResponse,
  CampaignParamsSchema,
  CampaignPauseBodySchema,
  CampaignRemoveTargetBodySchema,
  CampaignStartAttemptBodySchema,
  CampaignTargetParamsSchema,
} from '@auto-swe/shared/lib/campaignApi';
import { boundFailureReason, CAMPAIGN_TERMINAL_STATES } from '@auto-swe/shared/lib/campaignOutcome';
import { type TargetState, transitionTarget } from '@auto-swe/shared/lib/campaignState';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isLauncher, isPlatformAdmin } from '@auto-swe/shared/permissions';
import {
  CAMPAIGN_CONTROL_SIGNAL,
  type CampaignControlAction,
  type CampaignControlSignal,
} from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { can } from '../lib/authz.js';
import {
  decideTargetLaunch,
  loadLaunchRepos,
  mayControlCampaign,
  mayTakeOverCampaign,
  NOT_LED_REASON,
  visibleToMember,
} from '../lib/campaignAccess.js';
import { startCampaignAttempt } from '../lib/campaignAttempt.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema } from '../lib/idempotency.js';
import { memberTeams, permissionRequirement } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * The campaign actions beyond launch, list, detail and cancel (spec §7, §11): confirm, pause,
 * resume, take over, add and remove targets, retry, and the worker's attempt call.
 *
 * Every action writes its row change first and only then tells the workflow. The workflow is
 * woken by `campaignControl`, but a signal that cannot be delivered is a delay, not a failure: the
 * reconciler reads the rows again on its backstop pass, so the database is what the action is.
 */

/** A campaign in one of these states takes no action: it is finished or being cancelled. */
const CLOSED_STATES: readonly string[] = [...CAMPAIGN_TERMINAL_STATES, 'CANCELLING'];

const REASON_MAX = 500;

export const campaignControlRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const prisma = fastify.prisma;

  const CAMPAIGN_SELECT = {
    createdById: true,
    id: true,
    launchedById: true,
    orgId: true,
    ownerTeamId: true,
    pausedReason: true,
    plan: true,
    state: true,
    temporalWorkflowId: true,
    workflowKind: true,
  } as const;

  /** The campaign, only if the caller may see it: a campaign they cannot see does not exist. */
  async function findVisible(request: FastifyRequest, id: string) {
    const user = requireUser(request);
    return prisma.campaign.findFirst({
      select: CAMPAIGN_SELECT,
      where: {
        id,
        ...(isPlatformAdmin(user) ? {} : { OR: visibleToMember(user, request.repoAccessGate) }),
      },
    });
  }

  type VisibleCampaign = NonNullable<Awaited<ReturnType<typeof findVisible>>>;

  const notReconciled = (reply: Parameters<typeof sendError>[0]) =>
    sendError(
      reply,
      409,
      'CAMPAIGN_NOT_RECONCILED',
      'This campaign runs on the legacy campaign workflow, which has no pause, resume, retry, take-over or target changes'
    );

  /**
   * Wake the reconciler. Never throws and never fails the action: the row change has been made, and
   * the workflow's backstop reads it. Returns whether the signal was delivered, for the audit.
   */
  async function wake(
    request: FastifyRequest,
    campaign: Pick<VisibleCampaign, 'id' | 'temporalWorkflowId' | 'workflowKind'>,
    action: CampaignControlAction,
    targetId?: string
  ): Promise<'signalled' | 'not-running' | 'failed'> {
    if (campaign.workflowKind !== 'RECONCILER') {
      return 'not-running';
    }
    try {
      return await fastify.temporal.signalCampaignWorkflow(
        campaign.temporalWorkflowId,
        CAMPAIGN_CONTROL_SIGNAL,
        { action, ...(targetId ? { targetId } : {}) } satisfies CampaignControlSignal
      );
    } catch (err) {
      request.log.warn(
        { action, campaignId: campaign.id, err },
        'campaign control signal not delivered; the reconciler reads the change on its backstop pass'
      );
      return 'failed';
    }
  }

  async function audit(
    request: FastifyRequest,
    campaignId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Promise<void> {
    try {
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: requireUser(request),
        after,
        before,
        entityId: campaignId,
        entityType: 'Campaign',
      });
    } catch (err) {
      request.log.error({ campaignId, err }, 'campaign audit write failed — the change was made');
    }
  }

  /** A target of the campaign the caller may see, by id. */
  async function findVisibleTarget(request: FastifyRequest, campaignId: string, targetId: string) {
    const user = requireUser(request);
    const gate = request.repoAccessGate;
    const select = {
      connectionId: true,
      id: true,
      regressions: true,
      repoLabel: true,
      state: true,
      teamId: true,
    } as const;
    if (isPlatformAdmin(user)) {
      return prisma.campaignTarget.findFirst({ select, where: { campaignId, id: targetId } });
    }
    return prisma.campaignTarget.findFirst({
      select,
      where: {
        campaignId,
        connection: {
          AND: [
            {
              OR: [{ team: memberTeams(user) }, { shares: { some: { team: memberTeams(user) } } }],
            },
            permissionRequirement(user, gate),
          ],
        },
        id: targetId,
      },
    });
  }

  // ── Confirm ────────────────────────────────────────────────────────────────────────────────

  app.post(
    '/:id/confirm',
    { onRequest: requireAuth(), schema: { params: CampaignParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      // The launcher only: confirming the planner's briefs is what authorizes pull requests in
      // other teams' repositories, as them.
      if (!isLauncher(user.sub, campaign.launchedById)) {
        return sendError(reply, 403, 'FORBIDDEN', 'Only the campaign’s launcher may confirm it');
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (campaign.state !== 'PLANNING') {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_PLANNING',
          `Campaign is ${campaign.state}, not waiting to be confirmed`
        );
      }
      // Confirming authorizes the briefs, so every target must have one. The planner's last write
      // gives each target a brief in one step, so a target without one means it has not finished.
      const planNotReady = () =>
        sendError(
          reply,
          409,
          'CAMPAIGN_PLAN_NOT_READY',
          'The plan is not ready: the planner has not finished writing a brief for every target'
        );
      const unbriefed = await runUnscoped(
        'confirm checks that every target of the campaign has a brief; only a count leaves',
        ['CampaignTarget'],
        () => prisma.campaignTarget.count({ where: { brief: null, campaignId: campaign.id } })
      );
      if (unbriefed > 0) {
        return planNotReady();
      }
      // The update repeats both conditions, so a target added or a state moved since the checks
      // above cannot be confirmed past.
      const moved = await prisma.campaign.updateMany({
        data: { pausedReason: null, state: 'ACTIVE' },
        where: {
          id: campaign.id,
          ownerTeamId: campaign.ownerTeamId,
          state: 'PLANNING',
          targets: { none: { brief: null } },
        },
      });
      if (moved.count === 0) {
        const now = await prisma.campaign.findFirst({
          select: { state: true },
          where: { id: campaign.id },
        });
        return now?.state === 'PLANNING'
          ? planNotReady()
          : sendError(reply, 409, 'CAMPAIGN_NOT_PLANNING', 'Campaign was already confirmed');
      }
      const signal = await wake(request, campaign, 'confirm');
      await audit(request, campaign.id, { state: 'PLANNING' }, { signal, state: 'ACTIVE' });
      return { data: { id: campaign.id, pausedReason: null, state: 'ACTIVE' } };
    }
  );

  // ── Pause and resume ───────────────────────────────────────────────────────────────────────

  app.post(
    '/:id/pause',
    {
      onRequest: requireAuth(),
      schema: { body: CampaignPauseBodySchema.nullish(), params: CampaignParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may pause it'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (campaign.state === 'PAUSED') {
        return { data: { id: campaign.id, pausedReason: campaign.pausedReason, state: 'PAUSED' } };
      }
      const moved = await prisma.campaign.updateMany({
        data: { pausedReason: 'manual', state: 'PAUSED' },
        where: {
          id: campaign.id,
          ownerTeamId: campaign.ownerTeamId,
          state: { in: ['ACTIVE', 'STARTING', 'MONITORING'] },
        },
      });
      if (moved.count === 0) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_PAUSABLE',
          `Campaign is ${campaign.state} and cannot be paused`
        );
      }
      const signal = await wake(request, campaign, 'pause');
      await audit(
        request,
        campaign.id,
        { pausedReason: campaign.pausedReason, state: campaign.state },
        {
          pausedReason: 'manual',
          signal,
          state: 'PAUSED',
          ...(request.body?.note ? { note: request.body.note } : {}),
        }
      );
      return { data: { id: campaign.id, pausedReason: 'manual', state: 'PAUSED' } };
    }
  );

  app.post(
    '/:id/resume',
    { onRequest: requireAuth(), schema: { params: CampaignParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may resume it'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (campaign.state !== 'PAUSED') {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_PAUSED',
          `Campaign is ${campaign.state}, not paused`
        );
      }
      // A resume that the next attempt would refuse again only loops: say why instead.
      const enabled = await resolveSetting('workflow.campaignsEnabled', {
        orgId: campaign.orgId,
        teamId: campaign.ownerTeamId,
      });
      if (!enabled) {
        return sendError(
          reply,
          409,
          'CAMPAIGNS_DISABLED',
          'Campaigns are not enabled (workflow.campaignsEnabled) for the owning team'
        );
      }
      // A pause for the kill switch is lifted only when it holds for every team the campaign
      // works in, or the reconciler pauses it again at once. Nothing is named about other teams.
      if (campaign.pausedReason === 'disabled') {
        const targetTeams = await runUnscoped(
          'resume checks the kill switch of every team that owns a target; only the code is returned',
          ['CampaignTarget', 'Team'],
          async () => {
            const rows = await prisma.campaignTarget.findMany({
              distinct: ['teamId'],
              select: { teamId: true },
              where: { campaignId: campaign.id },
            });
            const ids = rows.map((r) => r.teamId).filter((id) => id !== campaign.ownerTeamId);
            return ids.length === 0
              ? []
              : prisma.team.findMany({
                  select: { id: true, orgId: true },
                  where: { id: { in: ids } },
                });
          }
        );
        const decided = await Promise.all(
          targetTeams.map((t) =>
            resolveSetting('workflow.campaignsEnabled', { orgId: t.orgId, teamId: t.id })
          )
        );
        if (decided.some((on) => on === false)) {
          return sendError(
            reply,
            409,
            'CAMPAIGNS_DISABLED',
            'Campaigns are not enabled (workflow.campaignsEnabled) for every team the campaign works in'
          );
        }
      }
      const launcher = campaign.launchedById
        ? await prisma.user.findUnique({
            select: { isActive: true },
            where: { id: campaign.launchedById },
          })
        : null;
      if (!launcher?.isActive) {
        return sendError(
          reply,
          409,
          'LAUNCHER_UNAVAILABLE',
          'The launcher’s account is not active; a LEAD of the owning team must take the campaign over'
        );
      }
      const moved = await prisma.campaign.updateMany({
        data: { pausedReason: null, state: 'ACTIVE' },
        where: { id: campaign.id, ownerTeamId: campaign.ownerTeamId, state: 'PAUSED' },
      });
      if (moved.count === 0) {
        return sendError(reply, 409, 'CAMPAIGN_NOT_PAUSED', 'Campaign is no longer paused');
      }
      const signal = await wake(request, campaign, 'resume');
      await audit(
        request,
        campaign.id,
        { pausedReason: campaign.pausedReason, state: 'PAUSED' },
        { pausedReason: null, signal, state: 'ACTIVE' }
      );
      return { data: { id: campaign.id, pausedReason: null, state: 'ACTIVE' } };
    }
  );

  // ── Take over ──────────────────────────────────────────────────────────────────────────────

  app.post(
    '/:id/takeover',
    { onRequest: requireAuth(), schema: { params: CampaignParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayTakeOverCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only a LEAD of the campaign’s owning team or an ADMIN may take it over'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      // Never the current launcher: taking over is a hand-over to someone else.
      if (isLauncher(user.sub, campaign.launchedById)) {
        return sendError(
          reply,
          409,
          'ALREADY_LAUNCHER',
          'You already launched this campaign; a take-over hands it to someone else'
        );
      }
      if (CLOSED_STATES.includes(campaign.state)) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is ${campaign.state} and cannot be taken over`
        );
      }

      // The launch decision is re-run, as the new person, for every target not yet started. A
      // running attempt, and a target already waiting on review, continue as they were.
      const unstarted = await runUnscoped(
        'the take-over decides every target of a campaign the caller leads; nothing is named in the response',
        ['CampaignTarget'],
        () =>
          prisma.campaignTarget.findMany({
            select: { connectionId: true, id: true, teamId: true },
            where: { campaignId: campaign.id, state: { in: ['PENDING', 'BLOCKED'] } },
          })
      );
      const repos = await loadLaunchRepos(
        prisma,
        user.sub,
        unstarted.flatMap((t) => (t.connectionId ? [t.connectionId] : []))
      );
      const repoById = new Map(repos.map((r) => [r.id, r]));
      const actor = { role: user.role as PlatformRole, sub: user.sub };
      const decisions = new Map<string, Awaited<ReturnType<typeof decideTargetLaunch>>>();
      const skipped: Array<{ id: string; teamId: string; reason: string }> = [];
      for (const target of unstarted) {
        const key = target.connectionId ?? target.id;
        let decision = decisions.get(key);
        if (!decision) {
          decision = target.connectionId
            ? await decideTargetLaunch(prisma, actor, repoById.get(target.connectionId), {
                gate: request.repoAccessGate,
                log: request.log,
              })
            : { ok: false as const, reason: 'the repository no longer exists' };
          decisions.set(key, decision);
        }
        if (!decision.ok) {
          skipped.push({
            id: target.id,
            reason: boundFailureReason(`Skipped on take-over: ${decision.reason}`),
            teamId: target.teamId,
          });
        }
      }

      const resumes =
        campaign.state === 'PAUSED' && campaign.pausedReason === 'launcher-unavailable';
      const now = new Date();
      const done = await prisma.$transaction(async (tx) => {
        const moved = await tx.campaign.updateMany({
          data: {
            launchedById: user.sub,
            launcherChangedAt: now,
            ...(resumes ? { pausedReason: null, state: 'ACTIVE' as const } : {}),
          },
          where: {
            id: campaign.id,
            // Another take-over that landed first moved the launcher: this decision was about the
            // previous one's campaign, so it is not applied.
            ...(campaign.launchedById === null
              ? { launchedById: null }
              : { launchedById: campaign.launchedById }),
            ownerTeamId: campaign.ownerTeamId,
            state: { notIn: CLOSED_STATES as never },
          },
        });
        if (moved.count === 0) {
          return false;
        }
        for (const t of skipped) {
          await tx.campaignTarget.updateMany({
            data: { failureReason: t.reason, finishedAt: now, state: 'SKIPPED' },
            where: { id: t.id, state: { in: ['PENDING', 'BLOCKED'] }, teamId: t.teamId },
          });
        }
        return true;
      });
      if (!done) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_CHANGED',
          'The campaign changed while it was being taken over; try again'
        );
      }
      const signal = await wake(request, campaign, 'takeover');
      const nextState = resumes ? 'ACTIVE' : campaign.state;
      await audit(
        request,
        campaign.id,
        {
          launchedById: campaign.launchedById,
          pausedReason: campaign.pausedReason,
          state: campaign.state,
        },
        {
          launchedById: user.sub,
          pausedReason: resumes ? null : campaign.pausedReason,
          previousLauncherId: campaign.launchedById,
          signal,
          skippedTargetIds: skipped.map((t) => t.id),
          skippedTargets: skipped.length,
          state: nextState,
          takenOverById: user.sub,
        }
      );
      return {
        data: {
          id: campaign.id,
          launchedById: user.sub,
          pausedReason: resumes ? null : campaign.pausedReason,
          skippedTargetIds: skipped.map((t) => t.id),
          state: nextState,
        },
      };
    }
  );

  // ── Targets ────────────────────────────────────────────────────────────────────────────────

  app.post(
    '/:id/targets',
    {
      onRequest: requireAuth(),
      schema: { body: CampaignAddTargetsBodySchema, params: CampaignParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may add targets'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (CLOSED_STATES.includes(campaign.state)) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is ${campaign.state} and takes no new targets`
        );
      }
      const existing = await runUnscoped(
        'the target count and positions of a campaign the caller may control',
        ['CampaignTarget'],
        () =>
          prisma.campaignTarget.findMany({
            select: { connectionId: true, position: true },
            where: { campaignId: campaign.id },
          })
      );
      const known = new Set(existing.flatMap((t) => (t.connectionId ? [t.connectionId] : [])));
      const maxTargets = await resolveSetting('workflow.campaignMaxTargets', {
        orgId: campaign.orgId,
        teamId: campaign.ownerTeamId,
      });
      const repos = await loadLaunchRepos(prisma, user.sub, request.body.repoIds);
      const repoById = new Map(repos.map((r) => [r.id, r]));
      const actor = { role: user.role as PlatformRole, sub: user.sub };

      const added: CampaignAddTargetsResponse['added'] = [];
      const refused: CampaignAddTargetsResponse['refused'] = [];
      const rows: Array<{
        connectionId: string;
        id: string;
        position: number;
        repoLabel: string;
        teamId: string;
      }> = [];
      let position = existing.reduce((max, t) => Math.max(max, t.position), -1) + 1;
      const enabledByTeam = new Map<string, boolean>();
      for (const connectionId of request.body.repoIds) {
        const repo = repoById.get(connectionId);
        // Authorization before any other refusal, as the launch route orders it: a missing
        // repository and one the caller may not lead read the same, so an id cannot be probed for
        // its organization, provider, state or settings.
        if (
          !repo ||
          !(await can(request, 'team.launch.multi-repo', { teamId: repo.teamId })).allowed
        ) {
          refused.push({ connectionId, reason: NOT_LED_REASON });
          continue;
        }
        if (known.has(connectionId)) {
          refused.push({ connectionId, reason: 'already a target of this campaign' });
          continue;
        }
        if (repo.scmProvider !== 'github') {
          refused.push({ connectionId, reason: 'the repository is not on GitHub' });
          continue;
        }
        if (campaign.plan === 'UNIFORM' && repo.team.orgId !== campaign.orgId) {
          refused.push({
            connectionId,
            reason: 'a uniform campaign takes repositories of its own organization only',
          });
          continue;
        }
        if (existing.length + rows.length >= maxTargets) {
          refused.push({
            connectionId,
            reason: `the campaign is at its target limit (workflow.campaignMaxTargets: ${maxTargets})`,
          });
          continue;
        }
        if (!enabledByTeam.has(repo.teamId)) {
          enabledByTeam.set(
            repo.teamId,
            await resolveSetting('workflow.campaignsEnabled', {
              orgId: repo.team.orgId,
              teamId: repo.teamId,
            })
          );
        }
        if (enabledByTeam.get(repo.teamId) === false) {
          refused.push({ connectionId, reason: 'campaigns are not enabled for its team' });
          continue;
        }
        // The person adding it must pass the launch decision for it, not only the launcher.
        const decision = await decideTargetLaunch(prisma, actor, repo, {
          gate: request.repoAccessGate,
          log: request.log,
        });
        if (!decision.ok) {
          refused.push({ connectionId, reason: decision.reason.slice(0, REASON_MAX) });
          continue;
        }
        known.add(connectionId);
        const id = crypto.randomUUID();
        const repoLabel = `${repo.organizationName ?? '?'}/${repo.repoName ?? connectionId}`;
        rows.push({ connectionId, id, position, repoLabel, teamId: repo.teamId });
        added.push({ connectionId, id, repoLabel });
        position += 1;
      }
      if (rows.length > 0) {
        await prisma.campaignTarget.createMany({
          data: rows.map((r) => ({ ...r, campaignId: campaign.id })),
        });
        const signal = await wake(request, campaign, 'addTargets');
        await audit(
          request,
          campaign.id,
          { targetCount: existing.length },
          {
            addedTargetIds: rows.map((r) => r.id),
            signal,
            targetCount: existing.length + rows.length,
          }
        );
      }
      const response: CampaignAddTargetsResponse = { added, refused };
      return { data: response };
    }
  );

  app.post(
    '/:id/targets/:targetId/retry',
    { onRequest: requireAuth(), schema: { params: CampaignTargetParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may retry a target'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (CLOSED_STATES.includes(campaign.state)) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is ${campaign.state} and retries nothing`
        );
      }
      const target = await findVisibleTarget(request, campaign.id, request.params.targetId);
      if (!target) {
        return sendError(reply, 404, 'TARGET_NOT_FOUND', 'Target not found');
      }
      const next = transitionTarget(
        { regressions: target.regressions, state: target.state as TargetState },
        { type: 'retry' }
      );
      if (!next.accepted || next.state === (target.state as string)) {
        return sendError(
          reply,
          409,
          'TARGET_NOT_RETRYABLE',
          `The target is ${target.state}; only a target that needs attention can be retried`
        );
      }
      // The retry is a new attempt as the campaign's launcher, on its own branch, started by the
      // reconciler when it next schedules the target; nothing here starts a run.
      const moved = await prisma.campaignTarget.updateMany({
        data: { failureReason: null, finishedAt: null, state: next.state },
        where: { id: target.id, state: 'NEEDS_ATTENTION', teamId: target.teamId },
      });
      if (moved.count === 0) {
        return sendError(reply, 409, 'TARGET_NOT_RETRYABLE', 'The target is no longer waiting');
      }
      const signal = await wake(request, campaign, 'retry', target.id);
      await audit(
        request,
        campaign.id,
        { state: target.state, targetId: target.id },
        { signal, state: next.state, targetId: target.id }
      );
      return { data: { id: target.id, state: next.state } };
    }
  );

  app.delete(
    '/:id/targets/:targetId',
    {
      onRequest: requireAuth(),
      schema: {
        body: CampaignRemoveTargetBodySchema.nullish(),
        params: CampaignTargetParamsSchema,
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const campaign = await findVisible(request, request.params.id);
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }
      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may remove a target'
        );
      }
      if (campaign.workflowKind !== 'RECONCILER') {
        return notReconciled(reply);
      }
      if (CLOSED_STATES.includes(campaign.state)) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is ${campaign.state} and takes no target changes`
        );
      }
      const target = await findVisibleTarget(request, campaign.id, request.params.targetId);
      if (!target) {
        return sendError(reply, 404, 'TARGET_NOT_FOUND', 'Target not found');
      }
      const next = transitionTarget(
        { regressions: target.regressions, state: target.state as TargetState },
        { type: 'remove' }
      );
      if (!next.accepted || next.state === (target.state as string)) {
        return sendError(
          reply,
          409,
          'TARGET_NOT_REMOVABLE',
          `The target is ${target.state} and cannot be removed now`
        );
      }
      // Nothing on the host is touched: a draft already opened stays open.
      const reason = boundFailureReason(request.body?.reason ?? 'Removed by a person');
      const now = new Date();
      const moved = await prisma.campaignTarget.updateMany({
        data: { failureReason: reason, finishedAt: now, state: next.state },
        where: { id: target.id, state: target.state as never, teamId: target.teamId },
      });
      if (moved.count === 0) {
        return sendError(reply, 409, 'TARGET_NOT_REMOVABLE', 'The target changed; try again');
      }
      const signal = await wake(request, campaign, 'removeTarget', target.id);
      await audit(
        request,
        campaign.id,
        { state: target.state, targetId: target.id },
        { reason, signal, state: next.state, targetId: target.id }
      );
      return { data: { id: target.id, state: next.state } };
    }
  );

  // ── The worker's call (campaign token only) ────────────────────────────────────────────────

  app.post(
    '/:id/targets/:targetId/attempts',
    {
      config: { campaignToken: 'startAttempt' },
      onRequest: requireAuth(),
      schema: {
        body: CampaignStartAttemptBodySchema.nullish(),
        headers: IdempotencyHeaderSchema,
        params: CampaignTargetParamsSchema,
      },
    },
    async (request, reply) => {
      // Only the worker's campaign token reaches this route with a campaign call; a person's
      // session or token is admitted by `requireAuth` and refused here.
      if (!request.campaignCall) {
        return sendError(
          reply,
          403,
          'CAMPAIGN_TOKEN_REQUIRED',
          'Attempts are started by the campaign reconciler, with its campaign token'
        );
      }
      const result = await startCampaignAttempt({
        campaignId: request.params.id,
        fastify: fastify as FastifyInstance,
        idempotencyKey: request.headers['idempotency-key'] ?? request.body?.idempotencyKey,
        log: request.log,
        targetId: request.params.targetId,
      });
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message);
      }
      return reply.status(result.status).send({ data: result.data });
    }
  );
};
