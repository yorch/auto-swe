import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { isLaunchableAgentKey } from '@auto-swe/shared/lib/agentRun';
import { handLaunchBlock } from '@auto-swe/shared/lib/channelTask';
import {
  PLANNED_RUN_TEMPLATE_NAME,
  plannedRunTicketId,
  RUN_PLAN_MODES,
  type RunPlanMode,
} from '@auto-swe/shared/lib/plannedRun';
import {
  runPlanGenerationWorkflowId,
  runPlanRouteWorkflowId,
} from '@auto-swe/shared/lib/runPlanWorkflows';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { BUDGET_TIERS } from '@auto-swe/shared/types/workflow';
import { RUN_PLAN_INTENT_MAX_CHARS } from '@auto-swe/shared/workflow/runPlan';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import {
  IdempotencyHeaderSchema,
  uuidFromIdempotencyKey,
  workflowIdFromIdempotencyKey,
} from '../lib/idempotency.js';
import { launchableAgentKeys } from '../lib/launchableAgents.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  createRunPlanQuotaPolicy,
  releaseGenerationSlot,
  reserveGenerationSlot,
  reserveRouteSlot,
} from '../lib/runPlanQuotas.js';
import {
  approveAndLaunchPlan,
  authorizeRepository,
  createPlanRecord,
  loadPlannedRunTemplate,
  type PlanRefusal,
  rejectPlan,
  snapshotPlanSettings,
} from '../lib/runPlanService.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { teamMembershipFilter } from '../lib/templateLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import type { RunPlanJobState } from '../plugins/temporal.js';

/**
 * Launch-time workflow generation over HTTP (docs/specs/2026-11-17-launch-time-workflow-generation.md,
 * section 7). A person describes a goal; the platform ranks the templates they may already launch,
 * or generates a plan (a job), stores it as a PENDING `RunPlan`, and starts nothing until that same
 * person approves exactly the stored plan.
 *
 * - **People only.** A service principal cannot rank, create, read or approve a plan; the auth
 *   layer refuses its token on a route with no `serviceScopes`, and the handlers refuse a request
 *   that somehow carries a principal, so the owner column can never name one.
 * - **The client names a goal and a repository, nothing else.** The mode, the launchable agent
 *   keys and every limit are computed here; a body that tries to supply one is a validation error
 *   (the schemas are strict).
 * - **A plan is its owner's.** Every read and write is keyed on the owner, and a plan that is
 *   someone else's, or does not exist, is the same 404.
 * - **No intent or spec text reaches a log or an error message.** Logs carry ids and error names.
 *   The job-status route never returns the spec; only `GET /:id` does, to the owner.
 */

/** Exactly the ids `POST /` mints (`runPlanGenerationWorkflowId('<user8>-<hex>')`). */
const JOB_ID_RE = /^runplan-[0-9a-f]{8}-[0-9a-f]{16,32}$/;
/** A finished generation job is turned into a plan only this long after it closed. */
const JOB_PERSIST_WINDOW_MS = 24 * 3_600_000;
/** Templates offered to the router, most recently changed first. */
const ROUTE_CANDIDATE_CAP = 100;
/** Matches returned to the caller. */
const ROUTE_MAX_RESULTS = 5;

const PLAN_STATUSES = ['PENDING', 'APPROVED', 'LAUNCHED', 'REJECTED', 'EXPIRED'] as const;

const Intent = z.string().trim().min(1).max(RUN_PLAN_INTENT_MAX_CHARS);

const RouteBody = z.object({ intent: Intent, repoId: z.string().uuid() }).strict();
const CreateBody = z
  .object({
    /** A library agent key; present means an output-only plan built on it. */
    agent: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
    intent: Intent,
    repoId: z.string().uuid(),
  })
  .strict();
const IdParam = z.object({ id: z.string().uuid() });
const JobParam = z.object({ jobId: z.string().regex(JOB_ID_RE) });
const ListQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  status: z.enum(PLAN_STATUSES).optional(),
});
const ApproveBody = z
  .object({ budgetTier: z.enum(BUDGET_TIERS).optional() })
  .strict()
  .nullish();

/** What a generation workflow carries in its memo (see `RunPlanGenerationMemo`). */
const MemoSchema = z.object({
  intentHash: z.string(),
  mode: z.enum(RUN_PLAN_MODES),
  ownerUserId: z.string(),
  repoId: z.string().uuid(),
  teamId: z.string(),
});

