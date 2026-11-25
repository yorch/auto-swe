import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  CampaignCreateBodySchema,
  type CampaignDetailDto,
  CampaignParamsSchema,
  CampaignPlanSchema,
  CampaignStateSchema,
  type CampaignSummaryDto,
} from '@auto-swe/shared/lib/campaignApi';
import { CAMPAIGN_TERMINAL_STATES } from '@auto-swe/shared/lib/campaignOutcome';
import { parseRecipeParams, recipeSupportsCheck } from '@auto-swe/shared/lib/campaignRecipes';
import type { CampaignGateValue, CampaignStateValue } from '@auto-swe/shared/lib/campaignState';
import { isGitHubRepository } from '@auto-swe/shared/lib/githubHostScope';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { stableStringify } from '@auto-swe/shared/lib/stableJson';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin } from '@auto-swe/shared/permissions';
import {
  CAMPAIGN_CONTROL_SIGNAL,
  type CampaignControlSignal,
  type CampaignReconcilerInput,
  type CampaignTargetInput,
  type CampaignWorkflowInput,
} from '@auto-swe/shared/types/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { can } from '../lib/authz.js';
import { mayControlCampaign, visibleToMember } from '../lib/campaignAccess.js';
import {
  blockedReasons,
  countsFor,
  emptyCounts,
  iso,
  loadGraph,
  proposalDtos,
  TARGET_SELECT,
  targetDtos,
} from '../lib/campaignView.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema, uuidFromIdempotencyKey } from '../lib/idempotency.js';
import { authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { isOrgMember } from '../lib/orgAccess.js';
import { paginationQuery } from '../lib/pagination.js';
import { isTerminalSignalError } from '../lib/temporalErrors.js';
import { memberTeams, permissionRequirement } from '../lib/tenantScope.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { campaignControlRoutes } from './campaignControl.js';
import { resolveDefaultTemplate } from './workRequests.js';

/** The built-in template every uniform campaign child runs. */
const CAMPAIGN_TEMPLATE_NAME = 'dependency-upgrade-campaign';
/** `campaign-<campaignId>`; a child is `campaign-<campaignId>-<connectionId>`. */
const CAMPAIGN_ID_PREFIX = 'campaign-';

const ListCampaignsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  ownerTeamId: z.string().uuid().optional(),
  plan: CampaignPlanSchema.optional(),
  state: CampaignStateSchema.optional(),
});

/**
 * Whether a stored launch request and a new one are the same request, compared in a canonical
 * form (keys sorted at every depth): a client that serialises `recipe.params` in another key order
 * is retrying, not asking for something else.
 */
function sameRequest(stored: string | null | undefined, current: string): boolean {
  if (typeof stored !== 'string') {
    return false;
  }
  try {
    return stableStringify(JSON.parse(stored)) === stableStringify(JSON.parse(current));
  } catch {
    return false;
  }
}

