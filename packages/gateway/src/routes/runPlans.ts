import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { handLaunchBlock } from '@auto-swe/shared/lib/channelTask';
import { PLANNED_RUN_TEMPLATE_NAME, plannedRunTicketId } from '@auto-swe/shared/lib/plannedRun';
import { runPlanRouteWorkflowId } from '@auto-swe/shared/lib/runPlanWorkflows';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { BUDGET_TIERS } from '@auto-swe/shared/types/workflow';
import { RUN_PLAN_INTENT_MAX_CHARS, runPlanIntentIssue } from '@auto-swe/shared/workflow/runPlan';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema } from '../lib/idempotency.js';
import { paginationQuery } from '../lib/pagination.js';
import { describeNode, type NodeDetail, nodesFeedingImplementer } from '../lib/runPlanNodeView.js';
import { createRunPlanQuotaPolicy, reserveRouteSlot } from '../lib/runPlanQuotas.js';
import {
  approveAndLaunchPlan,
  authorizeRepository,
  cleanPlanSummary,
  cleanSpecDisplayText,
  createPlanRecord,
  loadPlannedRunTemplate,
  type PlanRefusal,
  rejectPlan,
  requireActivePlanUser,
  snapshotPlanSettings,
} from '../lib/runPlanService.js';
import { planIdForJob, RunPlanMemoSchema, startRunPlan, user8Of } from '../lib/runPlanStart.js';
import { planSaveBlock, saveRunPlanAsTemplate } from '../lib/runPlanTemplate.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../lib/systemTemplate.js';
import { teamMembershipFilter } from '../lib/templateLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

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

/**
 * The goal as typed, trimmed. Over 8000 characters, empty, or carrying the delimiter the author
 * model is shown it in, it is refused here (and again in the worker and when the plan is stored),
 * never cut: the plan stores exactly the text the author saw.
 */
const Intent = z
  .string()
  .trim()
  .min(1)
  .max(RUN_PLAN_INTENT_MAX_CHARS)
  .superRefine((value, ctx) => {
    const issue = runPlanIntentIssue(value);
    if (issue) {
      ctx.addIssue({ code: 'custom', message: issue });
    }
  });

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
/** `teamId` is deliberately absent: the template always lands in the plan's own team. */
const SaveAsTemplateBody = z.object({ name: z.string().min(1).max(120).optional() }).strict();
const ApproveBody = z
  .object({ budgetTier: z.enum(BUDGET_TIERS).optional() })
  .strict()
  .nullish();

/** What an approval's audit row records of the Idempotency-Key: a digest, never the key. */
function keyDigest(key: string): string {
  return crypto.createHash('sha256').update(`run-plan-approve\n${key}`).digest('hex');
}

/** Run states that mean the launch did not end in a running or finished run. */
const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'FAILED', 'TIMED_OUT']);

/** The refusal statuses the approval path reports, by kind. */
const POLICY_CODES: ReadonlySet<string> = new Set([
  'PLAN_AGENT_MISMATCH',
  'PLAN_POLICY_FAILED',
  'PLAN_SPEC_INVALID',
  'PLAN_SPEC_TOO_DEEP',
  'PLAN_SPEC_TOO_LARGE',
]);
const DRIFT_KINDS: Readonly<Record<string, string>> = {
  PLAN_AGENT_NOT_LAUNCHABLE: 'agents',
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
}): Array<
  {
    id: string;
    type: string | null;
    step: string | null;
    marker: string;
    region: string;
  } & NodeDetail