const user8Of = (userId: string) => userId.replace(/-/g, '').slice(0, 8);

/** The plan a job becomes: derived from the job id, so persisting twice finds one row. */
export function planIdForJob(userId: string, jobId: string): string {
  return uuidFromIdempotencyKey(`run-plan:${userId}`, jobId);
}

function intentHash(repoId: string, agent: string | undefined, intent: string): string {
  return crypto
    .createHash('sha256')
    .update(`${repoId}\n${agent ?? ''}\n${intent}`)
    .digest('hex');
}

/** The refusal statuses the approval path reports, by kind. */
const POLICY_CODES: ReadonlySet<string> = new Set([
  'PLAN_AGENT_MISMATCH',
  'PLAN_POLICY_FAILED',
  'PLAN_SPEC_INVALID',
  'PLAN_SPEC_TOO_DEEP',
  'PLAN_SPEC_TOO_LARGE',
]);
const DRIFT_KINDS: Readonly<Record<string, string>> = {
  PLAN_AGENTS_CHANGED: 'agents',
  PLAN_CATALOG_CHANGED: 'catalog',
  PLAN_REPOSITORY_CHANGED: 'repository',
  PLAN_SETTINGS_CHANGED: 'settings',
  PLAN_TAMPERED: 'spec',
};

/** How a stored job failure is reported: a stable code, a fixed message, and whether to retry. */
const JOB_FAILURES: Readonly<
  Record<string, { code: string; message: string; retryable: boolean }>
> = {
  AGENTS_UNAVAILABLE: {
    code: 'PLAN_AGENTS_UNAVAILABLE',
    message: 'An agent the plan needs is not available',
    retryable: false,
  },
  GENERATION_FAILED: {
    code: 'PLAN_GENERATION_FAILED',
    message: 'The platform could not produce a valid plan for that goal. Try rephrasing it.',
    retryable: true,
  },
  GENERATION_UNAVAILABLE: {
    code: 'PLAN_GENERATION_UNAVAILABLE',
    message: 'Plan generation did not finish. Try again shortly.',
    retryable: true,
  },
  PLAN_INPUT_INVALID: {
    code: 'PLAN_INPUT_INVALID',
    message: 'The request cannot be turned into a plan',
    retryable: false,
  },
  PLANNED_RUN_TEMPLATE_MISSING: {
    code: 'PLANNED_RUN_TEMPLATE_MISSING',
    message: 'The Planned Run system template is not installed; ask an administrator',
    retryable: false,
  },
};

function sendRefusal(reply: FastifyReply, refusal: PlanRefusal, details?: unknown) {
  return sendError(reply, refusal.status, refusal.code, refusal.message, details);
}

type SpecNode = { type?: unknown; step?: unknown };
type Issue = { code?: unknown; message?: unknown; nodeId?: unknown };

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Mark each node of a plan for the preview: `core` (the pinned canonical core of a delivering
 * plan), `mandatory` (an output-only plan's agent and human-review nodes), `injected` (added by
 * the platform around the model's own nodes: the validate phase) and `free` (the model's).
 * Read from the stored skeleton report, which the policy produced, never inferred from node names.
 */
function markNodes(plan: {
  spec: unknown;
  skeletonReport: unknown;
  routerCandidates: unknown;
}): Array<{
  id: string;
  type: string | null;
  step: string | null;
  marker: string;
  region: string;
}> {
  const nodes = asRecord(asRecord(plan.spec).nodes);
  const report = asRecord(plan.skeletonReport);
  const regions = asRecord(report.regions);
  const core = new Set(asStrings(regions.core));
  const pre = new Set(asStrings(regions.pre));
  const post = new Set(asStrings(regions.post));
  const mandatory = new Set(Object.values(asRecord(report.mandatory)).flatMap(asStrings));
  const injected = new Set(asStrings(asRecord(plan.routerCandidates).injected));
  return Object.entries(nodes).map(([id, raw]) => {
    const node = raw as SpecNode;
    const marker = core.has(id)
      ? 'core'
      : injected.has(id)
        ? 'injected'
        : mandatory.has(id)
          ? 'mandatory'
          : 'free';
    return {
      id,
      marker,
      region: core.has(id) ? 'core' : pre.has(id) ? 'pre' : post.has(id) ? 'post' : 'plan',
      step: typeof node.step === 'string' ? node.step : null,
      type: typeof node.type === 'string' ? node.type : null,
    };
  });
}

