/**
 * Eval admin routes (docs/evals.md §6).
 *
 * CRUD for frozen-benchmark datasets/cases and a paginated results-query
 * endpoint (the read path the `/admin/evals` dashboard uses). Admin-only,
 * mirroring the agent-library + security-events route patterns. This file also
 * starts an offline harness run (a Temporal workflow) and owns the datasets,
 * cases, and result/run reads.
 */

import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { evalScreenWorkflowId } from '@auto-swe/shared/lib/workflowId';
import {
  EVAL_SIGNAL_SOURCES,
  type EvalCaseDto,
  type EvalDatasetDetail,
  type EvalDatasetSummary,
  type EvalRescreenResultDto,
  type EvalResultDto,
  type EvalRubricDto,
  type EvalRunDto,
  type EvalScorerTrend,
  type EvalSuiteHealthDto,
  type EvalTrendsDto,
  IMPLEMENTER_RUNTIMES,
  toImplementerRuntime,
} from '@auto-swe/shared/types/api';
import { FLAKE_SCREEN_MAX_INFRA_ERRORS } from '@auto-swe/shared/types/workflow';
import { EVAL_SCORER_ERROR_PREFIX } from '@auto-swe/shared/workflow';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  customRangeFields,
  refineCustomRange,
  resolveCustomRange,
  seriesBuckets,
  utcDayStart,
} from '../lib/dateWindow.js';
import { sendError } from '../lib/httpErrors.js';
import { mapLimited } from '../lib/mapLimited.js';
import { recordRunFinalized } from '../lib/metrics.js';
import { paginationQuery } from '../lib/pagination.js';
import { scanSkillAdvisory } from '../lib/skillScan.js';
import {
  isTemporalUnavailable,
  sendTemporalUnavailable,
  temporalConnected,
} from '../lib/temporalErrors.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { projectEvalResult } from './workflowProjections.js';

const IdParam = z.object({ id: z.string().uuid() });
const CaseParams = z.object({ caseId: z.string().uuid(), id: z.string().uuid() });

/** What a re-screen answers 404 with, by code. */
const RESCREEN_NOT_FOUND = {
  CASE_NOT_FOUND: 'Eval case not found in this dataset',
  DATASET_NOT_FOUND: 'Eval dataset not found',
} as const;

const CreateRubricBody = z.object({
  promptText: z.string().min(1).max(50_000),
  scale: z.string().max(40).default('0..1'),
  scope: z.enum(['GLOBAL', 'ORGANIZATION', 'TEAM', 'WORKFLOW_TEMPLATE']).default('GLOBAL'),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
});

function toRubricDto(r: {
  id: string;
  slug: string;
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'CHANNEL' | 'WORKFLOW_TEMPLATE';
  version: number;
  promptText: string;
  scale: string;
  isBuiltIn: boolean;
  createdAt: Date;
}): EvalRubricDto {
  return {
    createdAt: r.createdAt.toISOString(),
    id: r.id,
    isBuiltIn: r.isBuiltIn,
    promptText: r.promptText,
    scale: r.scale,
    scope: r.scope,
    slug: r.slug,
    version: r.version,
  };
}

const CaseInput = z.object({
  baselineSha: z.string().min(1).max(200),
  goldenTest: z.string().min(1).max(4000),
  input: z.unknown(),
  reference: z.unknown().optional(),
  repoUrl: z.string().min(1).max(2000),
  tags: z.array(z.string().max(100)).max(50).optional(),
});

const CreateDatasetBody = z.object({
  cases: z.array(CaseInput).max(10_000).optional(),
  description: z.string().max(2000).nullable().optional(),
  name: z.string().min(1).max(200),
  scope: z.enum(['GLOBAL', 'ORGANIZATION', 'TEAM', 'WORKFLOW_TEMPLATE']).default('GLOBAL'),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
});