> {
  const nodes = asRecord(asRecord(plan.spec).nodes);
  const report = asRecord(plan.skeletonReport);
  const regions = asRecord(report.regions);
  const core = new Set(asStrings(regions.core));
  const pre = new Set(asStrings(regions.pre));
  const post = new Set(asStrings(regions.post));
  const mandatory = new Set(Object.values(asRecord(report.mandatory)).flatMap(asStrings));
  const injected = new Set(asStrings(asRecord(plan.routerCandidates).injected));
  const feeding = nodesFeedingImplementer(nodes, core);
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
      ...describeNode(raw, feeding.has(id)),
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

/**
 * The whole plan, for its owner. The spec is here and only here. A scrubbed plan (its goal and
 * body removed after `runPlans.launchedRetentionDays`) answers with its metadata and no text:
 * `intent` is empty, `nodes` is empty and `spec` is null. Nothing is read out of the stored
 * columns for it, so a row scrubbed only in part could never leak what is left.
 */
function planView(plan: PlanRow) {
  if (plan.scrubbedAt) {
    return {
      agentKey: plan.agentKey,
      agentPins: plan.agentPins,
      approvedAt: plan.approvedAt?.toISOString() ?? null,
      connectionId: plan.connectionId,
      cost: plan.costEstimate,
      createdAt: plan.createdAt.toISOString(),
      expiresAt: plan.expiresAt.toISOString(),
      id: plan.id,
      intent: '',
      launchedWorkflowRunId: plan.launchedWorkflowRunId,
      mode: plan.mode,
      model: plan.model,
      nodes: [] as ReturnType<typeof markNodes>,
      scrubbed: true,
      scrubbedAt: plan.scrubbedAt.toISOString(),
      spec: null,
      specHash: null,
      status: plan.status,
      summary: null,
      teamId: plan.teamId,
      warnings: [] as ReturnType<typeof warningsOf>,
    };
  }
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
    scrubbed: false,
    scrubbedAt: null,
    spec: cleanSpecDisplayText(plan.spec),
    specHash: plan.specHash,
    status: plan.status,
    summary: cleanPlanSummary(asRecord(plan.routerCandidates).summary),
    teamId: plan.teamId,
    warnings: warningsOf(plan),
  };
}

