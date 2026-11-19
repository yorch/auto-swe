import { resolveSettings } from '@auto-swe/shared/config';
import {
  AGENT_REF_RE,
  AGENT_RUN_MAX_PROMPT_CHARS,
  AGENT_RUN_MAX_WALL_CLOCK_SECONDS,
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
  AgentRunPayloadSchema,
  NON_LAUNCHABLE_AGENT_KEYS,
} from '@auto-swe/shared/lib/agentRun';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin } from '@auto-swe/shared/permissions';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  agentScopeBranches,
  CreateAgentRunBody,
  createAgentRunLauncher,
} from '../lib/agentRunLaunch.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema } from '../lib/idempotency.js';
import { storedKnowledgeBases } from '../lib/knowledgeBases.js';
import { mcpWriteAuditHook, mcpWriteBegin } from '../lib/mcpWriteGuard.js';
import { isOrgMember } from '../lib/orgAccess.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireCaller, requireUser } from '../plugins/auth.js';

/**
 * `POST /api/v1/agent-runs`: run one library Agent against one repository.
 *
 * The launch pipeline lives in `lib/agentRunLaunch.ts` (shared with the orchestration
 * child-launch route). What it checks is for good error messages; the WORKER re-checks every
 * bound that matters, because the template is reachable from other launch paths.
 */

const MIN_WALL_CLOCK_SECONDS = 60;
const MAX_STEPS_HARD = 500;

const RepoContextQuery = z.object({
  repoId: z.string().uuid().optional(),
  /** A repo-less launch: the team whose ORGANIZATION agents apply. Ignored when `repoId` is given. */
  teamId: z.string().uuid().optional(),
});

const RerunParams = z.object({ workRequestId: z.string().uuid() });

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return sendError(reply, status, code, message);
}