const StartRunBody = z.object({
  baselineRef: z.string().min(1).max(200),
  /**
   * Per-side implementer runtime override. Omitted or null, that side runs on
   * what its agent resolves to in the dataset's scope: the Agent's own
   * `runtime`, else `workspace.implementerRuntime`.
   */
  baselineRuntime: z.enum(IMPLEMENTER_RUNTIMES).nullable().optional(),
  candidateRef: z.string().min(1).max(200),
  candidateRuntime: z.enum(IMPLEMENTER_RUNTIMES).nullable().optional(),
  datasetId: z.string().uuid(),
});

const ResultsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend({
  evalRunId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  scorer: z.string().max(200).optional(),
  source: z.enum(EVAL_SIGNAL_SOURCES).optional(),
});

const RunsQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  datasetId: z.string().uuid().optional(),
});

const TREND_WINDOWS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-day aggregates in flight at once — see `mapLimited`. */
const TREND_CONCURRENCY = 3;
const TrendsQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
    /** Split each scorer's series by this column of the result rows. */
    by: z.enum(['judgeModel', 'agentKey', 'runtime']).optional(),
    source: z.enum(EVAL_SIGNAL_SOURCES).optional(),
    /** Only results of runs of this workflow template (offline harness rows have no run). */
    templateId: z.string().uuid().optional(),
    window: z.coerce
      .number()
      .int()
      .refine((n) => (TREND_WINDOWS as readonly number[]).includes(n), {
        message: `window must be one of ${TREND_WINDOWS.join(', ')}`,
      })
      .default(30),
  })
);

/**
 * Case ids suite health lists per dataset and kind, oldest first. A dataset holds
 * up to 10,000 cases, every one unscreened right after it is created; the counts
 * beside the lists are the totals.
 */
const SUITE_HEALTH_CASE_IDS = 50;

/** Did the harness record `summary.partial` — a verdict over only some of the cases? */
function hasPartialVerdict(summary: unknown): boolean {
  return (
    typeof summary === 'object' &&
    summary !== null &&
    (summary as { partial?: unknown }).partial != null
  );
}

function toRunDto(run: {
  dataset?: { name: string; slug: string } | null;
  id: string;
  datasetId: string;
  candidateRef: string;
  baselineRef: string;
  candidateRuntime: string | null;
  baselineRuntime: string | null;
  status: string;
  summary: unknown;
  startedAt: Date;
  endedAt: Date | null;
}): EvalRunDto {
  return {
    baselineRef: run.baselineRef,
    baselineRuntime: toImplementerRuntime(run.baselineRuntime),
    candidateRef: run.candidateRef,
    candidateRuntime: toImplementerRuntime(run.candidateRuntime),
    datasetId: run.datasetId,
    ...(run.dataset ? { datasetName: run.dataset.name, datasetSlug: run.dataset.slug } : {}),
    endedAt: run.endedAt?.toISOString() ?? null,
    id: run.id,
    partial: hasPartialVerdict(run.summary),
    startedAt: run.startedAt.toISOString(),
    status: run.status,
    summary: run.summary,
  };
}

function toCaseDto(c: {
  id: string;
  datasetId: string;
  input: unknown;
  repoUrl: string;
  baselineSha: string;
  goldenTest: string;
  reference: unknown;
  tags: string[];
  flakeScreened: boolean;
  flakeRuns: number;
  flakeScreenInfraErrors: number;
  createdAt: Date;
}): EvalCaseDto {
  return {
    baselineSha: c.baselineSha,
    createdAt: c.createdAt.toISOString(),
    datasetId: c.datasetId,
    flakeRuns: c.flakeRuns,
    flakeScreened: c.flakeScreened,
    goldenTest: c.goldenTest,
    id: c.id,
    input: c.input,
    reference: c.reference,
    repoUrl: c.repoUrl,
    screenEnvironmentFailed:
      !c.flakeScreened &&
      c.flakeRuns > 0 &&
      c.flakeScreenInfraErrors >= FLAKE_SCREEN_MAX_INFRA_ERRORS,
    tags: c.tags,
  };
}