function warningsOf(plan: { skeletonReport: unknown; validationReport: unknown }) {
  const out: Array<{ source: string; code: string; message: string; nodeId: string | null }> = [];
  for (const [source, report] of [
    ['skeleton', plan.skeletonReport],
    ['validation', plan.validationReport],
  ] as const) {
    for (const w of (asRecord(report).warnings as Issue[] | undefined) ?? []) {
      out.push({
        code: String(w.code ?? ''),
        message: String(w.message ?? ''),
        nodeId: typeof w.nodeId === 'string' ? w.nodeId : null,
        source,
      });
    }
  }
  return out;
}

type PlanRow = Prisma.RunPlanGetPayload<object>;

/** The whole plan, for its owner. The spec is here and only here. */
function planView(plan: PlanRow) {
  return {
    agentKey: plan.agentKey,
    agentPins: plan.agentPins,
    approvedAt: plan.approvedAt?.toISOString() ?? null,
    connectionId: plan.connectionId,
    cost: plan.costEstimate,
    createdAt: plan.createdAt.toISOString(),
    expiresAt: plan.expiresAt.toISOString(),
    id: plan.id,
    intent: plan.intent,
    launchedWorkflowRunId: plan.launchedWorkflowRunId,
    mode: plan.mode,
    model: plan.model,
    nodes: markNodes(plan),
    spec: plan.spec,
    specHash: plan.specHash,
    status: plan.status,
    teamId: plan.teamId,
    warnings: warningsOf(plan),
  };
}

