import crypto from 'node:crypto';
import { Role } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import {
  AGENT_REF_RE,
  AGENT_RUN_DELIVERIES,
  AGENT_RUN_MAX_PROMPT_CHARS,
  AGENT_RUN_MAX_WALL_CLOCK_SECONDS,
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
  type AgentRunPayload,
  AgentRunPayloadSchema,
  agentRunTicketId,
  isLaunchableAgentKey,
  NON_LAUNCHABLE_AGENT_KEYS,
} from '@auto-swe/shared/lib/agentRun';
import {
  closeAgentRunLedgerRows,
  loadAgentRunSlots,
  reconcileAgentRunSlots,
  wouldAdmitNewRun,
} from '@auto-swe/shared/lib/agentRunAdmission';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { generateBranchName } from '@auto-swe/shared/lib/workflowId';
import type { BudgetTier, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdempotencyHeaderSchema, workflowIdFromIdempotencyKey } from '../lib/idempotency.js';
import { isOrgMember } from '../lib/orgAccess.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { validateRunConnection } from '../lib/runConnection.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * `POST /api/v1/agent-runs`: run one library Agent against one repository.
 *
 * A launch is a `WorkflowRun` of the hidden "Agent Run" system template. What
 * this route checks is for good error messages; the WORKER re-checks every
 * bound that matters (template identity, payload, non-launchable agents,
 * ceilings, concurrency), because the template is reachable from other launch
 * paths and nothing here can be assumed to have run.
 */

const CreateAgentRunBody = z.object({
  /** Library agent: `<key>` (float) or `<key>@<version>` (pin the GLOBAL version). */
  agent: z.string().min(1).max(130).regex(AGENT_REF_RE),
  budgetTier: z.enum(['STANDARD', 'LARGE', 'EPIC']).default('STANDARD'),
  /** `none` shows the diff, `branch` pushes a branch, `draft_pr` also opens a DRAFT pull request. */
  deliver: z.enum(AGENT_RUN_DELIVERIES).default('none'),
  /** Can only lower the platform ceiling. */
  maxSteps: z.number().int().min(1).max(500).optional(),
  maxWallClockSeconds: z.number().int().min(60).max(14_400).optional(),
  prompt: z.string().min(1).max(AGENT_RUN_MAX_PROMPT_CHARS),
  repoId: z.string().uuid(),
});
type CreateAgentRunBody = z.infer<typeof CreateAgentRunBody>;

const MIN_WALL_CLOCK_SECONDS = 60;
const MAX_STEPS_HARD = 500;

const RepoContextQuery = z.object({ repoId: z.string().uuid().optional() });

/**
 * The agent rows an agent run may resolve: GLOBAL, and the repository's
 * ORGANIZATION. One definition for the launch check and the picker, so the
 * list never offers an agent the launch would then refuse to find.
 */
function agentScopeBranches(orgId: string | null) {
  return [
    { channelId: null, scope: 'GLOBAL' as const, teamId: null, workflowTemplateId: null },
    { orgId, scope: 'ORGANIZATION' as const },
  ];
}

const RerunParams = z.object({ workRequestId: z.string().uuid() });

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

interface LaunchInput {
  agent: string;
  budgetTier: BudgetTier;
  deliver: AgentRunPayload['deliver'];
  idempotencyKey: string | undefined;
  maxSteps?: number;
  maxWallClockSeconds?: number;
  prompt: string;
  repoId: string;
  /** The user the run acts as and is charged through. */
  user: JwtPayload;
}