export const evalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // ── List datasets ──
  app.get('/evals', { onRequest: adminOnly }, async () => {
    const rows = await runUnscoped('admin dataset listing spans every team', ['EvalDataset'], () =>
      fastify.prisma.evalDataset.findMany({
        include: { _count: { select: { cases: true } } },
        orderBy: { createdAt: 'desc' },
      })
    );
    const data: EvalDatasetSummary[] = rows.map((r) => ({
      caseCount: r._count.cases,
      createdAt: r.createdAt.toISOString(),
      description: r.description,
      id: r.id,
      name: r.name,
      scope: r.scope,
      slug: r.slug,
    }));
    return { data };
  });

  // ── Create a dataset (+ optional cases) ──
  app.post(
    '/evals',
    { onRequest: adminOnly, schema: { body: CreateDatasetBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { cases, description, name, scope, slug } = request.body;
      const dataset = await fastify.prisma.evalDataset.create({
        data: {
          description: description ?? null,
          name,
          scope,
          slug,
          ...(cases && cases.length > 0
            ? {
                cases: {
                  create: cases.map((c) => ({
                    baselineSha: c.baselineSha,
                    goldenTest: c.goldenTest,
                    input: (c.input ?? {}) as object,
                    reference: (c.reference ?? undefined) as object | undefined,
                    repoUrl: c.repoUrl,
                    tags: c.tags ?? [],
                  })),
                },
              }
            : {}),
        },
        include: { _count: { select: { cases: true } } },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { name: dataset.name, scope: dataset.scope, slug: dataset.slug },
        entityId: dataset.id,
        entityType: 'EvalDataset',
      });
      // New cases start unscreened, and the harness scores only screened cases.
      // Best-effort: a case this start misses is screened when an eval run of
      // the dataset finds it unscreened, or by the re-validation sweep, so a
      // Temporal outage never fails the create.
      if (dataset._count.cases > 0) {
        try {
          await fastify.temporal.startEvalScreenWorkflow(evalScreenWorkflowId(dataset.id), {
            datasetId: dataset.id,
          });
        } catch (err) {
          request.log.error({ datasetId: dataset.id, err }, 'failed to start EvalScreenWorkflow');
        }
      }
      const data: EvalDatasetSummary = {
        caseCount: dataset._count.cases,
        createdAt: dataset.createdAt.toISOString(),
        description: dataset.description,
        id: dataset.id,
        name: dataset.name,
        scope: dataset.scope,
        slug: dataset.slug,
      };
      return reply.status(201).send({ data });
    }
  );

  // ── Dataset detail (with cases) ──
  app.get(
    '/evals/:id',
    { onRequest: adminOnly, schema: { params: IdParam } },
    async (request, reply) => {
      const ds = await fastify.prisma.evalDataset.findUnique({
        include: { _count: { select: { cases: true } }, cases: { orderBy: { createdAt: 'asc' } } },
        where: { id: request.params.id },
      });
      if (!ds) {
        return sendError(reply, 404, 'DATASET_NOT_FOUND', 'Eval dataset not found');
      }
      const data: EvalDatasetDetail = {
        caseCount: ds._count.cases,
        cases: ds.cases.map(toCaseDto),
        createdAt: ds.createdAt.toISOString(),
        description: ds.description,
        id: ds.id,
        name: ds.name,
        scope: ds.scope,
        slug: ds.slug,
      };
      return { data };
    }
  );

  // ── Re-screen a dataset's cases, or one case ──
  // Resets the flake-screen state (flakeRuns 0 marks a case never screened) and
  // starts the dataset's screen, which joins one already running. For a case
  // that failed its screen for a reason since fixed, or after the reference's
  // environment changed. Until the new screen passes, the harness skips the case.
  const rescreen = async (
    actor: JwtPayload,
    log: FastifyBaseLogger,
    datasetId: string,
    caseId: string | null
  ): Promise<EvalRescreenResultDto | keyof typeof RESCREEN_NOT_FOUND> => {
    const ds = await fastify.prisma.evalDataset.findUnique({
      select: { id: true },
      where: { id: datasetId },
    });
    if (!ds) {
      return 'DATASET_NOT_FOUND';
    }
    // What the reset discards, for the audit: how many of the cases were screened,
    // failed their screen, or were never screened. Counted in the reset's own
    // repeatable-read transaction, so a screen recording a result meanwhile
    // cannot skew them.
    const scope = { datasetId: ds.id, ...(caseId ? { id: caseId } : {}) };
    const count = await fastify.prisma.$transaction(
      async (tx) => {
        const screenedBefore = await tx.evalCase.count({
          where: { ...scope, flakeScreened: true },
        });
        const failedBefore = await tx.evalCase.count({
          where: { ...scope, flakeRuns: { gt: 0 }, flakeScreened: false },
        });
        const neverBefore = await tx.evalCase.count({ where: { ...scope, flakeRuns: 0 } });
        const reset = await tx.evalCase.updateMany({
          data: { flakeRuns: 0, flakeScreened: false, flakeScreenInfraErrors: 0 },
          where: scope,
        });
        if (caseId && reset.count === 0) {
          return 0;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor,
          after: { flakeRuns: 0, flakeScreened: false, rescreen: caseId ? { caseId } : 'dataset' },
          before: { failed: failedBefore, neverScreened: neverBefore, screened: screenedBefore },
          client: tx,
          entityId: ds.id,
          entityType: 'EvalDataset',
        });
        return reset.count;
      },
      // One snapshot for the counts and the reset, so the audit matches what was reset.
      { isolationLevel: 'RepeatableRead' }
    );
    if (caseId && count === 0) {
      return 'CASE_NOT_FOUND';
    }
    // Best-effort, like the start on create: the cases are reset either way, and
    // the next eval run of the dataset or the re-validation sweep screens them.
    let screenStarted = false;
    if (count > 0) {
      try {
        await fastify.temporal.startEvalScreenWorkflow(evalScreenWorkflowId(ds.id), {
          datasetId: ds.id,
        });
        screenStarted = true;
      } catch (err) {
        log.error({ datasetId: ds.id, err }, 'failed to start EvalScreenWorkflow');
      }
    }
    return { reset: count, screenStarted };
  };

  app.post(
    '/evals/:id/rescreen',
    { onRequest: adminOnly, schema: { params: IdParam } },
    async (request, reply) => {
      const out = await rescreen(requireUser(request), request.log, request.params.id, null);
      if (typeof out === 'string') {
        return sendError(reply, 404, out, RESCREEN_NOT_FOUND[out]);
      }
      return reply.status(202).send({ data: out });
    }
  );

  app.post(
    '/evals/:id/cases/:caseId/rescreen',
    { onRequest: adminOnly, schema: { params: CaseParams } },
    async (request, reply) => {
      const { caseId, id } = request.params;
      const out = await rescreen(requireUser(request), request.log, id, caseId);
      if (typeof out === 'string') {
        return sendError(reply, 404, out, RESCREEN_NOT_FOUND[out]);
      }
      return reply.status(202).send({ data: out });
    }
  );

  // ── Results query (paginated; the /admin/evals dashboard reads it) ──
  app.get(
    '/evals/results',
    { onRequest: adminOnly, schema: { querystring: ResultsQuery } },
    async (request) => {
      const { evalRunId, limit, offset, runId, scorer, source } = request.query;
      const where = {
        ...(runId ? { runId } : {}),
        ...(evalRunId ? { evalRunId } : {}),
        ...(source ? { source } : {}),
        ...(scorer ? { scorer } : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.evalResult.findMany({
          // `id` breaks ties so offset pages neither repeat nor skip rows.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.evalResult.count({ where }),
      ]);
      const data: EvalResultDto[] = rows.map(projectEvalResult);
      return { data, meta: { limit, offset, total } };
    }
  );

  // ── Per-scorer daily trend ──
  // Prisma cannot truncate to a day, so this is one bounded groupBy per UTC day
  // (at most 90 days, or weekly above that: at most 53 queries), a few at a time. Scorers are a small key space, and the
  // window-wide figures are folded from the daily ones rather than re-scanned.
  app.get(
    '/evals/trends',
    { onRequest: adminOnly, schema: { querystring: TrendsQuery } },
    async (request) => {
      const { by, source, templateId } = request.query;
      const custom = resolveCustomRange(request.query);
      const windowDays = custom?.days ?? request.query.window;
      // Whole UTC days closed at the end of today, as the usage report does.
      const until = custom ? custom.end.getTime() : utcDayStart(Date.now()) + DAY_MS;
      const since = custom ? custom.start.getTime() : until - windowDays * DAY_MS;
      const { bucketDays, buckets } = seriesBuckets(since, windowDays);
      const perDay = await mapLimited(buckets, TREND_CONCURRENCY, ({ end, start }) =>
        fastify.prisma.evalResult.groupBy({
          _avg: { value: true },
          _count: { _all: true },
          by: by ? ['scorer', by] : ['scorer'],
          where: {
            createdAt: { gte: new Date(start), lt: new Date(end) },
            // A scorer that could not score wrote a placeholder value; a mean that
            // counted it would read a broken judge as a mediocre candidate. The
            // NULL arm is explicit: `NOT LIKE` alone drops every NULL rationale.
            OR: [
              { rationale: null },
              { NOT: { rationale: { startsWith: EVAL_SCORER_ERROR_PREFIX } } },
            ],
            ...(source ? { source } : {}),
            ...(templateId ? { run: { templateId } } : {}),
          },
        })
      );

      // A series is a scorer, or a scorer split by the `by` column. JSON keeps
      // a null breakdown (a row no model or agent produced) distinct from any string.
      const byScorer = new Map<
        string,
        {
          scorer: string;
          breakdown: string | null;
          n: number;
          sum: number;
          daily: Map<number, { n: number; mean: number }>;
        }
      >();
      perDay.forEach((groups, dayIndex) => {
        for (const g of groups) {
          const n = g._count._all;
          const mean = g._avg.value ?? 0;
          const breakdown = by ? ((g as Record<string, unknown>)[by] as string | null) : null;
          const key = JSON.stringify([g.scorer, breakdown]);
          const acc = byScorer.get(key) ?? {
            breakdown,
            daily: new Map(),
            n: 0,
            scorer: g.scorer,
            sum: 0,
          };
          acc.n += n;
          acc.sum += mean * n;
          acc.daily.set(dayIndex, { mean, n });
          byScorer.set(key, acc);
        }
      });
      const scorers: EvalScorerTrend[] = [...byScorer.values()]
        .sort(
          (a, b) =>
            a.scorer.localeCompare(b.scorer) || (a.breakdown ?? '').localeCompare(b.breakdown ?? '')
        )
        .map((acc) => ({
          ...(by ? { breakdown: acc.breakdown } : {}),
          daily: buckets.map(({ start }, i) => {
            const day = acc.daily.get(i);
            return {
              date: new Date(start).toISOString().slice(0, 10),
              mean: day?.mean ?? null,
              n: day?.n ?? 0,
            };
          }),
          mean: acc.sum / acc.n,
          n: acc.n,
          scorer: acc.scorer,
        }));
      const data: EvalTrendsDto = {
        ...(by ? { by } : {}),
        bucketDays,
        scorers,
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        windowDays,
      };
      return { data };
    }
  );

  // ── Suite health ──
  // What the stored data can say about a benchmark's health: the share of each
  // dataset's golden cases quarantined as stale (exact), how many are flake-screened, and
  // which the harness skips for want of a passing screen. Grouped counts over the cases plus,
  // per dataset, a bounded read of the oldest unscreened ids; the thresholds are the Tier-2
  // defaults the gate uses.
  app.get('/evals/suite-health', { onRequest: adminOnly }, async () => {
    const [groups, neverGroups, datasets, defaults] = await Promise.all([
      fastify.prisma.evalCase.groupBy({
        _count: { _all: true },
        by: ['datasetId', 'quarantined', 'flakeScreened'],
      }),
      // flakeRuns = 0 marks a case never screened; above it, a screen that failed.
      fastify.prisma.evalCase.groupBy({
        _count: { _all: true },
        by: ['datasetId'],
        where: { flakeRuns: 0, flakeScreened: false, quarantined: false },
      }),
      runUnscoped('admin suite health spans every team', ['EvalDataset'], () =>
        fastify.prisma.evalDataset.findMany({ select: { id: true, name: true, slug: true } })
      ),
      resolveWorkflowDefaults(),
    ]);
    const perDataset = new Map<
      string,
      { cases: number; quarantined: number; screened: number; unscreened: number }
    >();
    for (const g of groups) {
      const acc = perDataset.get(g.datasetId) ?? {
        cases: 0,
        quarantined: 0,
        screened: 0,
        unscreened: 0,
      };
      acc.cases += g._count._all;
      acc.quarantined += g.quarantined ? g._count._all : 0;
      acc.screened += g.flakeScreened ? g._count._all : 0;
      acc.unscreened += !g.flakeScreened && !g.quarantined ? g._count._all : 0;
      perDataset.set(g.datasetId, acc);
    }
    const neverCounts = new Map(neverGroups.map((g) => [g.datasetId, g._count._all]));
    // The cases the harness skips: not quarantined (skipped for that already) and not screened.
    const skippedIds = async (datasetId: string, failed: boolean): Promise<string[]> => {
      const rows = await fastify.prisma.evalCase.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: SUITE_HEALTH_CASE_IDS,
        where: {
          datasetId,
          flakeRuns: failed ? { gt: 0 } : 0,
          flakeScreened: false,
          quarantined: false,
        },
      });
      return rows.map((r) => r.id);
    };
    // One dataset at a time: each may read two id lists, and firing them all at
    // once for many datasets would outrun the connection pool.
    const rows: EvalSuiteHealthDto['datasets'] = [];
    for (const d of datasets) {
      const acc = perDataset.get(d.id) ?? { cases: 0, quarantined: 0, screened: 0, unscreened: 0 };
      const never = neverCounts.get(d.id) ?? 0;
      const failed = Math.max(0, acc.unscreened - never);
      rows.push({
        cases: acc.cases,
        datasetId: d.id,
        flakeScreened: acc.screened,
        name: d.name,
        neverScreened: never,
        neverScreenedCaseIds: never > 0 ? await skippedIds(d.id, false) : [],
        quarantined: acc.quarantined,
        screenFailed: failed,
        screenFailedCaseIds: failed > 0 ? await skippedIds(d.id, true) : [],
        slug: d.slug,
        staleRate: acc.cases > 0 ? acc.quarantined / acc.cases : 0,
      });
    }
    const data: EvalSuiteHealthDto = {
      datasets: rows.sort((a, b) => a.slug.localeCompare(b.slug)),
      thresholds: {
        maxFlakeRate: defaults.evalHealthMaxFlakeRate,
        maxStaleRate: defaults.evalHealthMaxStaleRate,
        minKappa: defaults.evalHealthMinKappa,
      },
    };
    return { data };
  });

  // ── List eval runs (newest first) ──
  app.get(
    '/evals/runs',
    { onRequest: adminOnly, schema: { querystring: RunsQuery } },
    async (request) => {
      const { datasetId, limit, offset } = request.query;
      const where = datasetId ? { datasetId } : {};
      const [rows, total] = await Promise.all([
        fastify.prisma.evalRun.findMany({
          // The dataset's name, so a list across datasets says which benchmark each run scored.
          include: { dataset: { select: { name: true, slug: true } } },
          // `id` breaks ties so offset pages neither repeat nor skip rows.
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.evalRun.count({ where }),
      ]);
      return { data: rows.map(toRunDto), meta: { limit, offset, total } };
    }
  );

  // ── Eval run detail ──
  app.get(
    '/evals/runs/:id',
    { onRequest: adminOnly, schema: { params: IdParam } },
    async (request, reply) => {
      const run = await fastify.prisma.evalRun.findUnique({
        include: { dataset: { select: { name: true, slug: true } } },
        where: { id: request.params.id },
      });
      if (!run) {
        return sendError(reply, 404, 'EVAL_RUN_NOT_FOUND', 'Eval run not found');
      }
      return { data: toRunDto(run) };
    }
  );

  // ── Start an offline harness run ──
  // Creates the EvalRun row; the durable harness (a Temporal workflow wrapping
  // runEvalHarness) is started here — that start is the integration seam
  // (docs/evals.md §3). The CLI polls GET /evals/runs/:id for the verdict.
  app.post(
    '/evals/runs',
    { onRequest: adminOnly, schema: { body: StartRunBody } },
    async (request, reply) => {
      const { baselineRef, candidateRef, datasetId } = request.body;
      // Refuse before any row exists: with no Temporal there is nothing to start,
      // and a FAILED row plus a FAILED metric would record an outage as an eval result.
      if (!temporalConnected(fastify)) {
        return sendTemporalUnavailable(reply);
      }
      const baselineRuntime = request.body.baselineRuntime ?? null;
      const candidateRuntime = request.body.candidateRuntime ?? null;
      const ds = await fastify.prisma.evalDataset.findUnique({ where: { id: datasetId } });
      if (!ds) {
        return sendError(reply, 404, 'DATASET_NOT_FOUND', 'Eval dataset not found');
      }
      const run = await fastify.prisma.evalRun.create({
        data: {
          baselineRef,
          baselineRuntime,
          candidateRef,
          candidateRuntime,
          datasetId,
          status: 'RUNNING',
        },
      });
      // Start the durable harness workflow. There is no retry endpoint and the
      // CLI polls this row for a verdict, so a start failure must be visible:
      // mark the row FAILED and answer 502 rather than leaving it RUNNING forever.
      try {
        await fastify.temporal.startEvalRunWorkflow(`eval-${run.id}`, {
          baselineRef,
          baselineRuntime,
          candidateRef,
          candidateRuntime,
          datasetId,
          evalRunId: run.id,
        });
      } catch (err) {
        request.log.error({ err, evalRunId: run.id }, 'failed to start EvalRunWorkflow');
        await fastify.prisma.evalRun.update({
          data: {
            endedAt: new Date(),
            status: 'FAILED',
            summary: { error: err instanceof Error ? err.message : String(err) },
          },
          where: { id: run.id },
        });
        // No workflow exists to finalize this run, so it is counted here.
        recordRunFinalized('FAILED', 'eval');
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        return sendError(reply, 502, 'EVAL_START_FAILED', 'Could not start the eval run workflow');
      }
      // After the start, like every launch row: a refused or failed start leaves none, and a
      // failed audit write is logged rather than turned into an error for a run that is going.
      try {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: requireUser(request),
          after: {
            baselineRef,
            candidateRef,
            datasetId,
            source: 'eval-run',
            temporalWorkflowId: `eval-${run.id}`,
          },
          entityId: run.id,
          entityType: 'EvalRun',
        });
      } catch (err) {
        request.log.error({ err, evalRunId: run.id }, 'eval launch audit write failed');
      }
      return reply.status(202).send({ data: toRunDto(run) });
    }
  );

  // ── List judge rubrics ──
  app.get('/evals/rubrics', { onRequest: adminOnly }, async () => {
    const rows = await runUnscoped('admin rubric listing spans every team', ['EvalRubric'], () =>
      fastify.prisma.evalRubric.findMany({ orderBy: { createdAt: 'desc' } })
    );
    const data: EvalRubricDto[] = rows.map(toRubricDto);
    return { data };
  });

  // ── Create a judge rubric ──
  // promptText is scanned for injection/exfiltration like Skill/agent prompt
  // text — non-blocking warnings are returned alongside the created rubric.
  app.post(
    '/evals/rubrics',
    { onRequest: adminOnly, schema: { body: CreateRubricBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { promptText, scale, scope, slug } = request.body;
      const scanWarnings = await scanSkillAdvisory(null, promptText);
      const rubric = await fastify.prisma.evalRubric.create({
        data: { promptText, scale, scope, slug },
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { scope: rubric.scope, slug: rubric.slug, version: rubric.version },
        entityId: rubric.id,
        entityType: 'EvalRubric',
      });
      return reply.status(201).send({ data: toRubricDto(rubric), scanWarnings });
    }
  );
};
