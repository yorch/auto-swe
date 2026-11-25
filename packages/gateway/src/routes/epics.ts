import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin } from '@auto-swe/shared/permissions';
import type { CampaignReconcilerInput } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { can } from '../lib/authz.js';
import { visibleToMember } from '../lib/campaignAccess.js';
import { campaignIdOfEpicWorkflowId, campaignStatusAsEpic } from '../lib/campaignEpic.js';
import { sendError } from '../lib/httpErrors.js';
import { uuidFromIdempotencyKey } from '../lib/idempotency.js';
import { allOfTeams, authorizeLaunch, sendLaunchRefusal } from '../lib/launchAuthorization.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  type ConnectionScopeGate,
  memberTeams,
  permissionRequirement,
  reachableConnections,
} from '../lib/tenantScope.js';
import { ExternalTicketIdSchema, MAX_DESCRIPTION_LENGTH } from '../lib/ticketId.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { resolveDefaultTemplate } from './workRequests.js';

const CreateEpicSchema = z.object({
  description: z
    .string()
    .min(1, 'description is required — tell the agent what to build across repos')
    .max(MAX_DESCRIPTION_LENGTH),
  externalTicketId: ExternalTicketIdSchema,
  repoIds: z.array(z.string().uuid()).min(1),
});

const ListEpicsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  // MINE narrows to epics the caller requested; TEAM is everything visible to them.
  scope: z.enum(['MINE', 'TEAM']).default('TEAM'),
  // Only epics with a child on a repository this team owns or has shared with it.
  teamId: z.string().uuid().optional(),
});

const EpicParams = z.object({
  workflowId: z.string().min(1),
});

const EPIC_ID_PREFIX = 'epic-';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Epics are persisted as WorkRequest rows with `isCrossRepo: true` whose
 * `requestPayload` is the original POST body (including `repoIds`). The epic's
 * own ActiveWorkflow row is self-registered by the orchestrator's first
 * `updateDomainState` call with `repoId: null`, so the repo set is only
 * recoverable from this payload.
 */
export function parseRepoIdsFromPayload(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as { repoIds?: unknown };
    if (Array.isArray(parsed.repoIds)) {
      return parsed.repoIds.filter((id): id is string => typeof id === 'string');
    }
  } catch {
    // Malformed legacy payload — treat as "no repos known".
  }
  return [];
}

/** Repo IDs the user can reach, for non-admin epic visibility. */
async function accessibleRepoIds(
  prisma: FastifyInstance['prisma'],
  actor: { sub: string },
  gate: ConnectionScopeGate | undefined
): Promise<Set<string>> {
  const rows = await prisma.connection.findMany({
    select: { id: true },
    // Spelled out rather than `reachableConnections(…)` so the tenant-guard
    // audit can read the `team` key off the literal; a repository shared with
    // one of the actor's teams counts like one their team owns.
    where: {
      AND: [
        { OR: [{ team: memberTeams(actor) }, { shares: { some: { team: memberTeams(actor) } } }] },
        permissionRequirement(actor, gate),
      ],
    },
  });
  return new Set(rows.map((r: { id: string }) => r.id));
}

type EpicRepo = {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  team: { id: string; orgId: string };
  teamId: string;
};

/**
 * Whether this epic launches as a `PLANNED` campaign: `workflow.campaignReconciler` is on for the
 * team that will own the campaign, `workflow.campaignsEnabled` holds for it and for every
 * repository's team (a campaign's attempts refuse a team that has it off), and the repositories fit
 * `workflow.campaignMaxTargets`. A setting that cannot be read means the legacy epic path.
 */
