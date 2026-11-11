import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { CAMPAIGN_TERMINAL_STATES } from '@auto-swe/shared/lib/campaignOutcome';
import { parseRecipeParams } from '@auto-swe/shared/lib/campaignRecipes';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  BUDGET_TIERS,
  type CampaignTargetInput,
  type CampaignWorkflowInput,
} from '@auto-swe/shared/types/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  type MaybeGate,
  memberTeams,
  permissionRequirement,
  reachableConnections,
} from '../lib/tenantScope.js';
import { MAX_DESCRIPTION_LENGTH } from '../lib/ticketId.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** The built-in template every campaign child runs. */
const CAMPAIGN_TEMPLATE_NAME = 'dependency-upgrade-campaign';
/** `campaign-<campaignId>`; a child is `campaign-<campaignId>-<connectionId>`. */
const CAMPAIGN_ID_PREFIX = 'campaign-';
/** The registry's ceiling for `workflow.campaignMaxTargets`; bounds the id list before any lookup. */
const MAX_REPO_IDS = 200;

const TARGET_STATES = [
  'PENDING',
  'RUNNING',
  'PR_OPENED',
  'NOT_AFFECTED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
const CAMPAIGN_STATES = [
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'CANCELLED',
  'FAILED_TO_START',
] as const;

const CreateCampaignSchema = z.object({
  budget: z.enum(BUDGET_TIERS).optional(),
  description: z
    .string()
    .min(1, 'description is required — it is the agent brief and the pull request text')
    .max(MAX_DESCRIPTION_LENGTH),
  maxParallel: z.number().int().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  ownerTeamId: z.string().uuid(),
  // The ref and parameters are validated by the shared catalogue (`parseRecipeParams`), which
  // answers CAMPAIGN_RECIPE_INVALID. Zod only guarantees their rough shape here.
  recipe: z
    .object({
      params: z.record(z.string(), z.unknown()),
      ref: z.string().max(64),
    })
    .optional(),
  repoIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_REPO_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'repoIds must be unique'),
});

const ListCampaignsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  ownerTeamId: z.string().uuid().optional(),
  state: z.enum(CAMPAIGN_STATES).optional(),
});

const CampaignParams = z.object({ id: z.string().uuid() });

type TargetCounts = Record<(typeof TARGET_STATES)[number], number>;

function emptyCounts(): TargetCounts {
  return Object.fromEntries(TARGET_STATES.map((s) => [s, 0])) as TargetCounts;
}

const LEAD_ROLES = new Set(['LEAD', 'ADMIN']);