export const runPlanRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const quotas = createRunPlanQuotaPolicy(fastify.prisma);

  const deps = (request: FastifyRequest) => ({
    gate: request.repoAccessGate,
    log: request.log,
    prisma: fastify.prisma,
    quotas,
  });

  /** A person only. The auth layer already refuses a service token; this is the second lock. */
  function refuseServicePrincipal(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.principal) {
      sendError(
        reply,
        403,
        'RUN_PLAN_SERVICE_FORBIDDEN',
        'Run plans are for people; a service principal cannot create or approve one'
      );
      return true;
    }
    return false;
  }

  /** Best effort: an audit write that fails is logged by id and never fails the action. */
  async function audit(args: Parameters<typeof writeAuditLog>[1]): Promise<void> {
    try {
      await writeAuditLog(fastify, args);
    } catch (err) {
      fastify.log.warn(
        { entityId: args.entityId, err: err instanceof Error ? err.name : 'unknown' },
        'run plan audit entry could not be written'
      );
    }
  }

  // ── Rank the templates the caller may launch for a goal ──
  app.post(
    '/route',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: RouteBody },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { intent, repoId } = request.body;
      const repo = await authorizeRepository(deps(request), { sub: user.sub }, repoId);
      if (!repo.ok) {
        return sendRefusal(reply, repo);
      }
      const scope = { orgId: repo.repo.orgId, teamId: repo.repo.teamId };
      const refused = await reserveRouteSlot(fastify, {
        entityId: crypto.randomUUID(),
        repoId,
        scope,
        user,
      });
      if (refused) {
        return sendRefusal(reply, refused);
      }

      // Candidates are what this person could launch themselves: the launch route's visibility
      // filter (active, global or one of their teams), minus system templates, review and
      // automation kinds and the channel assistant, and only those fit for a repository run.
      const rows = await fastify.prisma.workflowTemplate.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: { description: true, id: true, kind: true, name: true, teamId: true },
        take: ROUTE_CANDIDATE_CAP * 3,
        where: {
          AND: [
            { activeVersion: { not: null }, status: 'ACTIVE' },
            teamMembershipFilter(user),
            EXCLUDE_SYSTEM_TEMPLATES,
            { OR: [{ workspaceProvider: null }, { workspaceProvider: 'git_repo' }] },
            // A team's template is run on that team's repositories.
            { OR: [{ teamId: null }, { teamId: repo.repo.teamId }] },
          ],
        },
      });
      const candidates = rows
        .filter((t) => t.name !== PLANNED_RUN_TEMPLATE_NAME)
        .filter(
          (t) =>
            handLaunchBlock({ kind: t.kind, name: t.name, team: t.teamId ? {} : null }) === null
        )
        .slice(0, ROUTE_CANDIDATE_CAP);
      if (candidates.length === 0) {
        return { data: { matches: [], noneFit: true } };
      }
      const byId = new Map(candidates.map((t) => [t.id, t]));

      let ranked: Awaited<ReturnType<typeof fastify.temporal.routeRunPlan>>;
      try {
        ranked = await fastify.temporal.routeRunPlan(
          runPlanRouteWorkflowId(`${user8Of(user.sub)}-${crypto.randomUUID().replace(/-/g, '')}`),
          {
            candidates: candidates.map((t) => ({
              description: t.description,
              id: t.id,
              name: t.name,
            })),
            intent,
            maxResults: ROUTE_MAX_RESULTS,
            orgId: scope.orgId,
            teamId: scope.teamId,
          }
        );
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.name : 'unknown', repoId },
          'run plan router failed'
        );
        return sendError(
          reply,
          503,
          'RUN_PLAN_ROUTER_UNAVAILABLE',
          'Templates could not be ranked right now; you can still generate a new plan'
        );
      }
      // Only ids the caller was offered survive, whatever the router said.
      const matches = (ranked.matches ?? [])
        .filter((m) => byId.has(m.templateId))
        .slice(0, ROUTE_MAX_RESULTS)
        .map((m) => {
          const t = byId.get(m.templateId) as NonNullable<ReturnType<typeof byId.get>>;
          return {
            description: t.description,
            name: t.name,
            reason: m.reason,
            score: m.score,
            templateId: t.id,
          };
        });
      return { data: { matches, noneFit: matches.length === 0 || ranked.noneFit === true } };
    }
  );

  // ── Start generating a plan (async job) ──
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: CreateBody, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { agent, intent, repoId } = request.body;
      const idempotencyKey = request.headers['idempotency-key'];

      // Repository reach, GitHub permission, org membership and cap, host allowlist: the launch
      // decision, the same function the plan service re-runs at creation and approval.
      const repo = await authorizeRepository(deps(request), { sub: user.sub }, repoId);
      if (!repo.ok) {
        return sendRefusal(reply, repo);
      }
      const scope = { orgId: repo.repo.orgId, teamId: repo.repo.teamId };

      // The agents the plan may name: the agent-run rules, computed here and never taken from
      // the client. A library-agent plan must be built on one of them.
      const agentKeys = await launchableAgentKeys(fastify.prisma, scope.orgId);
      if (agent !== undefined) {
        if (!isLaunchableAgentKey(agent)) {
          return sendError(
            reply,
            400,
            'AGENT_NOT_LAUNCHABLE',
            `Agent '${agent}' backs a platform mechanism and cannot be launched`
          );
        }
        if (!agentKeys.includes(agent)) {
          return sendError(
            reply,
            404,
            'AGENT_NOT_FOUND',
            `No active agent '${agent}' at global or organization scope`
          );
        }
      }
      const mode: RunPlanMode = agent ? 'output-only' : 'delivering';
      const hash = intentHash(repoId, agent, intent);

      const jobId = idempotencyKey
        ? workflowIdFromIdempotencyKey('runplan', user8Of(user.sub), idempotencyKey)
        : runPlanGenerationWorkflowId(
            `${user8Of(user.sub)}-${crypto.randomUUID().replace(/-/g, '')}`
          );
      const replay = (state: RunPlanJobState) => {
        const memo = MemoSchema.safeParse('memo' in state ? state.memo : {});
        // Another person's job under a colliding id is not described to this caller.
        if (!memo.success || memo.data.ownerUserId !== user.sub) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_KEY_CONFLICT',
            'This Idempotency-Key cannot be used; send a new one'
          );
        }
        if (memo.data.intentHash !== hash) {
          return sendError(
            reply,
            422,
            'IDEMPOTENCY_KEY_MISMATCH',
            'This Idempotency-Key was already used for a different request. Use a new key for a different goal.'
          );
        }
        return reply.status(202).send({ data: { deduplicated: true, jobId } });
      };
      if (idempotencyKey) {
        const existing = await fastify.temporal.getRunPlanJob(jobId);
        if (existing.status !== 'not_found') {
          return replay(existing);
        }
      }

      const planId = planIdForJob(user.sub, jobId);
      const refused = await reserveGenerationSlot(fastify, {
        jobId,
        mode,
        planId,
        repoId,
        scope,
        user,
      });
      if (refused) {
        return sendRefusal(reply, refused);
      }
      try {
        const { started } = await fastify.temporal.startRunPlanGeneration(
          jobId,
          {
            ...(agent ? { agentKey: agent } : {}),
            intent,
            launchableAgentKeys: agentKeys,
            mode,
            orgId: scope.orgId,
            teamId: scope.teamId,
          },
          { intentHash: hash, mode, ownerUserId: user.sub, repoId, teamId: scope.teamId }
        );
        if (!started) {
          // A retry that raced its own first request: nothing new started, so nothing was spent.
          await releaseGenerationSlot(fastify, { planId, userId: user.sub });
          return replay(await fastify.temporal.getRunPlanJob(jobId));
        }
      } catch (err) {
        await releaseGenerationSlot(fastify, { planId, userId: user.sub });
        throw err;
      }
      return reply.status(202).send({ data: { jobId } });
    }
  );

  // ── Poll a generation job; a finished one becomes a plan, once ──
  app.get(
    '/jobs/:jobId',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: JobParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { jobId } = request.params;
      const notFound = () =>
        sendError(reply, 404, 'RUN_PLAN_JOB_NOT_FOUND', 'Generation job not found');
      const state = await fastify.temporal.getRunPlanJob(jobId);
      if (state.status === 'not_found') {
        return notFound();
      }
      // The memo, not the id, says whose job this is. A job that is not this person's is
      // answered exactly as one that does not exist.
      const memo = MemoSchema.safeParse(state.memo);
      if (!memo.success || memo.data.ownerUserId !== user.sub) {
        return notFound();
      }
      if (state.status === 'running') {
        return { data: { status: 'running' } };
      }
      const failed = (code: string, message: string, retryable: boolean) => ({
        data: { code, message, retryable, status: 'failed' },
      });
      if (state.status === 'failed') {
        const f = JOB_FAILURES[state.code] ?? (JOB_FAILURES.GENERATION_UNAVAILABLE as never);
        return failed(f.code, f.message, f.retryable);
      }

      // Done. The plan id is a function of the job, so a repeated poll finds the row it made.
      const planId = planIdForJob(user.sub, jobId);
      const done = { data: { planId, status: 'done' } };
      const existing = await fastify.prisma.runPlan.findUnique({
        select: { id: true, ownerUserId: true },
        where: { id: planId },
      });
      if (existing) {
        return existing.ownerUserId === user.sub ? done : notFound();
      }
      if (state.closedAt && Date.now() - state.closedAt.getTime() > JOB_PERSIST_WINDOW_MS) {
        return failed(
          'PLAN_JOB_EXPIRED',
          'This generation finished long ago; start a new one',
          false
        );
      }

      const template = await loadPlannedRunTemplate({ prisma: fastify.prisma });
      if (!template?.activeVersion) {
        const f = JOB_FAILURES.PLANNED_RUN_TEMPLATE_MISSING as NonNullable<
          (typeof JOB_FAILURES)[string]
        >;
        return failed(f.code, f.message, f.retryable);
      }
      const { input, result } = state;
      const created = await (async () => {
        try {
          return await createPlanRecord(deps(request), {
            agentKey: input.agentKey ?? null,
            agentPins: result.agentPins,
            catalogHash: result.catalogHash,
            connectionId: memo.data.repoId,
            costEstimate: result.costEstimate,
            id: planId,
            intent: input.intent,
            mode: memo.data.mode,
            model: result.model,
            owner: { sub: user.sub },
            // What the platform added around the model's nodes, for the preview's markers.
            routerCandidates: { injected: result.injected },
            settingsSnapshot: await snapshotPlanSettings({
              orgId: input.orgId ?? null,
              plannedRunTemplateId: template.id,
              teamId: input.teamId,
            }),
            spec: result.spec,
          });
        } catch (err) {
          // Two polls raced and the other one won: the row exists, and it is this person's.
          if ((err as { code?: unknown } | null)?.code === 'P2002') {
            return 'raced' as const;
          }
          throw err;
        }
      })();
      if (created === 'raced') {
        return done;
      }
      if (!created.ok) {
        return failed(
          created.code,
          created.message,
          created.status === 429 || created.status >= 500
        );
      }
      await audit({
        action: 'CREATE',
        actor: user,
        after: {
          agentKey: input.agentKey ?? null,
          connectionId: memo.data.repoId,
          event: 'run_plan.created',
          mode: memo.data.mode,
          teamId: memo.data.teamId,
        },
        entityId: created.planId,
        entityType: 'RunPlan',
      });
      return done;
    }
  );

  // ── Own plans ──
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListQuery },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { limit, offset, status } = request.query;
      const where = { ownerUserId: user.sub, ...(status ? { status } : {}) };
      const [rows, total] = await runUnscoped(
        'a person lists their own plans across the teams they plan for',
        ['RunPlan'],
        () =>
          Promise.all([
            fastify.prisma.runPlan.findMany({
              // `id` breaks ties so an offset page boundary inside one creation instant is stable.
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                agentKey: true,
                connectionId: true,
                costEstimate: true,
                createdAt: true,
                expiresAt: true,
                id: true,
                intent: true,
                mode: true,
                status: true,
                teamId: true,
              },
              skip: offset,
              take: limit,
              where,
            }),
            fastify.prisma.runPlan.count({ where }),
          ])
      );
      return {
        data: rows.map((r) => ({
          agentKey: r.agentKey,
          connectionId: r.connectionId,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          id: r.id,
          // The list shows a headline, not the whole text; `GET /:id` has all of it.
          intent: r.intent.length > 200 ? `${r.intent.slice(0, 200)}…` : r.intent,
          mode: r.mode,
          status: r.status,
          teamId: r.teamId,
          totalUsd: asRecord(r.costEstimate).totalUsd ?? null,
        })),
        meta: { limit, offset, total },
      };
    }
  );

  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const plan = await fastify.prisma.runPlan.findUnique({ where: { id: request.params.id } });
      if (!plan || plan.ownerUserId !== user.sub) {
        return sendError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found');
      }
      return { data: planView(plan) };
    }
  );

  // ── Approve: re-check everything, then start the run ──
  app.post(
    '/:id/approve',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: ApproveBody, headers: IdempotencyHeaderSchema, params: IdParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { id } = request.params;
      const result = await approveAndLaunchPlan(
        { ...deps(request), temporal: fastify.temporal },
        { sub: user.sub },
        id,
        request.body?.budgetTier ? { budgetTier: request.body.budgetTier } : {}
      );
      if (!result.ok) {
        // A retried approve (same key) of a plan that did launch answers with that launch.
        if (
          request.headers['idempotency-key'] &&
          (result.code === 'PLAN_NOT_PENDING' || result.code === 'PLAN_NOT_APPROVED')
        ) {
          const launched = await fastify.prisma.runInput.findFirst({
            orderBy: { createdAt: 'desc' },
            select: { id: true },
            where: { externalTicketId: plannedRunTicketId(id), requestedById: user.sub },
          });
          if (launched) {
            return { data: { deduplicated: true, planId: id, workRequestId: launched.id } };
          }
        }
        if (POLICY_CODES.has(result.code)) {
          return sendError(reply, 422, result.code, result.message);
        }
        const drift = DRIFT_KINDS[result.code];
        return sendRefusal(reply, result, drift ? { drift } : undefined);
      }
      await audit({
        action: 'UPDATE',
        actor: user,
        after: {
          event: 'run_plan.approved',
          status: 'APPROVED',
          temporalWorkflowId: result.temporalWorkflowId,
          workRequestId: result.workRequestId,
        },
        before: { status: 'PENDING' },
        entityId: id,
        entityType: 'RunPlan',
      });
      return reply.status(201).send({
        data: {
          planId: id,
          temporalWorkflowId: result.temporalWorkflowId,
          workflowId: result.activeWorkflowId,
          workRequestId: result.workRequestId,
        },
      });
    }
  );

  app.post(
    '/:id/reject',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: IdParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { id } = request.params;
      const result = await rejectPlan(deps(request), { sub: user.sub }, id);
      if (!result.ok) {
        return sendRefusal(reply, result);
      }
      await audit({
        action: 'UPDATE',
        actor: user,
        after: { event: 'run_plan.rejected', status: 'REJECTED' },
        before: { status: 'PENDING_OR_APPROVED' },
        entityId: id,
        entityType: 'RunPlan',
      });
      return { data: { planId: id, status: 'REJECTED' } };
    }
  );
};