async function epicRunsAsCampaign(
  request: FastifyRequest,
  repos: EpicRepo[],
  owner: { id: string; orgId: string },
  repoCount: number
): Promise<boolean> {
  try {
    const ownerCtx = { orgId: owner.orgId, teamId: owner.id };
    if (!(await resolveSetting('workflow.campaignReconciler', ownerCtx))) {
      return false;
    }
    if (repoCount > (await resolveSetting('workflow.campaignMaxTargets', ownerCtx))) {
      return false;
    }
    const teams = new Map(repos.map((r) => [r.team.id, r.team]));
    teams.set(owner.id, owner);
    for (const team of teams.values()) {
      if (
        !(await resolveSetting('workflow.campaignsEnabled', { orgId: team.orgId, teamId: team.id }))
      ) {
        return false;
      }
    }
    return true;
  } catch (err) {
    request.log.warn(
      { err },
      'campaign settings unreadable; launching the epic on the epic workflow'
    );
    return false;
  }
}

/**
 * Launch the epic as a `PLANNED` campaign: gate `OPENED` (a downstream repository starts once
 * upstream's run succeeded, today's epic meaning), no recipe, no scope, one pending target per
 * repository for the planner to brief, state `PLANNING`. The campaign's id is derived from the
 * ticket, so a second launch for it answers `EPIC_ALREADY_EXISTS` as an epic does. The answer keeps
 * the epic's shape; `epicWorkflowId` is the campaign's workflow id, which `GET /epics/:id` reads.
 */