export const campaignRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Per-state target counts for the campaigns on a page. Counts only: no repository identity
   * crosses, which is why the aggregate may run over targets the caller cannot reach.
   */
  async function countsFor(campaignIds: string[]): Promise<Map<string, TargetCounts>> {
    const out = new Map<string, TargetCounts>(campaignIds.map((id) => [id, emptyCounts()]));
    if (campaignIds.length === 0) {
      return out;
    }
    const rows = await runUnscoped(
      'aggregate counts only; identities are filtered separately',
      ['CampaignTarget'],
      () =>
        fastify.prisma.campaignTarget.groupBy({
          _count: { _all: true },
          by: ['campaignId', 'state'],
          where: { campaignId: { in: campaignIds } },
        })
    );
    for (const row of rows) {
      const counts = out.get(row.campaignId);
      if (counts) {
        counts[row.state] = row._count._all;
      }
    }
    return out;
  }

  /**
   * The campaigns a non-admin may see: those their team owns, and those with at least one target
   * repository they can reach. The detail and cancel routes ask the same question by id. The list
   * query spells the same shape out inline so the tenant-guard audit can read its keys.
   */
  function visibleToMember(
    user: { sub: string },
    gate: MaybeGate
  ): Prisma.CampaignWhereInput['OR'] {
    return [
      { ownerTeam: memberTeams(user) },
      { targets: { some: { connection: reachableConnections(user, gate) } } },
    ];
  }

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateCampaignSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const { budget, description, name, ownerTeamId, recipe, repoIds } = body;
      const user = requireUser(request);

      // 1. The owning team: the caller leads it (or is a platform ADMIN). The campaign's
      //    organization is the team's.
      const ownerTeam = await fastify.prisma.team.findUnique({
        select: {
          id: true,
          isActive: true,
          memberships: { select: { role: true }, where: { userId: user.sub } },
          name: true,
          orgId: true,
        },
        where: { id: ownerTeamId },
      });
      if (!ownerTeam?.isActive) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Owner team not found');
      }
      const leadsOwner = ownerTeam.memberships.some((m) => LEAD_ROLES.has(m.role));
      if (user.role !== 'ADMIN' && !leadsOwner) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Launching a campaign requires team LEAD or ADMIN on the owning team'
        );
      }
      const orgId = ownerTeam.orgId;

      // 2. The repositories. Unscoped for the reason epics.ts gives: access is decided from the
      //    memberships selected here (step 8), and filtering by team up front would turn "you
      //    cannot see this repo" into "no such repo".
      const repos = await runUnscoped(
        'access is decided from the memberships selected here, not by the where clause',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            select: {
              githubApiUrl: true,
              githubUrl: true,
              id: true,
              installation: { select: { host: true, installationId: true, isActive: true } },
              organizationName: true,
              repoName: true,
              scmProvider: true,
              shares: repoMembersSelect({ userId: true }, { userId: user.sub }).shares,
              team: {
                select: {
                  id: true,
                  memberships: {
                    select: { role: true, userId: true },
                    where: { userId: user.sub },
                  },
                  monthlyBudgetUsdCents: true,
                  name: true,
                  organization: {
                    select: { id: true, monthlyBudgetUsdCents: true },
                  },
                  orgId: true,
                },
              },
              teamId: true,
              type: true,
            },
            where: { id: { in: repoIds }, isActive: true, type: 'git_repo' },
          })
      );
      const foundIds = new Set(repos.map((r) => r.id));
      const missingIds = repoIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return sendError(
          reply,
          404,
          'REPOS_NOT_FOUND',
          `Repositories not found or inactive: ${missingIds.join(', ')}`
        );
      }

      // 3. One organization. Nothing is named: the caller may not be able to see the other org's
      //    repositories yet.
      if (repos.some((r) => r.team.orgId !== orgId)) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_CROSS_ORG',
          "Every repository of a campaign must belong to the owning team's organization"
        );
      }

      // 4. The kill switch, for the owning team and for the team that owns each target. A
      //    repository is named only to a caller who is a member of its team (or a platform
      //    ADMIN); the rest are counted.
      const teamCtx = new Map<string, { teamId: string; orgId: string }>([
        [ownerTeam.id, { orgId, teamId: ownerTeam.id }],
      ]);
      for (const repo of repos) {
        teamCtx.set(repo.team.id, { orgId: repo.team.orgId, teamId: repo.team.id });
      }
      const enabledByTeam = new Map<string, boolean>();
      await Promise.all(
        [...teamCtx.values()].map(async (ctx) => {
          enabledByTeam.set(ctx.teamId, await resolveSetting('workflow.campaignsEnabled', ctx));
        })
      );
      const ownerDisabled = enabledByTeam.get(ownerTeam.id) === false;
      const disabledRepos = repos.filter((r) => enabledByTeam.get(r.team.id) === false);
      if (ownerDisabled || disabledRepos.length > 0) {
        const named = disabledRepos
          .filter((r) => user.role === 'ADMIN' || r.team.memberships.length > 0)
          .map((r) => `${r.organizationName ?? '?'}/${r.repoName ?? r.id}`);
        const unnamed = disabledRepos.length - named.length;
        const parts = [
          ...(ownerDisabled ? [`the owning team ${ownerTeam.name}`] : []),
          ...named,
          ...(unnamed > 0 ? [`${unnamed} other repositor${unnamed === 1 ? 'y' : 'ies'}`] : []),
        ];
        return sendError(
          reply,
          403,
          'CAMPAIGNS_DISABLED',
          `Campaigns are not enabled (workflow.campaignsEnabled) for: ${parts.join(', ')}`
        );
      }

      // 5. Size limits, resolved for the owning team and frozen into the workflow input.
      const ownerCtx = { orgId, teamId: ownerTeam.id };
      const [maxTargets, maxParallelCeiling] = await Promise.all([
        resolveSetting('workflow.campaignMaxTargets', ownerCtx),
        resolveSetting('workflow.campaignMaxParallelChildren', ownerCtx),
      ]);
      if (repoIds.length > maxTargets) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_TOO_MANY_TARGETS',
          `A campaign may name at most ${maxTargets} repositories (workflow.campaignMaxTargets); this one names ${repoIds.length}`
        );
      }
      const maxParallel = Math.min(body.maxParallel ?? maxParallelCeiling, maxParallelCeiling);

      // 6. The recipe, validated by the shared catalogue. The template's input pattern is wider
      //    on purpose, so this call is what keeps `github:evil/repo`, `$(…)` and
      //    `--registry=…` out of a payload.
      let recipeRef: string | null = null;
      let recipeParams: { packageName: string; targetVersion: string } | null = null;
      if (recipe) {
        const parsed = parseRecipeParams(recipe.ref, recipe.params);
        if (!parsed.ok) {
          return sendError(reply, 400, 'CAMPAIGN_RECIPE_INVALID', parsed.error);
        }
        recipeRef = parsed.ref;
        recipeParams = parsed.params;
      }

      // 7. The template, pinned at its active version, and the child payload checked against its
      //    input schema for one sample target.
      const template = await fastify.prisma.workflowTemplate.findFirst({
        select: { activeVersion: true, id: true, inputSchema: true },
        where: { name: CAMPAIGN_TEMPLATE_NAME, status: 'ACTIVE', teamId: null },
      });
      if (!template?.activeVersion) {
        return sendError(
          reply,
          503,
          'CAMPAIGN_TEMPLATE_MISSING',
          `${CAMPAIGN_TEMPLATE_NAME} workflow template not found. Run \`yarn db:seed\` to seed built-in templates.`
        );
      }
      const childPayload: Record<string, unknown> = {
        ...(recipeRef && recipeParams
          ? {
              packageName: recipeParams.packageName,
              recipe: recipeRef,
              targetVersion: recipeParams.targetVersion,
            }
          : {}),
        ...(budget ? { budget } : {}),
      };
      if (isInputSchema(template.inputSchema)) {
        const sample = validateInputPayload(template.inputSchema, {
          ...childPayload,
          connectionId: repoIds[0],
        });
        if (!sample.ok) {
          return sendError(
            reply,
            400,
            'CAMPAIGN_INPUT_INVALID',
            `The campaign does not satisfy the template's input schema: ${sample.errors.join('; ')}`
          );
        }
      }

      // 8. Launch authorization: repository access, an owning-team LEAD on every target, the
      //    org checks and the budgets. Every child is launched as the caller.
      const authorization = await authorizeLaunch(fastify.prisma, user, {
        gate: request.repoAccessGate,
        log: request.log,
        refusalShape: 'multi',
        repos,
        requireOwningTeamLead: true,
        runIdentity: 'caller',
      });
      if (!authorization.ok) {
        return sendLaunchRefusal(reply, authorization.refusal);
      }

      // Writes. The Campaign and its targets are created inside the launch ledger transaction,
      // after the RunInput they reference, so a refused or compensated launch leaves none.
      const campaignId = crypto.randomUUID();
      const workRequestId = crypto.randomUUID();
      const temporalWorkflowId = `${CAMPAIGN_ID_PREFIX}${campaignId}`;
      const externalTicketId = `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
      const requestPayload = JSON.stringify({ ...body, label: name });
      const repoById = new Map(repos.map((r) => [r.id, r]));
      const targets: CampaignTargetInput[] = repoIds.map((id) => {
        const repo = repoById.get(id) as (typeof repos)[number];
        return {
          connectionId: id,
          repoLabel: `${repo.organizationName ?? '?'}/${repo.repoName ?? id}`,
          teamId: repo.teamId,
        };
      });
      const workflowInput: CampaignWorkflowInput = {
        campaignId,
        campaignWorkflowId: temporalWorkflowId,
        childPayload,
        description,
        externalTicketId,
        launchedById: user.sub,
        maxParallel,
        requestPayload,
        targets,
        templateId: template.id,
        templateVersion: template.activeVersion,
        workRequestId,
      };

      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            budgetTier: budget ?? 'STANDARD',
            currentStatus: 'STARTING',
            repoId: null,
            temporalWorkflowId,
            workRequestId,
          },
          knowledgeSourceRepos: repos.map((repo) => ({
            orgId: repo.team.orgId,
            repoId: repo.id,
            teamId: repo.teamId,
          })),
          runInput: {
            description,
            externalTicketId,
            id: workRequestId,
            // Cross-repo, but with a pinned template: the epics list selects `templateId: null`.
            isCrossRepo: true,
            requestedById: user.sub,
            requestPayload,
            templateId: template.id,
            templateVersion: template.activeVersion,
            ticketIsSynthetic: true,
          },
        },
        () => fastify.temporal.startCampaignWorkflow(temporalWorkflowId, workflowInput),
        {
          audit: { actor: user, source: 'campaign', templateId: template.id },
          inTransaction: async (tx) => {
            await tx.campaign.create({
              data: {
                createdById: user.sub,
                description,
                id: campaignId,
                maxParallel,
                name,
                orgId,
                ownerTeamId: ownerTeam.id,
                state: 'STARTING',
                templateId: template.id,
                templateVersion: template.activeVersion as number,
                temporalWorkflowId,
                workRequestId,
                ...(recipeRef && recipeParams ? { recipeParams, recipeRef } : {}),
              },
            });
            await tx.campaignTarget.createMany({
              data: targets.map((t, position) => ({
                campaignId,
                connectionId: t.connectionId,
                position,
                repoLabel: t.repoLabel,
                teamId: t.teamId,
              })),
            });
          },
          log: fastify.log,
          sourceAuthorization: { actor: user },
        }
      );
      if (!launch.ok) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_ALREADY_EXISTS',
          `Campaign workflow ${temporalWorkflowId} already exists`
        );
      }

      try {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: {
            maxParallel,
            name,
            ownerTeamId: ownerTeam.id,
            recipeParams,
            recipeRef,
            targetCount: targets.length,
            templateId: template.id,
            templateVersion: template.activeVersion,
          },
          entityId: campaignId,
          entityType: 'Campaign',
        });
      } catch (err) {
        request.log.error({ campaignId, err }, 'campaign audit write failed — it was launched');
      }

      return reply.status(201).send({
        data: {
          campaignId,
          detailPath: `/campaigns/${campaignId}`,
          targetCount: targets.length,
          temporalWorkflowId,
          workRequestId,
        },
      });
    }
  );

  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListCampaignsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { limit, offset, ownerTeamId, state } = request.query;
      const filters: Prisma.CampaignWhereInput = {
        ...(ownerTeamId ? { ownerTeamId } : {}),
        ...(state ? { state } : {}),
      };
      const select = {
        completedAt: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
        id: true,
        name: true,
        ownerTeam: { select: { id: true, name: true } },
        recipeParams: true,
        recipeRef: true,
        state: true,
      } as const;
      const page = {
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        skip: offset,
        take: limit,
      };

      const [rows, total] =
        user.role === 'ADMIN'
          ? await runUnscoped('admin lists every campaign', ['Campaign'], () =>
              Promise.all([
                fastify.prisma.campaign.findMany({ ...page, select, where: filters }),
                fastify.prisma.campaign.count({ where: filters }),
              ])
            )
          : await Promise.all([
              fastify.prisma.campaign.findMany({
                ...page,
                select,
                where: {
                  ...filters,
                  // Owner-team member, or a reachable target. Spelled out (not
                  // `visibleToMember(…)`) so the tenant-guard audit reads the keys.
                  OR: [
                    { ownerTeam: { memberships: { some: { userId: user.sub } } } },
                    {
                      targets: {
                        some: {
                          connection: {
                            AND: [
                              {
                                OR: [
                                  { team: memberTeams(user) },
                                  { shares: { some: { team: memberTeams(user) } } },
                                ],
                              },
                              permissionRequirement(user, gate),
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              }),
              fastify.prisma.campaign.count({
                where: {
                  ...filters,
                  OR: [
                    { ownerTeam: { memberships: { some: { userId: user.sub } } } },
                    {
                      targets: {
                        some: {
                          connection: {
                            AND: [
                              {
                                OR: [
                                  { team: memberTeams(user) },
                                  { shares: { some: { team: memberTeams(user) } } },
                                ],
                              },
                              permissionRequirement(user, gate),
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              }),
            ]);

      const counts = await countsFor(rows.map((r) => r.id));
      return {
        data: rows.map((row) => ({ ...row, counts: counts.get(row.id) ?? emptyCounts() })),
        meta: { limit, offset, total },
      };
    }
  );

  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: CampaignParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { id } = request.params;
      const isAdmin = user.role === 'ADMIN';

      // Never 403: a campaign the caller cannot see does not exist as far as they are told.
      const campaign = await fastify.prisma.campaign.findFirst({
        select: {
          cancelledAt: true,
          cancelledById: true,
          completedAt: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
          description: true,
          id: true,
          maxParallel: true,
          name: true,
          orgId: true,
          ownerTeam: { select: { id: true, name: true } },
          recipeParams: true,
          recipeRef: true,
          state: true,
          templateId: true,
          templateVersion: true,
          temporalWorkflowId: true,
          updatedAt: true,
          workRequestId: true,
        },
        where: { id, ...(isAdmin ? {} : { OR: visibleToMember(user, gate) }) },
      });
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }

      const targetSelect = {
        childWorkflowId: true,
        connectionId: true,
        failureReason: true,
        finishedAt: true,
        path: true,
        position: true,
        prNumber: true,
        prUrl: true,
        repoLabel: true,
        startedAt: true,
        state: true,
        verification: true,
      } as const;
      const [countsByCampaign, targets] = await Promise.all([
        countsFor([id]),
        isAdmin
          ? runUnscoped('admin reads every target of a campaign', ['CampaignTarget'], () =>
              fastify.prisma.campaignTarget.findMany({
                orderBy: { position: 'asc' },
                select: targetSelect,
                where: { campaignId: id },
              })
            )
          : fastify.prisma.campaignTarget.findMany({
              orderBy: { position: 'asc' },
              select: targetSelect,
              where: {
                campaignId: id,
                // Only repositories the caller can reach; the rest are counted, not named.
                connection: {
                  AND: [
                    {
                      OR: [
                        { team: memberTeams(user) },
                        { shares: { some: { team: memberTeams(user) } } },
                      ],
                    },
                    permissionRequirement(user, gate),
                  ],
                },
              },
            }),
      ]);
      const counts = countsByCampaign.get(id) ?? emptyCounts();
      const totalTargets = Object.values(counts).reduce((a, b) => a + b, 0);

      // A running target's live phase comes from its child's ledger row.
      const runningChildIds = targets
        .filter((t) => t.state === 'RUNNING' && t.childWorkflowId)
        .map((t) => t.childWorkflowId as string);
      const live =
        runningChildIds.length > 0
          ? await fastify.prisma.activeWorkflow.findMany({
              select: { currentStatus: true, temporalWorkflowId: true },
              where: { temporalWorkflowId: { in: runningChildIds } },
            })
          : [];
      const liveById = new Map(live.map((l) => [l.temporalWorkflowId, l.currentStatus]));

      return {
        data: {
          ...campaign,
          counts,
          hiddenTargetCount: Math.max(0, totalTargets - targets.length),
          targets: targets.map((t) => ({
            ...t,
            liveStatus:
              t.state === 'RUNNING' && t.childWorkflowId
                ? (liveById.get(t.childWorkflowId) ?? null)
                : null,
          })),
        },
      };
    }
  );

  app.post(
    '/:id/cancel',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: CampaignParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { id } = request.params;
      const isAdmin = user.role === 'ADMIN';

      const campaign = await fastify.prisma.campaign.findFirst({
        select: {
          createdById: true,
          id: true,
          ownerTeamId: true,
          state: true,
          temporalWorkflowId: true,
        },
        where: { id, ...(isAdmin ? {} : { OR: visibleToMember(user, gate) }) },
      });
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }

      if (!isAdmin && campaign.createdById !== user.sub) {
        const membership = await fastify.prisma.teamMembership.findUnique({
          select: { role: true },
          where: { userId_teamId: { teamId: campaign.ownerTeamId, userId: user.sub } },
        });
        if (!membership || !LEAD_ROLES.has(membership.role)) {
          return sendError(
            reply,
            403,
            'FORBIDDEN',
            'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may cancel it'
          );
        }
      }

      if ((CAMPAIGN_TERMINAL_STATES as readonly string[]).includes(campaign.state)) {
        return sendError(
          reply,
          409,
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is already ${campaign.state} and cannot be cancelled`
        );
      }

      // The state predicate keeps a campaign that finished while we were reading from being
      // moved back to CANCELLING. CANCELLING itself is allowed, so a cancel whose signal failed
      // can be sent again.
      const moved = await fastify.prisma.campaign.updateMany({
        data: { cancelledAt: new Date(), cancelledById: user.sub, state: 'CANCELLING' },
        where: {
          id,
          ownerTeamId: campaign.ownerTeamId,
          state: { notIn: [...CAMPAIGN_TERMINAL_STATES] as never },
        },
      });
      if (moved.count === 0) {
        return sendError(reply, 409, 'CAMPAIGN_NOT_ACTIVE', 'Campaign is no longer active');
      }

      try {
        await fastify.temporal.signalCampaignCancel(campaign.temporalWorkflowId);
      } catch (err) {
        request.log.error({ campaignId: id, err }, 'campaign cancel signal failed');
        return sendError(
          reply,
          503,
          'CAMPAIGN_SIGNAL_FAILED',
          'The campaign is marked CANCELLING but the cancel signal could not be delivered; try again'
        );
      }

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { cancelledById: user.sub, state: 'CANCELLING' },
        before: { state: campaign.state },
        entityId: id,
        entityType: 'Campaign',
      });

      return reply.status(202).send({ data: { campaignId: id, state: 'CANCELLING' } });
    }
  );
};