export const campaignRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Pause, resume, confirm, take over, targets and the worker's attempt call.
  await fastify.register(campaignControlRoutes);

  app.post(
    '/',
    {
      onRequest: requireAuth({ handlerChecked: ['team.launch.multi-repo'] }),
      schema: { body: CampaignCreateBodySchema, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const { budget, description, name, ownerTeamId, recipe, repoIds } = body;
      const plan = body.plan ?? 'UNIFORM';
      const user = requireUser(request);
      const idempotencyKey = request.headers['idempotency-key'];
      // With an Idempotency-Key the campaign's id, and so its workflow ID `campaign-<id>`, is
      // derived from the key, scoped to the caller and the owning team: a retried launch collides
      // with the first on the ledger's unique workflow ID instead of starting a second campaign.
      const campaignId = idempotencyKey
        ? uuidFromIdempotencyKey(`campaign:${user.sub}:${ownerTeamId}`, idempotencyKey)
        : crypto.randomUUID();
      const temporalWorkflowId = `${CAMPAIGN_ID_PREFIX}${campaignId}`;
      // Every field of the body is part of the request, the new ones included: a retry that asks
      // for a different plan, gate, scope or limit is a different request.
      const requestPayload = JSON.stringify({ ...body, label: name });
      /**
       * The campaign this key already launched, answered as a deduplicated success when the
       * request is the same one, or 422 when the key was used for a different request.
       */
      const replay = async () => {
        if (!idempotencyKey) {
          return null;
        }
        const previous = await fastify.prisma.campaign.findFirst({
          select: {
            createdById: true,
            id: true,
            state: true,
            temporalWorkflowId: true,
            workRequestId: true,
          },
          where: { id: campaignId, ownerTeamId },
        });
        if (!previous || previous.createdById !== user.sub) {
          return null;
        }
        const stored = await fastify.prisma.runInput.findUnique({
          select: { requestPayload: true },
          where: { id: previous.workRequestId },
        });
        // Wrapped: a Fastify reply is a thenable, so an async function returning one bare would
        // resolve to the send's completion (undefined), not to the reply.
        if (!sameRequest(stored?.requestPayload, requestPayload)) {
          return {
            reply: sendError(
              reply,
              422,
              'IDEMPOTENCY_KEY_MISMATCH',
              'This Idempotency-Key was already used for a different campaign launch. Use a new key for a different request.'
            ),
          };
        }
        return {
          reply: reply.status(200).send({
            data: {
              campaignId: previous.id,
              deduplicated: true,
              detailPath: `/campaigns/${previous.id}`,
              state: previous.state,
              targetCount: repoIds.length,
              temporalWorkflowId: previous.temporalWorkflowId,
              workflowId: previous.temporalWorkflowId,
              workRequestId: previous.workRequestId,
            },
          }),
        };
      };

      // 1. The owning team: the caller leads it (or is a platform ADMIN). The campaign's
      //    organization is the team's.
      const ownerTeam = await fastify.prisma.team.findUnique({
        select: {
          id: true,
          isActive: true,
          name: true,
          orgId: true,
        },
        where: { id: ownerTeamId },
      });
      if (!ownerTeam?.isActive) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Owner team not found');
      }
      const leadsOwner = await can(request, 'team.launch.multi-repo', { teamId: ownerTeamId });
      if (!leadsOwner.allowed) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Launching a campaign requires team LEAD or ADMIN on the owning team'
        );
      }
      const orgId = ownerTeam.orgId;
      // A retry of a launch that already happened answers with it, before any check that the
      // first launch already passed is made again (a setting turned off since, say).
      const replayed = await replay();
      if (replayed) {
        return replayed.reply;
      }

      // 2. The repositories. Unscoped for the reason epics.ts gives: access is decided from the
      //    memberships selected here (steps 3 and 9), and filtering by team up front would turn "you
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
                    select: { userId: true },
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

      // 3. Team LEAD (or ADMIN) on the team that owns every repository, decided from the
      //    memberships selected above, BEFORE anything is said about a repository's organization
      //    or settings: otherwise a LEAD of any team could learn, repository by repository, which
      //    are in another organization or have campaigns turned off. A repository is named only to
      //    a member of its team; the rest are counted. The full launch decision (repository access,
      //    organization membership, budgets) still runs in step 9.
      {
        // One decision per owning team, each over every repository of it: platform admin holds the
        // capability everywhere, and a lead of a deactivated team does not.
        const ledTeams = new Map<string, boolean>();
        for (const teamId of new Set(repos.map((r) => r.team.id))) {
          ledTeams.set(teamId, (await can(request, 'team.launch.multi-repo', { teamId })).allowed);
        }
        const notLed = repos.filter((r) => ledTeams.get(r.team.id) !== true);
        if (notLed.length > 0) {
          const named = notLed
            .filter((r) => r.team.memberships.length > 0)
            .map((r) => `${r.organizationName ?? '?'}/${r.repoName ?? r.id}`);
          const unnamed = notLed.length - named.length;
          const parts = [
            ...named,
            ...(unnamed > 0
              ? [`${unnamed} other repositor${unnamed === 1 ? 'y' : 'ies'} of teams you are not in`]
              : []),
          ];
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Launching a campaign requires team LEAD or ADMIN on the team that owns each repository: ${parts.join(', ')}`,
              reasons: named.map((repo) => ({ reason: 'team-lead-required', repo })),
            },
          });
        }
      }

      // 4. One organization for a uniform campaign. Nothing is named: only an ADMIN can reach
      //    this with a repository of another organization (step 3 refuses everyone else first).
      //    A PLANNED campaign may span organizations, as an epic does: the launcher leads every
      //    target's team (step 3) and each attempt is billed to its repository's team and
      //    organization (the launch decision of step 9 and of every attempt).
      if (plan === 'UNIFORM' && repos.some((r) => r.team.orgId !== orgId)) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_CROSS_ORG',
          "Every repository of a campaign must belong to the owning team's organization"
        );
      }

      // 4b. GitHub only. The recipe's clone and push, the draft pull request and the per-user
      //     credentials of every child all go through the GitHub seam, and the worker refuses any
      //     other provider when it gets there; refused here, before a campaign or a child exists.
      const otherProvider = repos.filter((r) => !isGitHubRepository(r));
      if (otherProvider.length > 0) {
        return sendError(
          reply,
          409,
          'SCM_PROVIDER_UNSUPPORTED',
          `Campaigns run on GitHub repositories only; served by another provider: ${otherProvider
            .map((r) => `${r.organizationName ?? '?'}/${r.repoName ?? r.id} (${r.scmProvider})`)
            .join(', ')}`
        );
      }

      // 5. The kill switch, for the owning team and for the team that owns each target. A
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
          .filter((r) => isPlatformAdmin(user) || r.team.memberships.length > 0)
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

      // 6. Size limits, resolved for the owning team and frozen into the campaign. Which workflow
      //    runs it is decided here too and recorded on the row: a campaign runs to the end on the
      //    workflow it launched on.
      const ownerCtx = { orgId, teamId: ownerTeam.id };
      const [maxTargets, maxParallelCeiling, reconciler] = await Promise.all([
        resolveSetting('workflow.campaignMaxTargets', ownerCtx),
        resolveSetting('workflow.campaignMaxParallelChildren', ownerCtx),
        resolveSetting('workflow.campaignReconciler', ownerCtx),
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
      const workflowKind = reconciler ? ('RECONCILER' as const) : ('LEGACY' as const);

      // 6b. What only the reconciler can do. A legacy launch behaves exactly as it always has and
      //     refuses these, by name, instead of dropping them.
      const reconcilerOnly = [
        ...(body.plan === 'PLANNED' ? ['plan PLANNED'] : []),
        ...(body.gate !== undefined ? ['gate'] : []),
        ...(body.scope !== undefined ? ['scope'] : []),
        ...(body.maxOpenPullRequests !== undefined ? ['maxOpenPullRequests'] : []),
        ...(body.staleAfterDays !== undefined ? ['staleAfterDays'] : []),
        ...(body.rescanIntervalHours !== undefined ? ['rescanIntervalHours'] : []),
        ...(body.budgetUsd !== undefined ? ['budgetUsd'] : []),
        ...(body.lifetimeDays !== undefined ? ['lifetimeDays'] : []),
        ...(recipe && recipeSupportsCheck(recipe.ref) ? [`recipe ${recipe.ref}`] : []),
      ];
      if (workflowKind === 'LEGACY' && reconcilerOnly.length > 0) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_RECONCILER_REQUIRED',
          `These inputs need the campaign reconciler, which is off for the owning team (workflow.campaignReconciler): ${reconcilerOnly.join(', ')}`
        );
      }
      if (plan === 'PLANNED' && recipe) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_PLAN_INVALID',
          'A planned campaign takes no recipe: the planner decides the work of each repository'
        );
      }
      if (plan === 'PLANNED' && body.scope) {
        return sendError(
          reply,
          400,
          'CAMPAIGN_SCOPE_INVALID',
          'A planned campaign takes no scope: its targets are the repositories named at launch'
        );
      }

      // 6c. The scope (reconciler only): where the check may discover new targets.
      let scopeKind: 'TEAM' | 'ORG' | null = null;
      let scopeId: string | null = null;
      if (body.scope) {
        const scope = body.scope;
        if (!recipe || !recipeSupportsCheck(recipe.ref)) {
          return sendError(
            reply,
            400,
            'CAMPAIGN_SCOPE_INVALID',
            'A scope needs a recipe with a check (an @2 recipe): without one the campaign cannot discover targets'
          );
        }
        if (scope.kind === 'ORG') {
          if (scope.id && scope.id !== orgId) {
            return sendError(
              reply,
              400,
              'CAMPAIGN_SCOPE_INVALID',
              'An organization scope is the campaign’s own organization'
            );
          }
          if (!(await isOrgMember(fastify.prisma, user, orgId))) {
            return sendError(
              reply,
              403,
              'FORBIDDEN',
              'An organization scope needs membership of the organization'
            );
          }
          scopeKind = 'ORG';
          scopeId = orgId;
        } else {
          const scopeTeam = await fastify.prisma.team.findFirst({
            select: { id: true },
            where: {
              id: scope.id as string,
              isActive: true,
              orgId,
              ...(isPlatformAdmin(user) ? {} : { memberships: { some: { userId: user.sub } } }),
            },
          });
          if (!scopeTeam) {
            return sendError(
              reply,
              400,
              'CAMPAIGN_SCOPE_INVALID',
              'The scope team was not found in the campaign’s organization, or you do not belong to it'
            );
          }
          scopeKind = 'TEAM';
          scopeId = scopeTeam.id;
        }
      }

      // 6d. Defaults frozen into the campaign (reconciler only; a legacy campaign has none).
      let frozen: {
        expiresAt: Date;
        maxOpenPullRequests: number;
        rescanIntervalHours: number;
        staleAfterDays: number;
      } | null = null;
      if (workflowKind === 'RECONCILER') {
        const [openCeiling, staleDefault, rescanDefault, lifetimeDefault] = await Promise.all([
          resolveSetting('workflow.campaignMaxOpenPullRequests', ownerCtx),
          resolveSetting('workflow.campaignStaleAfterDays', ownerCtx),
          resolveSetting('workflow.campaignRescanIntervalHours', ownerCtx),
          resolveSetting('workflow.campaignLifetimeDays', ownerCtx),
        ]);
        frozen = {
          expiresAt: new Date(Date.now() + (body.lifetimeDays ?? lifetimeDefault) * 86_400_000),
          maxOpenPullRequests: Math.min(body.maxOpenPullRequests ?? openCeiling, openCeiling),
          rescanIntervalHours: body.rescanIntervalHours ?? rescanDefault,
          staleAfterDays: body.staleAfterDays ?? staleDefault,
        };
      }

      // 7. The recipe, validated by the shared catalogue. The template's input pattern is wider
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

      // 8. The template, pinned at its active version. A uniform campaign runs the built-in
      //    upgrade template, its payload checked against the input schema for one sample target. A
      //    planned one pins the owning team's default template; each attempt resolves the default of
      //    its own repository's team, as an epic's children do.
      let template: { activeVersion: number | null; id: string; inputSchema?: unknown } | null;
      if (plan === 'PLANNED') {
        const resolved = await resolveDefaultTemplate(fastify.prisma, ownerTeam.id);
        template = resolved ? { activeVersion: resolved.version, id: resolved.templateId } : null;
        if (!template) {
          return sendError(
            reply,
            503,
            'CAMPAIGN_TEMPLATE_MISSING',
            'No default workflow template is configured for the owning team'
          );
        }
      } else {
        template = await fastify.prisma.workflowTemplate.findFirst({
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
      if (plan === 'UNIFORM' && isInputSchema(template.inputSchema)) {
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

      // 9. Launch authorization: repository access, an owning-team LEAD on every target, the
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
      const workRequestId = crypto.randomUUID();
      const externalTicketId = `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
      const repoById = new Map(repos.map((r) => [r.id, r]));
      const targets: CampaignTargetInput[] = repoIds.map((id) => {
        const repo = repoById.get(id) as (typeof repos)[number];
        return {
          connectionId: id,
          repoLabel: `${repo.organizationName ?? '?'}/${repo.repoName ?? id}`,
          // Pre-generated, so the workflow keys every per-target write on the row itself.
          targetId: crypto.randomUUID(),
          teamId: repo.teamId,
        };
      });
      const templateVersion = template.activeVersion as number;
      const initialState: CampaignStateValue =
        workflowKind === 'LEGACY' ? 'STARTING' : plan === 'PLANNED' ? 'PLANNING' : 'STARTING';
      const startWorkflow = () => {
        if (workflowKind === 'RECONCILER') {
          const input: CampaignReconcilerInput = {
            campaignId,
            campaignWorkflowId: temporalWorkflowId,
          };
          return fastify.temporal.startCampaignReconcilerWorkflow(temporalWorkflowId, input);
        }
        const input: CampaignWorkflowInput = {
          campaignId,
          campaignWorkflowId: temporalWorkflowId,
          childPayload,
          description,
          externalTicketId,
          launchedById: user.sub,
          maxParallel,
          targets,
          templateId: template.id,
          templateVersion,
          workRequestId,
        };
        return fastify.temporal.startCampaignWorkflow(temporalWorkflowId, input);
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
            templateVersion,
            ticketIsSynthetic: true,
          },
        },
        startWorkflow,
        {
          audit: { actor: user, source: 'campaign', templateId: template.id },
          inTransaction: async (tx) => {
            await tx.campaign.create({
              data: {
                createdById: user.sub,
                description,
                id: campaignId,
                launchedById: user.sub,
                maxParallel,
                name,
                orgId,
                ownerTeamId: ownerTeam.id,
                state: initialState,
                templateId: template.id,
                templateVersion,
                temporalWorkflowId,
                workflowKind,
                workRequestId,
                ...(recipeRef && recipeParams ? { recipeParams, recipeRef } : {}),
                ...(workflowKind === 'RECONCILER' && frozen
                  ? {
                      budgetUsd: body.budgetUsd ?? null,
                      expiresAt: frozen.expiresAt,
                      gate: (body.gate ?? 'OPENED') as CampaignGateValue,
                      maxOpenPullRequests: frozen.maxOpenPullRequests,
                      plan,
                      rescanIntervalHours: frozen.rescanIntervalHours,
                      scopeId,
                      scopeKind,
                      staleAfterDays: frozen.staleAfterDays,
                    }
                  : {}),
              },
            });
            await tx.campaignTarget.createMany({
              data: targets.map((t, position) => ({
                campaignId,
                connectionId: t.connectionId,
                id: t.targetId,
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
        // Two requests with one key raced: the loser answers with the winner's campaign.
        const raced = await replay();
        if (raced) {
          return raced.reply;
        }
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
            templateVersion,
            workflowKind,
            ...(workflowKind === 'RECONCILER' && frozen
              ? {
                  budgetUsd: body.budgetUsd ?? null,
                  expiresAt: frozen.expiresAt.toISOString(),
                  gate: body.gate ?? 'OPENED',
                  launchedById: user.sub,
                  maxOpenPullRequests: frozen.maxOpenPullRequests,
                  plan,
                  rescanIntervalHours: frozen.rescanIntervalHours,
                  scopeId,
                  scopeKind,
                  staleAfterDays: frozen.staleAfterDays,
                  state: initialState,
                }
              : {}),
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
          state: initialState,
          targetCount: targets.length,
          temporalWorkflowId,
          workflowId: temporalWorkflowId,
          workRequestId,
        },
      });
    }
  );

  const SUMMARY_SELECT = {
    completedAt: true,
    createdAt: true,
    createdBy: { select: { id: true, name: true } },
    createdById: true,
    description: true,
    expiresAt: true,
    gate: true,
    id: true,
    launchedById: true,
    name: true,
    ownerTeam: { select: { id: true, name: true } },
    ownerTeamId: true,
    pausedReason: true,
    plan: true,
    recipeParams: true,
    recipeRef: true,
    state: true,
    updatedAt: true,
    workflowKind: true,
  } as const;

  type SummaryRow = Prisma.CampaignGetPayload<{ select: typeof SUMMARY_SELECT }>;

  /** The summary DTO of one campaign row, with the legacy fields the first dashboard read kept. */
  const summaryOf = (row: SummaryRow, counts: ReturnType<typeof emptyCounts>) => {
    const dto: CampaignSummaryDto = {
      counts,
      createdAt: row.createdAt.toISOString(),
      createdById: row.createdById ?? null,
      description: row.description,
      expiresAt: iso(row.expiresAt),
      gate: (row.gate ?? 'OPENED') as CampaignSummaryDto['gate'],
      id: row.id,
      launchedById: row.launchedById ?? null,
      name: row.name,
      ownerTeamId: row.ownerTeamId,
      pausedReason: (row.pausedReason ?? null) as CampaignSummaryDto['pausedReason'],
      plan: (row.plan ?? 'UNIFORM') as CampaignSummaryDto['plan'],
      recipeRef: row.recipeRef ?? null,
      state: row.state as CampaignSummaryDto['state'],
      updatedAt: row.updatedAt.toISOString(),
      workflowKind: (row.workflowKind ?? 'LEGACY') as CampaignSummaryDto['workflowKind'],
    };
    return {
      ...dto,
      completedAt: iso(row.completedAt),
      createdBy: row.createdBy,
      ownerTeam: row.ownerTeam,
      recipeParams: row.recipeParams ?? null,
    };
  };

  app.get(
    '/',
    {
      onRequest: requireAuth(),
      schema: { querystring: ListCampaignsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { limit, offset, ownerTeamId, plan, state } = request.query;
      const filters: Prisma.CampaignWhereInput = {
        ...(ownerTeamId ? { ownerTeamId } : {}),
        ...(plan ? { plan } : {}),
        ...(state ? { state } : {}),
      };
      const select = SUMMARY_SELECT;
      const page = {
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        skip: offset,
        take: limit,
      };

      const [rows, total] = isPlatformAdmin(user)
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

      const counts = await countsFor(
        fastify.prisma,
        rows.map((r) => r.id)
      );
      return {
        data: rows.map((row) => summaryOf(row, counts.get(row.id) ?? emptyCounts())),
        meta: { limit, offset, total },
      };
    }
  );

  app.get(
    '/:id',
    {
      onRequest: requireAuth(),
      schema: { params: CampaignParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { id } = request.params;
      const isAdmin = isPlatformAdmin(user);

      // Never 403: a campaign the caller cannot see does not exist as far as they are told.
      const campaign = await fastify.prisma.campaign.findFirst({
        select: {
          ...SUMMARY_SELECT,
          budgetUsd: true,
          cancelledAt: true,
          cancelledById: true,
          launcherChangedAt: true,
          maxOpenPullRequests: true,
          maxParallel: true,
          orgId: true,
          rescanIntervalHours: true,
          scopeId: true,
          scopeKind: true,
          staleAfterDays: true,
          templateId: true,
          templateVersion: true,
          temporalWorkflowId: true,
          workRequestId: true,
        },
        where: { id, ...(isAdmin ? {} : { OR: visibleToMember(user, gate) }) },
      });
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }

      const [countsByCampaign, targets, ownerMember] = await Promise.all([
        countsFor(fastify.prisma, [id]),
        isAdmin
          ? runUnscoped('admin reads every target of a campaign', ['CampaignTarget'], () =>
              fastify.prisma.campaignTarget.findMany({
                orderBy: { position: 'asc' },
                select: TARGET_SELECT,
                where: { campaignId: id },
              })
            )
          : fastify.prisma.campaignTarget.findMany({
              orderBy: { position: 'asc' },
              select: TARGET_SELECT,
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
        // The discovery proposals name repositories the launcher could not start work in; they are
        // shown to the owning team and ADMINs only.
        isAdmin
          ? Promise.resolve(true)
          : fastify.prisma.campaign
              .findFirst({
                select: { id: true },
                where: { id, ownerTeam: memberTeams(user) },
              })
              .then((row) => row !== null),
      ]);
      const counts = countsByCampaign.get(id) ?? emptyCounts();

      const visible = new Set(targets.map((t) => t.id));
      const graph = await loadGraph(fastify.prisma, id);
      const blocked = blockedReasons(
        {
          gate: (campaign.gate ?? 'OPENED') as CampaignGateValue,
          maxOpenPullRequests: campaign.maxOpenPullRequests ?? null,
          maxParallel: campaign.maxParallel,
        },
        recipeHasCheck(campaign.recipeRef),
        graph,
        visible
      );
      const [targetViews, proposals] = await Promise.all([
        targetDtos(fastify.prisma, targets, blocked),
        ownerMember ? proposalDtos(fastify.prisma, id) : Promise.resolve([]),
      ]);

      const summary = summaryOf(campaign, counts);
      const detail: CampaignDetailDto & Record<string, unknown> = {
        ...summary,
        budgetUsd: campaign.budgetUsd == null ? null : Number(campaign.budgetUsd),
        cancelledAt: iso(campaign.cancelledAt),
        cancelledById: campaign.cancelledById ?? null,
        completedAt: iso(campaign.completedAt),
        hiddenTargetCount: Math.max(0, counts.total - targets.length),
        launcherChangedAt: iso(campaign.launcherChangedAt),
        maxOpenPullRequests: campaign.maxOpenPullRequests ?? null,
        maxParallel: campaign.maxParallel,
        orgId: campaign.orgId,
        proposals,
        rescanIntervalHours: campaign.rescanIntervalHours ?? null,
        scopeId: campaign.scopeId ?? null,
        scopeKind: (campaign.scopeKind ?? null) as CampaignDetailDto['scopeKind'],
        staleAfterDays: campaign.staleAfterDays ?? null,
        targets: targetViews,
        templateId: campaign.templateId,
        templateVersion: campaign.templateVersion,
        temporalWorkflowId: campaign.temporalWorkflowId,
        workRequestId: campaign.workRequestId,
      };
      return { data: detail };
    }
  );

  app.post(
    '/:id/cancel',
    {
      onRequest: requireAuth(),
      schema: { params: CampaignParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const gate = request.repoAccessGate;
      const { id } = request.params;
      const isAdmin = isPlatformAdmin(user);

      const campaign = await fastify.prisma.campaign.findFirst({
        select: {
          createdById: true,
          id: true,
          ownerTeamId: true,
          state: true,
          temporalWorkflowId: true,
          workflowKind: true,
        },
        where: { id, ...(isAdmin ? {} : { OR: visibleToMember(user, gate) }) },
      });
      if (!campaign) {
        return sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      }

      if (!(await mayControlCampaign(request, user, campaign))) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only the campaign’s creator, a LEAD of its owning team or an ADMIN may cancel it'
        );
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

      const reconciled = campaign.workflowKind === 'RECONCILER';

      // A reconciled campaign's children are runs of their own, not Temporal children of the
      // campaign, so closing the campaign's workflow no longer asks them to stop: each attempt in
      // flight is cancelled through the run cancel path, as orchestration cancels its children.
      if (reconciled) {
        try {
          await cancelRunningAttempts(id);
        } catch (err) {
          request.log.error({ campaignId: id, err }, 'campaign attempt cancel failed');
          return sendError(
            reply,
            503,
            'CAMPAIGN_SIGNAL_FAILED',
            'The campaign is marked CANCELLING but a running attempt could not be cancelled; try again'
          );
        }
      }

      let delivery: 'signalled' | 'not-running';
      try {
        delivery = reconciled
          ? await fastify.temporal.signalCampaignWorkflow(
              campaign.temporalWorkflowId,
              CAMPAIGN_CONTROL_SIGNAL,
              { action: 'cancel' } satisfies CampaignControlSignal
            )
          : await fastify.temporal.signalCampaignCancel(campaign.temporalWorkflowId);
      } catch (err) {
        request.log.error({ campaignId: id, err }, 'campaign cancel signal failed');
        return sendError(
          reply,
          503,
          'CAMPAIGN_SIGNAL_FAILED',
          'The campaign is marked CANCELLING but the cancel signal could not be delivered; try again'
        );
      }

      // A STARTING campaign with no execution is most likely one whose launch has committed its
      // rows but not yet started the workflow. Closing its rows here would let that workflow start
      // into a campaign already final, and leave nothing able to stop it. So it is left
      // CANCELLING: when the workflow starts, its re-check before the first child reads that state
      // and stops as a cancel. A later cancel of a campaign still CANCELLING with no execution (a
      // launch whose workflow never started) closes it as below, which is safe for the same reason.
      if (delivery === 'not-running' && campaign.state === 'STARTING') {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: {
            cancelledById: user.sub,
            pendingStart: 'the campaign workflow had not started; it stops when it does',
            state: 'CANCELLING',
          },
          before: { state: campaign.state },
          entityId: id,
          entityType: 'Campaign',
        });
        return reply.status(202).send({ data: { campaignId: id, id, state: 'CANCELLING' } });
      }

      // No running workflow to stop: it closed (or Temporal no longer knows it) without leaving
      // the campaign final, which is what a finalizer that exhausted its retries leaves. Nothing
      // else will ever close these rows, so this call does: the campaign CANCELLED and every
      // target still open with it (a legacy child of a closed campaign was cancelled with its
      // parent; a reconciled attempt was cancelled above). The state predicate leaves a campaign a
      // late finalizer closed as it wrote it.
      if (delivery === 'not-running') {
        const now = new Date();
        const closedStates = reconciled
          ? (['PENDING', 'BLOCKED', 'RUNNING', 'NEEDS_ATTENTION'] as const)
          : (['PENDING', 'RUNNING'] as const);
        const closed = await runUnscoped(
          'closing the targets of a campaign whose workflow is gone; the caller was authorized on the campaign above',
          ['Campaign', 'CampaignTarget'],
          () =>
            fastify.prisma.$transaction(async (tx) => {
              const done = await tx.campaign.updateMany({
                data: { completedAt: now, state: 'CANCELLED' },
                where: { id, ownerTeamId: campaign.ownerTeamId, state: 'CANCELLING' },
              });
              if (done.count === 0) {
                return null;
              }
              const targets = await tx.campaignTarget.updateMany({
                data: { finishedAt: now, state: 'CANCELLED' },
                where: { campaignId: id, state: { in: [...closedStates] } },
              });
              if (reconciled) {
                await tx.campaignAttempt.updateMany({
                  data: { finishedAt: now, outcome: 'CANCELLED' },
                  where: { finishedAt: null, target: { campaignId: id } },
                });
              }
              return targets.count;
            })
        );
        if (closed === null) {
          const now2 = await fastify.prisma.campaign.findFirst({
            select: { state: true },
            where: { id, ownerTeamId: campaign.ownerTeamId },
          });
          return reply
            .status(200)
            .send({ data: { campaignId: id, id, state: now2?.state ?? campaign.state } });
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: {
            cancelledById: user.sub,
            reconciled: 'the campaign workflow was no longer running',
            state: 'CANCELLED',
            targetsClosed: closed,
          },
          before: { state: campaign.state },
          entityId: id,
          entityType: 'Campaign',
        });
        return reply.status(200).send({ data: { campaignId: id, id, state: 'CANCELLED' } });
      }

      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { cancelledById: user.sub, state: 'CANCELLING' },
        before: { state: campaign.state },
        entityId: id,
        entityType: 'Campaign',
      });

      return reply.status(202).send({ data: { campaignId: id, id, state: 'CANCELLING' } });
    }
  );

  /**
   * Cancel the run of every attempt of the campaign that has not finished, through the run cancel
   * path (`temporal.cancelWorkflow`). A run Temporal no longer has is already stopped. Throws when
   * a cancel fails for any other reason, so the caller can ask the person to try again.
   */
  async function cancelRunningAttempts(campaignId: string): Promise<void> {
    const open = await fastify.prisma.campaignAttempt.findMany({
      select: { childWorkflowId: true },
      where: { finishedAt: null, target: { campaignId } },
    });
    for (const attempt of open) {
      if (!attempt.childWorkflowId) {
        continue;
      }
      try {
        await fastify.temporal.cancelWorkflow(attempt.childWorkflowId);
      } catch (err) {
        if (!isTerminalSignalError(err)) {
          throw err;
        }
      }
    }
  }
};

/** Whether the campaign's recipe has a read-only check, so a `MERGED` target can be confirmed. */
function recipeHasCheck(recipeRef: string | null | undefined): boolean {
  return recipeSupportsCheck(recipeRef);
}