async function launchEpicAsCampaign(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: Parameters<typeof sendError>[0],
  input: {
    body: z.infer<typeof CreateEpicSchema>;
    owner: { id: string; orgId: string };
    repos: EpicRepo[];
    user: ReturnType<typeof requireUser>;
  }
) {
  const { body, owner, repos, user } = input;
  const { description, externalTicketId, repoIds } = body;
  const duplicate = () =>
    sendError(
      reply,
      409,
      'EPIC_ALREADY_EXISTS',
      `Epic workflow already running for ${externalTicketId}`
    );
  if (
    await fastify.prisma.activeWorkflow.findUnique({
      select: { id: true },
      where: { temporalWorkflowId: `${EPIC_ID_PREFIX}${externalTicketId}` },
    })
  ) {
    return duplicate();
  }
  const resolved = await resolveDefaultTemplate(fastify.prisma, owner.id, externalTicketId);
  if (!resolved) {
    return sendError(
      reply,
      503,
      'CAMPAIGN_TEMPLATE_MISSING',
      'No default workflow template is configured for the owning team'
    );
  }
  const ownerCtx = { orgId: owner.orgId, teamId: owner.id };
  const [maxParallel, openCeiling, staleAfterDays, rescanDefault, lifetimeDays, rescanFloor] =
    await Promise.all([
      resolveSetting('workflow.campaignMaxParallelChildren', ownerCtx),
      resolveSetting('workflow.campaignMaxOpenPullRequests', ownerCtx),
      resolveSetting('workflow.campaignStaleAfterDays', ownerCtx),
      resolveSetting('workflow.campaignRescanIntervalHours', ownerCtx),
      resolveSetting('workflow.campaignLifetimeDays', ownerCtx),
      resolveSetting('workflow.campaignRescanFloorHours', ownerCtx),
    ]);
  const rescanIntervalHours = Math.max(rescanDefault, rescanFloor);

  const campaignId = uuidFromIdempotencyKey('epic-campaign', externalTicketId);
  const temporalWorkflowId = `campaign-${campaignId}`;
  const workRequestId = crypto.randomUUID();
  const ticketId = `CAMPAIGN-${campaignId.replaceAll('-', '').slice(0, 12)}`;
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const targets = repoIds.map((id, position) => {
    const repo = repoById.get(id) as EpicRepo;
    return {
      connectionId: id,
      id: crypto.randomUUID(),
      position,
      repoLabel: `${repo.organizationName ?? '?'}/${repo.repoName ?? id}`,
      teamId: repo.teamId,
    };
  });
  const expiresAt = new Date(Date.now() + lifetimeDays * 86_400_000);
  const workflowInput: CampaignReconcilerInput = {
    campaignId,
    campaignWorkflowId: temporalWorkflowId,
  };

  const launch = await launchTrackedWorkflow(
    fastify.prisma,
    {
      activeWorkflow: {
        budgetTier: 'STANDARD',
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
        externalTicketId: ticketId,
        id: workRequestId,
        // Cross-repo, but with a pinned template: the legacy epics list selects `templateId: null`.
        isCrossRepo: true,
        requestedById: user.sub,
        requestPayload: JSON.stringify(body),
        templateId: resolved.templateId,
        templateVersion: resolved.version,
        ticketIsSynthetic: true,
      },
    },
    () => fastify.temporal.startCampaignReconcilerWorkflow(temporalWorkflowId, workflowInput),
    {
      audit: { actor: user, source: 'epic', templateId: resolved.templateId },
      inTransaction: async (tx) => {
        await tx.campaign.create({
          data: {
            createdById: user.sub,
            description,
            expiresAt,
            gate: 'OPENED',
            id: campaignId,
            launchedById: user.sub,
            maxOpenPullRequests: openCeiling,
            maxParallel,
            name: externalTicketId,
            orgId: owner.orgId,
            ownerTeamId: owner.id,
            plan: 'PLANNED',
            rescanIntervalHours,
            staleAfterDays,
            state: 'PLANNING',
            templateId: resolved.templateId,
            templateVersion: resolved.version,
            temporalWorkflowId,
            workflowKind: 'RECONCILER',
            workRequestId,
          },
        });
        await tx.campaignTarget.createMany({
          data: targets.map((t) => ({ ...t, campaignId })),
        });
      },
      log: fastify.log,
      sourceAuthorization: { actor: user },
    }
  );
  if (!launch.ok) {
    return duplicate();
  }
  try {
    await writeAuditLog(fastify, {
      action: 'CREATE',
      actor: user,
      after: {
        epic: externalTicketId,
        gate: 'OPENED',
        launchedById: user.sub,
        maxParallel,
        name: externalTicketId,
        ownerTeamId: owner.id,
        plan: 'PLANNED',
        state: 'PLANNING',
        targetCount: targets.length,
        workflowKind: 'RECONCILER',
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
      // Where the dashboard should land after creation: the epic page reads the campaign.
      detailPath: `/epics/${encodeURIComponent(temporalWorkflowId)}`,
      epicWorkflowId: temporalWorkflowId,
      externalTicketId,
      state: 'PLANNING',
      workRequestId,
    },
  });
}

export const epicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * An epic that was launched as a `PLANNED` campaign, in the epic detail's shape. Visible to its
   * creator, the owning team and anyone who reaches a target; ADMINs see every one. A target the
   * caller cannot reach is not listed, as in the legacy detail. Null when there is no such campaign
   * for this caller, so existence is not probeable.
   */
  async function readCampaignEpic(request: FastifyRequest, campaignId: string) {
    const user = requireUser(request);
    const gate = request.repoAccessGate;
    const admin = isPlatformAdmin(user);
    const campaign = await fastify.prisma.campaign.findFirst({
      select: {
        createdAt: true,
        createdBy: { select: { email: true, id: true, name: true } },
        description: true,
        id: true,
        name: true,
        state: true,
        temporalWorkflowId: true,
        updatedAt: true,
        workRequestId: true,
      },
      where: {
        id: campaignId,
        plan: 'PLANNED',
        ...(admin
          ? {}
          : { OR: [{ createdById: user.sub }, ...(visibleToMember(user, gate) ?? [])] }),
      },
    });
    if (!campaign) {
      return null;
    }
    const targetSelect = {
      attempts: { orderBy: { n: 'desc' as const }, select: { childWorkflowId: true }, take: 1 },
      connection: { select: { organizationName: true, repoName: true } },
      connectionId: true,
      repoLabel: true,
      state: true,
    } as const;
    const targets = admin
      ? await runUnscoped('admin reads every target of an epic campaign', ['CampaignTarget'], () =>
          fastify.prisma.campaignTarget.findMany({
            orderBy: { position: 'asc' },
            select: targetSelect,
            where: { campaignId },
          })
        )
      : await fastify.prisma.campaignTarget.findMany({
          orderBy: { position: 'asc' },
          select: targetSelect,
          where: {
            campaignId,
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
        });
    const childIds = targets.flatMap((t) =>
      t.attempts[0]?.childWorkflowId ? [t.attempts[0].childWorkflowId] : []
    );
    const rows =
      childIds.length > 0
        ? await fastify.prisma.activeWorkflow.findMany({
            select: { assignedBranch: true, id: true, temporalWorkflowId: true },
            where: { temporalWorkflowId: { in: childIds } },
          })
        : [];
    const rowByWorkflow = new Map(rows.map((r) => [r.temporalWorkflowId, r]));
    const children = targets.map((t) => {
      const childId = t.attempts[0]?.childWorkflowId ?? null;
      const row = childId ? rowByWorkflow.get(childId) : undefined;
      return {
        branch: row?.assignedBranch ?? null,
        organizationName: t.connection?.organizationName ?? null,
        repoId: t.connectionId,
        repoName: t.connection?.repoName ?? null,
        status: t.state,
        temporalWorkflowId: childId,
        workflowId: row?.id ?? null,
      };
    });
    children.sort((a, b) => (a.repoName ?? '').localeCompare(b.repoName ?? ''));
    return {
      campaignId: campaign.id,
      children,
      createdAt: campaign.createdAt,
      description: campaign.description,
      epicWorkflowId: campaign.temporalWorkflowId,
      externalTicketId: campaign.name,
      requestedBy: campaign.createdBy,
      state: campaign.state,
      status: campaignStatusAsEpic(campaign.state),
      updatedAt: campaign.updatedAt,
      workRequestId: campaign.workRequestId,
    };
  }

  app.post(
    '/',
    {
      onRequest: requireAuth({ handlerChecked: ['team.launch.multi-repo'] }),
      schema: {
        body: CreateEpicSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds } = request.body;
      const user = requireUser(request);

      // Validate all repos exist and are active. Include the requesting user's
      // team membership per repo so the access check below doesn't need a
      // second round-trip (mirrors the single-repo work-request route).
      // Unscoped by design: the caller supplies the ids and the membership rows
      // selected here are what the access check below decides on. Filtering by
      // team up front would turn "you cannot see this repo" into "no such repo".
      const repos = await runUnscoped(
        'access is decided from the memberships selected here, not by the where clause',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            select: {
              // `githubApiUrl` is what points the permission lookup at a GitHub
              // Enterprise host, and `githubUrl` lets the lookup see a half
              // override. `PermissionRepo` requires both, because omitting one
              // is silent: the lookup would treat the repository as being on the
              // instance's own host and send it the platform credential.
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
            // Only git_repo connections are valid epic targets; a non-git id (e.g.
            // mcp) simply isn't found and surfaces as REPOS_NOT_FOUND below.
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

      // An epic fans out into a push and a pull request on every repository it
      // names, so each is a launch in the sense the single-repo route means,
      // and it can spend against more than one org. Every repository refusal is
      // collected so the response names all of them — refusing on the first
      // would make a caller fix them one at a time.
      // The `can()` below is the recorded check that satisfies the `handler-checked` backstop and
      // its answer is deliberately not used. The refusal is `authorizeLaunch` with
      // `requireOwningTeamLead: true`, which also names the repositories it refuses; a test pins
      // that flag, so dropping it fails the build instead of leaving this route unguarded.
      await can(request, 'team.launch.multi-repo', allOfTeams(repos.map((repo) => repo.team.id)));
      const authorization = await authorizeLaunch(fastify.prisma, user, {
        gate: request.repoAccessGate,
        log: request.log,
        refusalShape: 'multi',
        repos,
        // An epic writes to every repository it names: LEAD on each owning team is the authority.
        requireOwningTeamLead: true,
        // Every child run is launched as the caller (`launchedById`).
        runIdentity: 'caller',
      });
      if (!authorization.ok) {
        return sendLaunchRefusal(reply, authorization.refusal);
      }

      // With the campaign reconciler on, an epic is a PLANNED campaign (docs/campaigns.md). It is
      // launched as one only when the reconciler's own preconditions hold for every team it
      // touches: otherwise the epic path below runs, exactly as it does with the setting off.
      // The owner team is the team of the FIRST repository the caller listed, not of the largest,
      // alphabetically first or most numerous team. The caller chose the order, `authorizeLaunch`
      // above already required LEAD on every owning team, so the first-listed one is a team the
      // caller leads and the one they pointed to as the epic's home; the campaign's settings, its
      // template and its visibility to ordinary members are then decided in that team's scope,
      // deterministically for the same request. `repos` comes back in query order, so it is looked
      // up by id, with `repos[0]` only as the fallback.
      const owner = (repos.find((r) => r.id === repoIds[0]) ?? repos[0])?.team;
      if (owner && (await epicRunsAsCampaign(request, repos, owner, repoIds.length))) {
        return launchEpicAsCampaign(fastify, request, reply, {
          body: request.body,
          owner,
          repos,
          user,
        });
      }

      const workRequestId = crypto.randomUUID();
      const epicWorkflowId = `${EPIC_ID_PREFIX}${externalTicketId}`;

      // Ledger first, workflow second: write RunInput + ActiveWorkflow rows, then
      // start the epic workflow, compensating if Temporal never starts. The unique
      // index on ActiveWorkflow.temporalWorkflowId is the atomic dedup gate.
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            budgetTier: 'STANDARD',
            currentStatus: 'STARTING',
            repoId: null,
            temporalWorkflowId: epicWorkflowId,
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
            isCrossRepo: true,
            requestedById: user.sub,
            requestPayload: JSON.stringify(request.body),
          },
        },
        () =>
          fastify.temporal.startEpicWorkflow(epicWorkflowId, {
            description,
            epicWorkflowId,
            externalTicketId,
            initiatedById: user.sub,
            launchedById: user.sub,
            repoIds,
            repos: [], // Empty — Planner Agent will decompose
            requestPayload: JSON.stringify(request.body),
            workRequestId,
          }),
        {
          audit: { actor: user, source: 'epic' },
          log: fastify.log,
          sourceAuthorization: { actor: user },
        }
      );

      if (!launch.ok) {
        return sendError(
          reply,
          409,
          'EPIC_ALREADY_EXISTS',
          `Epic workflow already running for ${externalTicketId}`
        );
      }

      return reply.status(201).send({
        data: {
          // Where the dashboard should land after creation — the epic detail
          // page polls GET /epics/:epicWorkflowId (PROD-3).
          detailPath: `/epics/${encodeURIComponent(epicWorkflowId)}`,
          epicWorkflowId,
          externalTicketId,
          workRequestId,
        },
      });
    }
  );

  // List epics. The epic's own ledger row carries no repository, and its repo
  // set in the request payload is a JSON string no exact predicate can reach —
  // so a non-admin's visibility runs through the children instead: each epic
  // child records its repository on its own `ActiveWorkflow`, linked to the
  // epic's work request, which is the same term run visibility uses.
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth(),
      schema: { querystring: ListEpicsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset, scope, teamId } = request.query;

      // An epic is a cross-repo RunInput with no template. PRD runs are
      // cross-repo too but always record the prd-decomposition template, so
      // `templateId: null` is what tells the two apart.
      //
      // Non-admins see an epic they requested, or one with a started child on
      // a repository they can reach. Both are exact relational matches, so
      // filtering and paginating in the query keeps `total` truthful. An epic
      // still in planning has no child rows yet and is listed for its requester
      // and ADMINs only until its first child starts.
      const where: Prisma.RunInputWhereInput = {
        isCrossRepo: true,
        templateId: null,
        ...(scope === 'MINE' && { requestedById: user.sub }),
        // A planning epic has no child rows, so it has no team until its first child starts.
        ...(teamId && {
          AND: [
            {
              activeWorkflows: {
                some: { repository: { OR: [{ teamId }, { shares: { some: { teamId } } }] } },
              },
            },
          ],
        }),
        ...(!isPlatformAdmin(user) && {
          OR: [
            { requestedById: user.sub },
            {
              activeWorkflows: {
                some: { repository: reachableConnections(user, request.repoAccessGate) },
              },
            },
          ],
        }),
      };

      // The epics launched as `PLANNED` campaigns (the reconciler on) are listed beside the legacy
      // ones, newest first. With none, the legacy page is answered exactly as it always was.
      const gate = request.repoAccessGate;
      const reachableTarget = {
        connection: {
          AND: [
            {
              OR: [{ team: memberTeams(user) }, { shares: { some: { team: memberTeams(user) } } }],
            },
            permissionRequirement(user, gate),
          ],
        },
      };
      const campaignScope = [
        ...(scope === 'MINE' ? [{ createdById: user.sub }] : []),
        ...(teamId
          ? [
              {
                targets: {
                  some: {
                    connection: { OR: [{ teamId }, { shares: { some: { teamId } } }] },
                  },
                },
              },
            ]
          : []),
      ];
      const [campaignTotal, legacyTotal] = await Promise.all([
        isPlatformAdmin(user)
          ? runUnscoped('admin lists every planned campaign', ['Campaign'], () =>
              fastify.prisma.campaign.count({ where: { AND: campaignScope, plan: 'PLANNED' } })
            )
          : fastify.prisma.campaign.count({
              where: {
                AND: campaignScope,
                OR: [
                  { createdById: user.sub },
                  { ownerTeam: { memberships: { some: { userId: user.sub } } } },
                  { targets: { some: reachableTarget } },
                ],
                plan: 'PLANNED',
              },
            }),
        fastify.prisma.runInput.count({ where }),
      ]);
      const window = campaignTotal > 0 ? offset + limit : limit;
      const workRequests = await fastify.prisma.runInput.findMany({
        include: { requestedBy: { select: { email: true, id: true, name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: campaignTotal > 0 ? 0 : offset,
        take: window,
        where,
      });
      const total = legacyTotal + campaignTotal;

      const campaignSelect = {
        createdAt: true,
        createdBy: { select: { email: true, id: true, name: true } },
        description: true,
        id: true,
        name: true,
        state: true,
        temporalWorkflowId: true,
        updatedAt: true,
        workRequestId: true,
      } as const;
      const campaigns =
        campaignTotal === 0
          ? []
          : isPlatformAdmin(user)
            ? await runUnscoped('admin lists every planned campaign', ['Campaign'], () =>
                fastify.prisma.campaign.findMany({
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  select: campaignSelect,
                  take: offset + limit,
                  where: { AND: campaignScope, plan: 'PLANNED' },
                })
              )
            : await fastify.prisma.campaign.findMany({
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: campaignSelect,
                take: offset + limit,
                where: {
                  AND: campaignScope,
                  OR: [
                    { createdById: user.sub },
                    { ownerTeam: { memberships: { some: { userId: user.sub } } } },
                    { targets: { some: reachableTarget } },
                  ],
                  plan: 'PLANNED',
                },
              });
      const campaignCounts =
        campaigns.length > 0
          ? await runUnscoped(
              'target counts of campaigns already authorized above',
              ['CampaignTarget'],
              () =>
                fastify.prisma.campaignTarget.groupBy({
                  _count: { _all: true },
                  by: ['campaignId'],
                  where: { campaignId: { in: campaigns.map((c) => c.id) } },
                })
            )
          : [];
      const repoCountByCampaign = new Map(campaignCounts.map((r) => [r.campaignId, r._count._all]));

      const page = workRequests.map((wr) => ({
        repoIds: parseRepoIdsFromPayload(wr.requestPayload),
        wr,
      }));
      const epicIds = page.map(({ wr }) => `${EPIC_ID_PREFIX}${wr.externalTicketId}`);
      const epicRows = await fastify.prisma.activeWorkflow.findMany({
        select: { currentStatus: true, temporalWorkflowId: true, updatedAt: true },
        where: { temporalWorkflowId: { in: epicIds } },
      });
      const rowById = new Map(epicRows.map((r) => [r.temporalWorkflowId, r]));

      const legacy = page.map(({ wr, repoIds }) => {
        const epicWorkflowId = `${EPIC_ID_PREFIX}${wr.externalTicketId}`;
        const row = rowById.get(epicWorkflowId);
        return {
          createdAt: wr.createdAt,
          description: wr.description,
          epicWorkflowId,
          externalTicketId: wr.externalTicketId,
          repoCount: repoIds.length,
          requestedBy: wr.requestedBy,
          // The orchestrator's row only appears after its first state update —
          // surface the gap as STARTING rather than pretending it failed.
          status: row?.currentStatus ?? 'STARTING',
          updatedAt: row?.updatedAt ?? null,
          workRequestId: wr.id,
        };
      });
      if (campaigns.length === 0) {
        return { data: legacy, meta: { limit, offset, total } };
      }
      const asEpics = campaigns.map((c) => ({
        campaignId: c.id,
        createdAt: c.createdAt,
        description: c.description,
        epicWorkflowId: c.temporalWorkflowId,
        externalTicketId: c.name,
        repoCount: repoCountByCampaign.get(c.id) ?? 0,
        requestedBy: c.createdBy,
        status: campaignStatusAsEpic(c.state),
        updatedAt: c.updatedAt,
        workRequestId: c.workRequestId,
      }));
      const merged = [...legacy, ...asEpics]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.workRequestId < b.workRequestId ? 1 : a.workRequestId > b.workRequestId ? -1 : 0)
        )
        .slice(offset, offset + limit);
      return { data: merged, meta: { limit, offset, total } };
    }
  );

  // Epic detail: status + per-repo child workflow fan-out progress.
  //
  // What the orchestrator records (packages/worker/src/workflows/epicOrchestrator.ts):
  //  - the epic's own ActiveWorkflow row keyed by `epic-<ticket>` (repoId null),
  //  - each child runs as `RunnableWorkflow` with workflowId `<epicId>-<repoId>`;
  //    the child self-registers its own ActiveWorkflow row via updateDomainState
  //    with repoId/parentWorkflowId/assignedBranch left null.
  // So children are matched by ID convention (and parentWorkflowId, for any
  // future code path that backfills it) and the repoId is parsed back out of
  // the child's temporal workflow ID suffix.
  app.get(
    '/:workflowId',
    {
      onRequest: requireAuth(),
      schema: { params: EpicParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { workflowId } = request.params;

      const notFound = () =>
        sendError(reply, 404, 'EPIC_NOT_FOUND', `Epic ${workflowId} not found`);

      // An epic launched as a campaign is `campaign-<uuid>`; its links keep working here.
      const campaignId = campaignIdOfEpicWorkflowId(workflowId);
      if (campaignId) {
        const epic = await readCampaignEpic(request, campaignId);
        return epic ? { data: epic } : notFound();
      }

      if (!workflowId.startsWith(EPIC_ID_PREFIX)) {
        return notFound();
      }
      const externalTicketId = workflowId.slice(EPIC_ID_PREFIX.length);

      const [workRequest, epicRow] = await Promise.all([
        fastify.prisma.runInput.findFirst({
          include: { requestedBy: { select: { email: true, id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          where: { externalTicketId, isCrossRepo: true, templateId: null },
        }),
        fastify.prisma.activeWorkflow.findUnique({
          where: { temporalWorkflowId: workflowId },
        }),
      ]);
      if (!workRequest && !epicRow) {
        return notFound();
      }

      const childRows = await fastify.prisma.activeWorkflow.findMany({
        orderBy: { updatedAt: 'desc' },
        where: {
          OR: [
            { parentWorkflowId: workflowId },
            { temporalWorkflowId: { startsWith: `${workflowId}-` } },
          ],
        },
      });

      // The startsWith match can catch a different epic whose ticket extends
      // this one (epic-T-2's children all start with "epic-T-"). Keep only rows
      // whose suffix is exactly one repo UUID, or that explicitly point at us.
      const children = childRows.flatMap((row) => {
        const suffix = row.temporalWorkflowId.startsWith(`${workflowId}-`)
          ? row.temporalWorkflowId.slice(workflowId.length + 1)
          : null;
        const repoId = row.repoId ?? (suffix !== null && UUID_RE.test(suffix) ? suffix : null);
        if (row.parentWorkflowId !== workflowId && repoId === null) {
          return [];
        }
        return [{ repoId, row }];
      });

      const requestedRepoIds = workRequest
        ? parseRepoIdsFromPayload(workRequest.requestPayload)
        : [];
      const knownRepoIds = [
        ...new Set([
          ...requestedRepoIds,
          ...children.map((c) => c.repoId).filter((id): id is string => id !== null),
        ]),
      ];

      // Visibility: ADMIN sees all; others need at least one of the epic's
      // repos on their team. 404 (not 403) so existence isn't probeable —
      // mirrors the list endpoint's silent filtering.
      if (!isPlatformAdmin(user)) {
        const allowed = await accessibleRepoIds(fastify.prisma, user, request.repoAccessGate);
        if (!knownRepoIds.some((id) => allowed.has(id))) {
          return notFound();
        }
      }

      // Name lookup for ids the caller was already authorised for above
      // (non-admins fail `accessibleRepoIds` and 404 before reaching here).
      const repos = await runUnscoped('ids already authorised above', ['Connection'], () =>
        fastify.prisma.connection.findMany({
          select: { id: true, organizationName: true, repoName: true },
          where: { id: { in: knownRepoIds } },
        })
      );
      const repoById = new Map(repos.map((r) => [r.id, r]));

      interface ChildEntry {
        branch: string | null;
        organizationName: string | null;
        repoId: string | null;
        repoName: string | null;
        status: string;
        temporalWorkflowId: string | null;
        workflowId: string | null;
      }
      const childData: ChildEntry[] = children.map(({ row, repoId }) => {
        const repo = repoId ? repoById.get(repoId) : undefined;
        return {
          // assignedBranch is null for self-registered child rows — nothing
          // backfills it today, so the UI renders a placeholder.
          branch: row.assignedBranch,
          organizationName: repo?.organizationName ?? null,
          repoId,
          repoName: repo?.repoName ?? null,
          status: row.currentStatus,
          temporalWorkflowId: row.temporalWorkflowId,
          workflowId: row.id,
        };
      });

      // Requested repos with no child row yet (epic still PLANNING, or the
      // repo is queued behind a dependency) render as PENDING placeholders.
      const startedRepoIds = new Set(children.map((c) => c.repoId));
      for (const repoId of requestedRepoIds) {
        if (!startedRepoIds.has(repoId)) {
          const repo = repoById.get(repoId);
          childData.push({
            branch: null,
            organizationName: repo?.organizationName ?? null,
            repoId,
            repoName: repo?.repoName ?? null,
            status: 'PENDING',
            temporalWorkflowId: null,
            workflowId: null,
          });
        }
      }
      childData.sort((a, b) => (a.repoName ?? '').localeCompare(b.repoName ?? ''));

      return {
        data: {
          children: childData,
          createdAt: workRequest?.createdAt ?? null,
          description: workRequest?.description ?? '',
          epicWorkflowId: workflowId,
          externalTicketId,
          requestedBy: workRequest?.requestedBy ?? null,
          status: epicRow?.currentStatus ?? 'STARTING',
          updatedAt: epicRow?.updatedAt ?? null,
          workRequestId: workRequest?.id ?? null,
        },
      };
    }
  );
};
