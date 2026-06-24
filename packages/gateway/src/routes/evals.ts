/**
 * Eval admin routes — P1 of the evals feature (docs/evals-p1.md).
 *
 * CRUD for frozen-benchmark datasets/cases and a paginated results-query
 * endpoint (the read path the P3 drift dashboard will also use). Admin-only,
 * mirroring the agent-library + security-events route patterns. Starting an
 * offline harness run is wired in WS4 (a Temporal workflow); this file owns the
 * datasets, cases, and result/run reads.
 */

import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import type {
  EvalCaseDto,
  EvalDatasetDetail,
  EvalDatasetSummary,
  EvalResultDto,
  EvalRubricDto,
  EvalRunDto,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { projectEvalResult } from './workflowProjections.js';

const IdParam = z.object({ id: z.string().uuid() });

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
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'WORKFLOW_TEMPLATE';
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
  candidateRef: z.string().min(1).max(200),
  datasetId: z.string().uuid(),
});

const ResultsQuery = z.object({
  evalRunId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  runId: z.string().uuid().optional(),
  scorer: z.string().max(200).optional(),
  source: z.enum(['GATE', 'ASSERT', 'REVIEW', 'MERGE', 'JUDGE', 'TRAJECTORY']).optional(),
});

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
    tags: c.tags,
  };
}

export const evalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  // ── List datasets ──
  app.get('/evals', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.evalDataset.findMany({
      include: { _count: { select: { cases: true } } },
      orderBy: { createdAt: 'desc' },
    });
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
        return reply
          .status(404)
          .send({ error: { code: 'DATASET_NOT_FOUND', message: 'Eval dataset not found' } });
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

  // ── Results query (paginated; the P3 drift dashboard reuses this) ──
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
          orderBy: { createdAt: 'desc' },
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

  // ── Eval run detail ──
  app.get(
    '/evals/runs/:id',
    { onRequest: adminOnly, schema: { params: IdParam } },
    async (request, reply) => {
      const run = await fastify.prisma.evalRun.findUnique({ where: { id: request.params.id } });
      if (!run) {
        return reply
          .status(404)
          .send({ error: { code: 'EVAL_RUN_NOT_FOUND', message: 'Eval run not found' } });
      }
      const data: EvalRunDto = {
        baselineRef: run.baselineRef,
        candidateRef: run.candidateRef,
        datasetId: run.datasetId,
        endedAt: run.endedAt?.toISOString() ?? null,
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        status: run.status,
        summary: run.summary,
      };
      return { data };
    }
  );

  // ── Start an offline harness run (P1/WS4) ──
  // Creates the EvalRun row; the durable harness (a Temporal workflow wrapping
  // runEvalHarness) is started here — that start is the integration seam
  // (docs/evals-p1.md WS4). The CLI polls GET /evals/runs/:id for the verdict.
  app.post(
    '/evals/runs',
    { onRequest: adminOnly, schema: { body: StartRunBody } },
    async (request, reply) => {
      const { baselineRef, candidateRef, datasetId } = request.body;
      const ds = await fastify.prisma.evalDataset.findUnique({ where: { id: datasetId } });
      if (!ds) {
        return reply
          .status(404)
          .send({ error: { code: 'DATASET_NOT_FOUND', message: 'Eval dataset not found' } });
      }
      const run = await fastify.prisma.evalRun.create({
        data: { baselineRef, candidateRef, datasetId, status: 'RUNNING' },
      });
      // Start the durable harness workflow. Best-effort: if Temporal is briefly
      // unreachable the run row stays RUNNING and can be retried; we don't fail
      // the request (mirrors the work-request start path).
      await fastify.temporal
        .startEvalRunWorkflow(`eval-${run.id}`, {
          baselineRef,
          candidateRef,
          datasetId,
          evalRunId: run.id,
        })
        .catch((err: unknown) => {
          request.log.error({ err, evalRunId: run.id }, 'failed to start EvalRunWorkflow');
        });
      const data: EvalRunDto = {
        baselineRef: run.baselineRef,
        candidateRef: run.candidateRef,
        datasetId: run.datasetId,
        endedAt: null,
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        status: run.status,
        summary: run.summary,
      };
      return reply.status(202).send({ data });
    }
  );

  // ── List judge rubrics (P2) ──
  app.get('/evals/rubrics', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.evalRubric.findMany({ orderBy: { createdAt: 'desc' } });
    const data: EvalRubricDto[] = rows.map(toRubricDto);
    return { data };
  });

  // ── Create a judge rubric (P2) ──
  // promptText is scanned for injection/exfiltration like Skill/agent prompt
  // text — non-blocking warnings are returned alongside the created rubric.
  app.post(
    '/evals/rubrics',
    { onRequest: adminOnly, schema: { body: CreateRubricBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { promptText, scale, scope, slug } = request.body;
      const scan = await scanSkillContent(promptText);
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
      return reply.status(201).send({ data: toRubricDto(rubric), scanWarnings: scan.warnings });
    }
  );
};