export const agentRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * The launch pipeline shared by a fresh launch and a re-run, so a re-run
   * re-validates everything (the agent may have been deactivated, a ceiling
   * lowered, the caller's access revoked) instead of replaying a stored decision.
   */
  async function launch(
    request: Parameters<typeof requireUser>[0],
    reply: FastifyReply,
    input: LaunchInput
  ) {
    const { user } = input;
    const { key, version } = splitRef(input.agent);

    if (!isLaunchableAgentKey(key)) {
      return error(
        reply,
        400,
        'AGENT_NOT_LAUNCHABLE',
        `Agent '${key}' backs a platform mechanism and cannot be launched as an agent run`
      );
    }

    // Authorisation: repository access (owning OR shared team), GitHub
    // permission, the caller as the run's identity, the org's monthly cap.
    const connection = await validateRunConnection(
      {
        connectionId: input.repoId,
        gate: request.repoAccessGate,
        log: request.log,
        prisma: fastify.prisma,
        providerMeta: null,
        templateTeamId: null,
        user,
      },
      reply
    );
    if (!connection.ok) {
      return;
    }

    const repo = await fastify.prisma.connection.findUnique({
      select: {
        githubApiUrl: true,
        githubUrl: true,
        id: true,
        organizationName: true,
        repoName: true,
        team: { select: { orgId: true } },
        teamId: true,
        type: true,
      },
      where: { id: input.repoId },
    });
    if (!repo) {
      return error(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found or inactive');
    }
    if (!isGitRepoConnection(repo)) {
      return error(reply, 400, 'NOT_A_GIT_REPO', 'Agent runs need a git repository');
    }
    // Every credential is sent to these URLs; refuse early and clearly. The
    // worker's SCM layer checks again at the point of sending.
    const hosts = await repositoryHostsAllowed({
      githubApiUrl: repo.githubApiUrl,
      githubUrl: repo.githubUrl,
    });
    if (!hosts.ok) {
      return error(
        reply,
        422,
        'REPO_HOST_NOT_ALLOWED',
        `This repository's host is not on the approved repository hosts (${hosts.url})`
      );
    }

    // The agent must exist where this run can resolve it. A shared-team member
    // launches here, so the owning team's TEAM-scope agents do not apply:
    // GLOBAL and the repository's ORGANIZATION only (the worker resolves the same way).
    const orgId = repo.team.orgId;
    const agents = await runUnscoped(
      'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
      ['Agent'],
      () =>
        fastify.prisma.agent.findMany({
          select: { scope: true, version: true },
          where: { isActive: true, key, OR: agentScopeBranches(orgId) },
        })
    );
    const found =
      version === undefined
        ? agents.length > 0
        : // A pin applies to the GLOBAL lineage only.
          agents.some((a) => a.scope === 'GLOBAL' && a.version === version);
    if (!found) {
      return error(
        reply,
        404,
        'AGENT_NOT_FOUND',
        version === undefined
          ? `No active agent '${key}' at global or organization scope`
          : `No active global agent '${key}' at version ${version}`
      );
    }

    // The worker resolves ORGANIZATION before GLOBAL, and a version pin only
    // applies to GLOBAL, so with an active ORG override the run would execute
    // the org's latest version, not the one the caller named. Refuse rather
    // than run a different agent than the one asked for.
    if (version !== undefined && agents.some((a) => a.scope === 'ORGANIZATION')) {
      return error(
        reply,
        400,
        'AGENT_PIN_SHADOWED',
        `'${key}' has an active organization-scope override, which a version pin cannot select; ` +
          'launch it without @version to run the override'
      );
    }

    // Ceilings and the kill switch. A launch can only lower a ceiling.
    const settings = await resolveSettings(
      [
        'workspace.agentRunMaxSteps',
        'workspace.agentRunMaxWallClockSeconds',
        'workspace.agentRunMaxConcurrentGlobal',
        'workspace.agentRunMaxConcurrentPerTeam',
      ],
      { orgId, teamId: repo.teamId }
    );
    const ceilings = {
      maxSteps: settings['workspace.agentRunMaxSteps'],
      maxWallClockSeconds: settings['workspace.agentRunMaxWallClockSeconds'],
    };
    if (input.maxSteps !== undefined && input.maxSteps > ceilings.maxSteps) {
      return error(
        reply,
        400,
        'CAP_EXCEEDS_CEILING',
        `maxSteps ${input.maxSteps} is above the platform ceiling of ${ceilings.maxSteps}`
      );
    }
    if (
      input.maxWallClockSeconds !== undefined &&
      input.maxWallClockSeconds > ceilings.maxWallClockSeconds
    ) {
      return error(
        reply,
        400,
        'CAP_EXCEEDS_CEILING',
        `maxWallClockSeconds ${input.maxWallClockSeconds} is above the platform ceiling of ${ceilings.maxWallClockSeconds}`
      );
    }

    const template = await fastify.prisma.workflowTemplate.findFirst({
      select: { activeVersion: true, id: true },
      where: {
        name: AGENT_RUN_TEMPLATE_NAME,
        origin: AGENT_RUN_TEMPLATE_ORIGIN,
        status: 'ACTIVE',
        teamId: null,
      },
    });
    if (!template?.activeVersion) {
      return error(
        reply,
        503,
        'AGENT_RUN_TEMPLATE_MISSING',
        'The Agent Run system template is not installed; run the database seed'
      );
    }

    // Concurrency. Friendly early refusal; the worker admits by rank and is the authority.
    // A ledger row only holds a slot while its workflow is still running in
    // Temporal; one whose workflow is gone is closed here (bounded, and kept
    // counting when Temporal cannot be asked).
    const liveSlots = await reconcileAgentRunSlots(
      await loadAgentRunSlots(fastify.prisma, template.id),
      {
        close: closeAgentRunLedgerRows(fastify.prisma),
        isRunning: async (workflowId) => !(await fastify.temporal.isWorkflowGone(workflowId)),
        onClosed: (workflowIds) =>
          fastify.log.warn(
            { workflowIds },
            'closed agent run ledger rows whose workflow is no longer running'
          ),
        onUnreachable: (workflowId, err) =>
          fastify.log.warn(
            { err, workflowId },
            'could not confirm an agent run is finished; it keeps its concurrency slot'
          ),
      }
    );
    const admission = wouldAdmitNewRun(liveSlots, repo.teamId, {
      global: settings['workspace.agentRunMaxConcurrentGlobal'],
      perTeam: settings['workspace.agentRunMaxConcurrentPerTeam'],
    });
    if (!admission.admitted) {
      return admission.reason === 'disabled'
        ? error(reply, 403, 'AGENT_RUNS_DISABLED', 'Agent runs are disabled for this team')
        : error(
            reply,
            429,
            'AGENT_RUN_CONCURRENCY_EXCEEDED',
            admission.reason === 'team_limit'
              ? "This team's agent runs are at their concurrency limit; try again when one finishes"
              : 'Agent runs are at the platform concurrency limit; try again when one finishes'
          );
    }

    // Launch parameters travel in RunInput.payload; the worker re-parses them.
    const payload: AgentRunPayload = AgentRunPayloadSchema.parse({
      agentRef: input.agent,
      deliver: input.deliver,
      maxSteps: input.maxSteps,
      maxWallClockSeconds: input.maxWallClockSeconds,
    });
    const workRequestId = crypto.randomUUID();
    const externalTicketId = agentRunTicketId(workRequestId);
    const repo8 = repo.id.replace(/-/g, '').slice(0, 8);
    // The key is scoped to the caller as well as the repo: two users who pick the
    // same key on one repo must not collide, and a 409 must not reveal the other's run.
    const user8 = user.sub.replace(/-/g, '').slice(0, 8);
    const temporalWorkflowId = input.idempotencyKey
      ? workflowIdFromIdempotencyKey('agent', `${repo8}-${user8}`, input.idempotencyKey)
      : `agent-${repo8}-${crypto.randomUUID().replace(/-/g, '')}`;
    const { branchPrefix } = await resolveWorkflowDefaults();
    const requestPayload = JSON.stringify({
      agent: input.agent,
      budgetTier: input.budgetTier,
      deliver: input.deliver,
      maxSteps: input.maxSteps,
      maxWallClockSeconds: input.maxWallClockSeconds,
      prompt: input.prompt,
      repoId: input.repoId,
    });
    const repoWorkRequest: RepoWorkRequest = {
      budgetTier: input.budgetTier,
      connectionId: repo.id,
      description: input.prompt,
      externalTicketId,
      // The run acts as, and uses the saved GitHub credential of, its launcher.
      launchedById: user.sub,
      payload,
      repoId: repo.id,
      requestPayload,
      workRequestId,
      workspaceProvider: 'git_repo',
    };

    // Ledger rows first, workflow second, rolled back if the start fails. The
    // ActiveWorkflow row is mandatory: the worker derives the run's team and
    // org (settings, concurrency, budget) from it.
    const result = await launchTrackedWorkflow(
      fastify.prisma,
      {
        activeWorkflow: {
          assignedBranch:
            input.deliver === 'none' ? null : generateBranchName(externalTicketId, branchPrefix),
          budgetTier: input.budgetTier,
          currentStatus: 'IMPLEMENTING',
          repoId: repo.id,
          temporalWorkflowId,
          workRequestId,
        },
        runInput: {
          connectionId: repo.id,
          description: input.prompt,
          externalTicketId,
          id: workRequestId,
          payload: payload as object,
          requestedById: user.sub,
          requestPayload,
          templateId: template.id,
          templateVersion: template.activeVersion,
        },
      },
      () =>
        fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
          request: repoWorkRequest,
          templateId: template.id,
          templateVersion: template.activeVersion as number,
        }),
      { log: fastify.log }
    );
    if (!result.ok) {
      return error(reply, 409, 'RUN_CONFLICT', 'A run with this idempotency key already exists');
    }
    return reply.status(201).send({
      data: {
        effective: {
          deliver: payload.deliver,
          maxSteps: Math.min(payload.maxSteps ?? ceilings.maxSteps, ceilings.maxSteps),
          maxWallClockSeconds: Math.min(
            payload.maxWallClockSeconds ?? ceilings.maxWallClockSeconds,
            ceilings.maxWallClockSeconds
          ),
        },
        temporalWorkflowId,
        workflowId: result.activeWorkflowId,
        workRequestId,
      },
    });
  }

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
    const reach =
      user.role === Role.ADMIN ? null : reachableConnections(user, request.repoAccessGate);
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
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
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateAgentRunBody, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const b: CreateAgentRunBody = request.body;
      return launch(request, reply, {
        agent: b.agent,
        budgetTier: b.budgetTier,
        deliver: b.deliver,
        idempotencyKey: request.headers['idempotency-key'],
        maxSteps: b.maxSteps,
        maxWallClockSeconds: b.maxWallClockSeconds,
        prompt: b.prompt,
        repoId: b.repoId,
        user,
      });
    }
  );

  // Re-run an earlier agent run as a NEW run. Not `POST /work-requests/:id/retry`,
  // which rebuilds the request without its payload and reuses the ticket id (and
  // so the branch name the first run already pushed).
  app.post(
    '/:workRequestId/rerun',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { headers: IdempotencyHeaderSchema, params: RerunParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const prev = await fastify.prisma.runInput.findUnique({
        select: { connectionId: true, description: true, payload: true, templateId: true },
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
      return launch(request, reply, {
        agent: p.agentRef,
        // A re-run takes the default tier: the original's is on its ledger row and
        // a re-run is a fresh spend decision by whoever re-runs it.
        budgetTier: 'STANDARD',
        deliver: p.deliver,
        idempotencyKey: request.headers['idempotency-key'],
        maxSteps: p.maxSteps,
        maxWallClockSeconds: p.maxWallClockSeconds,
        prompt: prev.description,
        repoId: prev.connectionId,
        user,
      });
    }
  );
};

function splitRef(ref: string): { key: string; version: number | undefined } {
  const at = ref.lastIndexOf('@');
  return at === -1
    ? { key: ref, version: undefined }
    : { key: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}