export { planIdForJob };

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

  /**
   * The role is read from the database, not trusted from the token: a person demoted or deactivated
   * since it was issued must not be able to start a paid model call with it.
   */
  async function refuseNonEngineer(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string
  ): Promise<boolean> {
    const engineer = await requireActivePlanUser(deps(request), { sub: userId });
    if (!engineer.ok) {
      sendRefusal(reply, engineer);
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
      onRequest: requireAuth(),
      schema: { body: RouteBody },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      if (await refuseNonEngineer(request, reply, user.sub)) {
        return reply;
      }
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
      onRequest: requireAuth(),
      schema: { body: CreateBody, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      // The same function the Slack "Generate plan" button calls: one set of checks, quotas and
      // idempotency rules for both.
      const started = await startRunPlan(
        fastify,
        { gate: request.repoAccessGate, log: request.log },
        {
          agent: request.body.agent,
          idempotencyKey: request.headers['idempotency-key'],
          intent: request.body.intent,
          repoId: request.body.repoId,
          user,
        }
      );
      if (!started.ok) {
        return sendRefusal(reply, started);
      }
      return reply.status(202).send({
        data: started.deduplicated
          ? { deduplicated: true, jobId: started.jobId }
          : { jobId: started.jobId },
      });
    }
  );

  // ── Poll a generation job; a finished one becomes a plan, once ──
  app.get(
    '/jobs/:jobId',
    {
      onRequest: requireAuth(),
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
      const memo = RunPlanMemoSchema.safeParse(state.memo);
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
      // The poll persists a plan on the owner's behalf; it only ever acts on the owner's own job.
      const existing = await fastify.prisma.runPlan.findUnique({
        select: {
          connectionId: true,
          id: true,
          mode: true,
          ownerUserId: true,
          routerCandidates: true,
        },
        where: { id: planId },
      });
      if (existing) {
        if (existing.ownerUserId !== user.sub) {
          return notFound();
        }
        // The plan id is a function of the job id, which an Idempotency-Key fixes. A job that ran
        // again under a reused key (its history was purged) must not report an older plan made for
        // another goal, repository or mode as its own result.
        const storedHash = asRecord(existing.routerCandidates).intentHash;
        if (
          (typeof storedHash === 'string' && storedHash !== memo.data.intentHash) ||
          existing.connectionId !== memo.data.repoId ||
          existing.mode !== memo.data.mode
        ) {
          return failed(
            'PLAN_KEY_REUSED',
            'This Idempotency-Key already produced a different plan; start a new generation with a new key',
            false
          );
        }
        return done;
      }
      // A finished job with no close time is treated as one that closed too long ago: the window
      // cannot be skipped by a missing field.
      if (!state.closedAt || Date.now() - state.closedAt.getTime() > JOB_PERSIST_WINDOW_MS) {
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
            id: planId,
            intent: input.intent,
            mode: memo.data.mode,
            model: result.model,
            owner: { sub: user.sub },
            // What the platform added around the model's nodes, for the preview's markers.
            routerCandidates: { injected: result.injected, intentHash: memo.data.intentHash },
            settingsSnapshot: await snapshotPlanSettings({
              orgId: input.orgId ?? null,
              plannedRunTemplateId: template.id,
              teamId: input.teamId,
            }),
            spec: result.spec,
            summary: result.summary,
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
      onRequest: requireAuth(),
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
                scrubbedAt: true,
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
          // The list shows a headline, not the whole text; `GET /:id` has all of it. A scrubbed
          // plan has none: its goal was removed, and the row is not read for text.
          intent: r.scrubbedAt
            ? ''
            : r.intent.length > 200
              ? `${r.intent.slice(0, 200)}…`
              : r.intent,
          mode: r.mode,
          scrubbed: Boolean(r.scrubbedAt),
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
      onRequest: requireAuth(),
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

  /**
   * Whether this person's latest approval of this plan was made with the Idempotency-Key of this
   * digest. An approval that was reverted (its launch failed) no longer counts.
   */
  async function approvedWithKey(planId: string, userId: string, digest: string): Promise<boolean> {
    const rows = await fastify.prisma.configAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      select: { afterJson: true },
      take: 1,
      where: {
        action: 'UPDATE',
        actorId: userId,
        entityId: planId,
        entityType: 'RunPlan',
        OR: [
          { afterJson: { equals: 'run_plan.approved', path: ['event'] } },
          { afterJson: { equals: 'run_plan.approval_reverted', path: ['event'] } },
        ],
      },
    });
    const latest = asRecord(rows[0]?.afterJson);
    return latest.event === 'run_plan.approved' && latest.idempotencyKeyDigest === digest;
  }

  /**
   * Where an approved plan's run stands now. `running`: the plan is launched, or a run row exists
   * that has not failed. `starting`: input and workflow rows exist but the plan is still approved
   * with no run recorded, so the launch can still roll back (it deletes those rows and returns the
   * plan to pending) and nothing may be answered as a success yet. `failed`: a run row exists and
   * ended badly. `none`: the plan has no run to speak of.
   */
  async function launchState(
    planId: string,
    userId: string
  ): Promise<
    | { kind: 'none' }
    | { kind: 'running'; workRequestId: string }
    | { kind: 'starting' }
    | { kind: 'failed'; details: Record<string, unknown> }
  > {
    const plan = await fastify.prisma.runPlan.findUnique({
      select: { launchedWorkflowRunId: true, status: true },
      where: { id: planId },
    });
    if (!plan || (plan.status !== 'LAUNCHED' && plan.status !== 'APPROVED')) {
      return { kind: 'none' };
    }
    const input = await fastify.prisma.runInput.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      where: { externalTicketId: plannedRunTicketId(planId), requestedById: userId },
    });
    if (!input) {
      return { kind: 'none' };
    }
    const [active, run] = await Promise.all([
      fastify.prisma.activeWorkflow.findFirst({
        select: { currentStatus: true },
        where: { workRequestId: input.id },
      }),
      plan.launchedWorkflowRunId
        ? fastify.prisma.workflowRun.findUnique({
            select: { status: true },
            where: { id: plan.launchedWorkflowRunId },
          })
        : Promise.resolve(null),
    ]);
    if (!active && !run) {
      return { kind: 'none' };
    }
    const failed =
      active?.currentStatus === 'FAILED' || (run ? FAILED_RUN_STATUSES.has(run.status) : false);
    if (!failed && !run && plan.status !== 'LAUNCHED') {
      return { kind: 'starting' };
    }
    return failed
      ? {
          details: {
            planStatus: plan.status,
            runStatus: run?.status ?? null,
            workflowStatus: active?.currentStatus ?? null,
            workRequestId: input.id,
          },
          kind: 'failed',
        }
      : { kind: 'running', workRequestId: input.id };
  }

  // ── Approve: re-check everything, then start the run ──
  app.post(
    '/:id/approve',
    {
      onRequest: requireAuth(),
      schema: { body: ApproveBody, headers: IdempotencyHeaderSchema, params: IdParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { id } = request.params;
      const idempotencyKey = request.headers['idempotency-key'];
      const digest = idempotencyKey ? keyDigest(idempotencyKey) : undefined;
      const result = await approveAndLaunchPlan(
        { ...deps(request), temporal: fastify.temporal },
        { sub: user.sub },
        id,
        {
          ...(request.body?.budgetTier ? { budgetTier: request.body.budgetTier } : {}),
          // The approval and its key digest are on record BEFORE the run starts, so a retry that
          // arrives while the launch is in flight (or after a lost response) recognises its own
          // approval. This write is not best effort: if it fails nothing is started and the
          // approval is reverted.
          afterRevert: async () => {
            await audit({
              action: 'UPDATE',
              actor: user,
              after: { event: 'run_plan.approval_reverted', status: 'PENDING' },
              before: { status: 'APPROVED' },
              entityId: id,
              entityType: 'RunPlan',
            });
          },
          beforeLaunch: async () => {
            await writeAuditLog(fastify, {
              action: 'UPDATE',
              actor: user,
              after: {
                event: 'run_plan.approved',
                // So a retry can be told apart from a different request: the digest, never the key.
                ...(digest ? { idempotencyKeyDigest: digest } : {}),
                status: 'APPROVED',
              },
              before: { status: 'PENDING' },
              entityId: id,
              entityType: 'RunPlan',
            });
          },
        }
      );
      if (!result.ok) {
        // A retried approve answers with the earlier launch only when THIS key made that approval
        // and its run is still going or finished; a run that was refused or failed is reported as
        // what it is, never as success.
        if (
          digest &&
          (result.code === 'PLAN_NOT_PENDING' || result.code === 'PLAN_NOT_APPROVED') &&
          (await approvedWithKey(id, user.sub, digest))
        ) {
          const launch = await launchState(id, user.sub);
          if (launch.kind === 'running') {
            return {
              data: { deduplicated: true, planId: id, workRequestId: launch.workRequestId },
            };
          }
          if (launch.kind === 'starting') {
            return sendError(
              reply,
              409,
              'PLAN_LAUNCH_IN_PROGRESS',
              'This approval is still starting its run; check again shortly'
            );
          }
          if (launch.kind === 'failed') {
            return sendError(
              reply,
              409,
              'PLAN_LAUNCH_FAILED',
              'This approval started a run that did not succeed; create a new plan to try again',
              launch.details
            );
          }
          // The approval is on record and no run exists yet: the first request is still starting it.
          const current = await fastify.prisma.runPlan.findUnique({
            select: { status: true },
            where: { id },
          });
          if (current?.status === 'APPROVED') {
            return sendError(
              reply,
              409,
              'PLAN_LAUNCH_IN_PROGRESS',
              'This approval is still starting its run; check again shortly'
            );
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
          event: 'run_plan.launched',
          status: 'LAUNCHED',
          temporalWorkflowId: result.temporalWorkflowId,
          workRequestId: result.workRequestId,
        },
        before: { status: 'APPROVED' },
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
      onRequest: requireAuth(),
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
        before: { status: 'PENDING' },
        entityId: id,
        entityType: 'RunPlan',
      });
      return { data: { planId: id, status: 'REJECTED' } };
    }
  );

  // ── Save a plan as a workflow template ──
  // POST /:id/save-as-template { name? } → 201 { data: { templateId, name, version, status } }
  // The plan's stored spec becomes a DRAFT template in the plan's own team, through the persistence
  // helper `POST /workflow-templates/generate` uses, marked generated by the plan's owner so the
  // review rule (a version someone generated needs a review by someone else before it can be
  // promoted or activated) applies unchanged. Owner only (any other caller gets the plan 404); the
  // caller needs the template-authoring role of the plan's team (LEAD or ADMIN of it, or a platform
  // ADMIN). A scrubbed plan has no spec (409 PLAN_SCRUBBED); a rejected or expired one is refused
  // (409 PLAN_NOT_SAVEABLE). A name already taken in the team answers 409 NAME_CONFLICT and is never
  // changed for the caller, so saving one plan twice under one name fails the second time.
  app.post(
    '/:id/save-as-template',
    {
      onRequest: requireAuth(),
      schema: { body: SaveAsTemplateBody, params: IdParam },
    },
    async (request, reply) => {
      if (refuseServicePrincipal(request, reply)) {
        return reply;
      }
      const user = requireUser(request);
      const { id } = request.params;
      const plan = await fastify.prisma.runPlan.findUnique({ where: { id } });
      if (!plan || plan.ownerUserId !== user.sub) {
        return sendError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found');
      }
      const blocked = planSaveBlock(plan);
      if (blocked) {
        return sendRefusal(reply, blocked);
      }
      const saved = await saveRunPlanAsTemplate(
        fastify,
        user,
        { id: plan.id, mode: plan.mode, spec: plan.spec, teamId: plan.teamId },
        request.body.name
      );
      if (!saved.ok) {
        if (saved.body !== undefined) {
          return reply.status(saved.status).send(saved.body);
        }
        return sendRefusal(reply, saved);
      }
      await audit({
        action: 'CREATE',
        actor: user,
        after: {
          event: 'run_plan.saved_as_template',
          teamId: saved.teamId,
          templateId: saved.templateId,
        },
        entityId: id,
        entityType: 'RunPlan',
      });
      return reply.status(201).send({
        data: {
          name: saved.name,
          status: saved.status,
          templateId: saved.templateId,
          version: saved.version,
        },
        ...(saved.warnings.length > 0 ? { warnings: saved.warnings } : {}),
      });
    }
  );
};