export const agentRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const launch = createAgentRunLauncher(fastify);

  /**
   * The repository a form-support read is scoped to, or null (after replying 404)
   * when the caller cannot reach it. Same reach rule as the repository listing
   * and the launch: owning or shared team, under the repo-access gate; a
   * platform ADMIN reaches every active git repository. A repository the caller
   * cannot reach answers exactly as one that does not exist.
   */
  async function reachableRepo(
    request: Parameters<typeof requireUser>[0],
    reply: FastifyReply,
    repoId: string
  ) {
    const user = requireUser(request);
    const reach = isPlatformAdmin(user) ? null : reachableConnections(user, request.repoAccessGate);
    const repo = await asPlatformAdmin(
      user,
      'an admin may launch on any repository',
      ['Connection'],
      () =>
        fastify.prisma.connection.findFirst({
          select: { id: true, team: { select: { orgId: true } }, teamId: true },
          where: {
            AND: [...(reach ? [reach] : []), { id: repoId, isActive: true, type: 'git_repo' }],
          },
        })
    );
    // The launch also requires membership of the repository's organization; without
    // it the list would offer an organization's agents the launch then refuses.
    if (!repo || !(await isOrgMember(fastify.prisma, user, repo.team.orgId))) {
      error(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found or inactive');
      return null;
    }
    return { orgId: repo.team.orgId, repoId: repo.id, teamId: repo.teamId };
  }

  // The launchable agents, as the launch will resolve them: GLOBAL, plus the
  // repository's ORGANIZATION when `repoId` is given. Never TEAM scope: a
  // shared-team member must not be offered (or reach) the owning team's agents.
  app.get(
    '/agents',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth(),
      schema: { querystring: RepoContextQuery },
    },
    async (request, reply) => {
      let orgId: string | null = null;
      if (request.query.repoId) {
        const repo = await reachableRepo(request, reply, request.query.repoId);
        if (!repo) {
          return;
        }
        orgId = repo.orgId;
      } else if (request.query.teamId) {
        // A repo-less orchestration resolves agents for its named team's organization, as the
        // launch does: the caller must belong to the team (an ADMIN need not).
        const user = requireUser(request);
        const team = await fastify.prisma.team.findFirst({
          select: {
            isActive: true,
            memberships: { select: { userId: true }, where: { userId: user.sub } },
            orgId: true,
          },
          where: { id: request.query.teamId },
        });
        // The launch also requires membership of the organization: without it the list would
        // offer ORGANIZATION agents to a team member outside the organization. Such a caller
        // gets the answer a team that does not exist gets.
        if (
          !team?.isActive ||
          (team.memberships.length === 0 && !isPlatformAdmin(user)) ||
          !(await isOrgMember(fastify.prisma, user, team.orgId))
        ) {
          return error(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
        }
        orgId = team.orgId;
      }
      const rows = await runUnscoped(
        'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
        ['Agent'],
        () =>
          fastify.prisma.agent.findMany({
            orderBy: [{ key: 'asc' }, { version: 'desc' }],
            select: { description: true, key: true, name: true, scope: true, version: true },
            where: {
              isActive: true,
              key: { notIn: [...NON_LAUNCHABLE_AGENT_KEYS] },
              // With no repository there is no organization to match.
              OR: orgId ? agentScopeBranches(orgId) : agentScopeBranches(orgId).slice(0, 1),
            },
          })
      );
      const byKey = new Map<string, typeof rows>();
      // A key the launch grammar cannot express (a bundle-installed one may be) would be
      // offered and then refused with a 400.
      for (const r of rows.filter((r) => AGENT_REF_RE.test(r.key))) {
        byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
      }
      const data = [...byKey.entries()].map(([key, versions]) => {
        // Rows arrive newest version first. The worker resolves ORGANIZATION
        // before GLOBAL, so an org override is what an unpinned launch runs.
        const org = versions.find((v) => v.scope === 'ORGANIZATION');
        const effective = org ?? (versions[0] as (typeof versions)[number]);
        return {
          description: effective.description,
          key,
          name: effective.name,
          // Versions a `key@version` pin can select; none while an org override shadows the key.
          pinnableVersions: org
            ? []
            : versions.filter((v) => v.scope === 'GLOBAL').map((v) => v.version),
          scope: effective.scope,
          version: effective.version,
        };
      });
      return { data };
    }
  );

  // The ceilings and the kill switch, for the launch form. Resolved at the
  // repository's scope when `repoId` is given (the ceilings cascade to team and
  // organization), otherwise globally. Numbers only; no secrets.
  app.get(
    '/limits',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth(),
      schema: { querystring: RepoContextQuery },
    },
    async (request, reply) => {
      let ctx: { orgId?: string; teamId?: string } = {};
      if (request.query.repoId) {
        const repo = await reachableRepo(request, reply, request.query.repoId);
        if (!repo) {
          return;
        }
        ctx = { orgId: repo.orgId ?? undefined, teamId: repo.teamId };
      }
      const settings = await resolveSettings(
        [
          'workspace.agentRunMaxSteps',
          'workspace.agentRunMaxWallClockSeconds',
          'workspace.agentRunMaxConcurrentGlobal',
          'workspace.agentRunMaxConcurrentPerTeam',
        ],
        ctx
      );
      const global = settings['workspace.agentRunMaxConcurrentGlobal'];
      const perTeam = settings['workspace.agentRunMaxConcurrentPerTeam'];
      return {
        data: {
          // 0 disables agent runs, platform-wide or for the repository's team.
          concurrency: { global, perTeam },
          enabled: global > 0 && (request.query.repoId ? perTeam > 0 : true),
          maxSteps: {
            ceiling: settings['workspace.agentRunMaxSteps'],
            max: MAX_STEPS_HARD,
            min: 1,
          },
          maxWallClockSeconds: {
            ceiling: settings['workspace.agentRunMaxWallClockSeconds'],
            max: AGENT_RUN_MAX_WALL_CLOCK_SECONDS,
            min: MIN_WALL_CLOCK_SECONDS,
          },
        },
      };
    }
  );

  app.post(
    '/',
    {
      // Open to service principals: docs/service-principals.md.
      // `runs:agent`, not `runs:launch`: a free-form prompt to an agent of the caller's choosing.
      config: { mcpScope: 'write', serviceScopes: ['runs:agent'] },
      onRequest: requireAuth(),
      onSend: mcpWriteAuditHook,
      preValidation: mcpWriteBegin('start_agent_run'),
      schema: { body: CreateAgentRunBody, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      const b: CreateAgentRunBody = request.body;
      return launch(request, reply, {
        agent: b.agent,
        ...(b.baseBranch ? { baseBranch: b.baseBranch } : {}),
        budgetTier: b.budgetTier,
        ...(b.callback ? { callback: b.callback } : {}),
        caller,
        deliver: b.deliver,
        ...(b.knowledgeBases ? { knowledgeBases: b.knowledgeBases } : {}),
        ...(b.egressPolicy ? { egressPolicy: b.egressPolicy } : {}),
        idempotencyKey: request.headers['idempotency-key'],
        maxSteps: b.maxSteps,
        maxWallClockSeconds: b.maxWallClockSeconds,
        prompt: b.prompt,
        repoId: b.repoId,
      });
    }
  );

  // Re-run an earlier agent run as a NEW run. Not `POST /work-requests/:id/retry`,
  // which rebuilds the request without its payload and reuses the ticket id (and
  // so the branch name the first run already pushed).
  app.post(
    '/:workRequestId/rerun',
    {
      onRequest: requireAuth(),
      schema: {
        body: z.object({ instructions: z.string().trim().max(4000).optional() }).nullish(),
        headers: IdempotencyHeaderSchema,
        params: RerunParams,
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const prev = await fastify.prisma.runInput.findUnique({
        select: {
          connectionId: true,
          description: true,
          payload: true,
          requestPayload: true,
          templateId: true,
        },
        where: { id: request.params.workRequestId },
      });
      const template = prev?.templateId
        ? await fastify.prisma.workflowTemplate.findFirst({
            select: { id: true },
            where: {
              id: prev.templateId,
              name: AGENT_RUN_TEMPLATE_NAME,
              origin: AGENT_RUN_TEMPLATE_ORIGIN,
              teamId: null,
            },
          })
        : null;
      const parsed = AgentRunPayloadSchema.safeParse(prev?.payload);
      if (!prev || !template || !prev.connectionId || !parsed.success) {
        return error(reply, 404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found');
      }
      const p = parsed.data;
      // A child of an orchestration carries its orchestration id and path scopes in the payload;
      // a re-run rebuilds the payload field by field and would drop both, becoming an unscoped
      // direct run that skips the writer push-permission check.
      if (p.orchestrationId !== undefined) {
        return error(
          reply,
          409,
          'ORCHESTRATION_CHILD_NO_RERUN',
          'A run started by an orchestration cannot be re-run; ask its orchestrator to start another'
        );
      }
      const prompt = request.body?.instructions
        ? `${prev.description}\n\nAdditional instructions for this attempt:\n${request.body.instructions}`
        : prev.description;
      if (prompt.length > AGENT_RUN_MAX_PROMPT_CHARS) {
        return error(
          reply,
          400,
          'PROMPT_TOO_LONG',
          'The task and additional instructions exceed the prompt limit'
        );
      }
      return launch(request, reply, {
        agent: p.agentRef,
        // The original's base: a re-run of a fix for release/1.4 is still a fix for it.
        ...(p.baseBranch ? { baseBranch: p.baseBranch } : {}),
        // A re-run takes the default tier: the original's is on its ledger row and
        // a re-run is a fresh spend decision by whoever re-runs it.
        budgetTier: 'STANDARD',
        caller: { kind: 'user', user },
        deliver: p.deliver,
        // The stricter of the original's and the policy configured now (see `egressPolicyIsRerun`).
        ...(p.egressPolicy ? { egressPolicy: p.egressPolicy, egressPolicyIsRerun: true } : {}),
        idempotencyKey: request.headers['idempotency-key'],
        maxSteps: p.maxSteps,
        maxWallClockSeconds: p.maxWallClockSeconds,
        prompt,
        repoId: prev.connectionId,
        ...(storedKnowledgeBases(prev.requestPayload)
          ? { knowledgeBases: storedKnowledgeBases(prev.requestPayload) }
          : {}),
        workRequestId: request.params.workRequestId,
      });
    }
  );
};
