import type { Prisma } from '@auto-swe/shared';
import { forgetMemoryItems } from '@auto-swe/shared/lib/memoryForget';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ConsolidateBody = z.object({
  minClusterSize: z.number().int().min(2).max(20).optional(),
  repoId: z.string().uuid(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
});

const LessonListQuery = paginationQuery({ defaultLimit: 100, maxLimit: 200 }).extend({
  includeConsolidated: booleanQueryParam(false),
  // Narrow to one repository, and/or to lessons whose summary or rationale contains `q`.
  q: z.string().trim().min(1).max(200).optional(),
  repoId: z.string().uuid().optional(),
});

const LessonSearchQuery = z.object({
  includeConsolidated: booleanQueryParam(false),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().min(1),
  repoId: z.string().uuid(),
});

const LessonIdParams = z.object({ id: z.string().uuid() });

/**
 * `memory_items` holds two memories: repository lessons and Slack channel
 * memory. These routes serve the first only. Without the scope a platform
 * admin's list (no access filter) showed every channel's memory, private
 * channels included, as "lessons", and the delete reached channel memory
 * without the channel route's audit.
 */
const LESSON_SCOPE = 'swe-lessons';

export const lessonRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/lessons — List lessons
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: LessonListQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { includeConsolidated, limit, offset, q, repoId } = request.query;

      const accessFilter: Prisma.MemoryItemWhereInput =
        user.role === 'ADMIN'
          ? {}
          : { repository: reachableConnections(user, request.repoAccessGate) };

      const where: Prisma.MemoryItemWhereInput = {
        ...accessFilter,
        scope: LESSON_SCOPE,
        ...(!includeConsolidated && { consolidatedAt: null, supersededAt: null }),
        // Combined with the access filter, never replacing it: a repoId the caller cannot
        // reach matches nothing rather than widening the result.
        ...(repoId && { repoId }),
        ...(q && {
          OR: [
            { lessonSummary: { contains: q, mode: 'insensitive' } },
            { rationale: { contains: q, mode: 'insensitive' } },
          ],
        }),
      };

      // `accessFilter` is `{}` for a platform admin, which is the intent — but
      // written that way it is indistinguishable from a forgotten filter.
      const [lessons, total] = await asPlatformAdmin(
        user,
        "admin sees every team's lessons",
        ['MemoryItem'],
        () =>
          Promise.all([
            fastify.prisma.memoryItem.findMany({
              orderBy: { createdAt: 'desc' },
              select: {
                consolidatedAt: true,
                createdAt: true,
                failureType: true,
                id: true,
                lessonSummary: true,
                metadata: true,
                rationale: true,
                repository: { select: { id: true, organizationName: true, repoName: true } },
                workflow: { select: { currentStatus: true, id: true, temporalWorkflowId: true } },
              },
              skip: offset,
              take: limit,
              where,
            }),
            fastify.prisma.memoryItem.count({ where }),
          ])
      );

      return { data: lessons, meta: { limit, offset, total } };
    }
  );

  // GET /api/v1/lessons/search — Semantic similarity search
  app.get(
    '/search',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: LessonSearchQuery },
    },
    async (request, reply) => {
      const { q, repoId, limit, includeConsolidated } = request.query;

      // Non-admins must be a member of the team that owns the repo they're searching
      const user = requireUser(request);
      if (user.role !== 'ADMIN') {
        const accessibleRepo = await fastify.prisma.connection.findFirst({
          select: { id: true },
          where: {
            id: repoId,
            ...reachableConnections(user, request.repoAccessGate),
          },
        });
        if (!accessibleRepo) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
          });
        }
      }

      // Semantic search requires the worker's embedding + pgvector query
      // For the gateway API, we do a text-based fallback search
      // Bounded to the single `repoId` the caller was just authorised for
      // above, which is narrower than a team filter — but `repoId` is not a
      // tenant column, so the guard cannot see it.
      const lessons = await runUnscoped(
        'bounded to one pre-authorised repoId',
        ['MemoryItem'],
        () =>
          fastify.prisma.memoryItem.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
              createdAt: true,
              failureType: true,
              id: true,
              lessonSummary: true,
              rationale: true,
            },
            take: limit,
            where: {
              OR: [
                { lessonSummary: { contains: q, mode: 'insensitive' } },
                { rationale: { contains: q, mode: 'insensitive' } },
              ],
              ...(!includeConsolidated && { consolidatedAt: null, supersededAt: null }),
              repoId,
              scope: LESSON_SCOPE,
            },
          })
      );

      return { data: lessons };
    }
  );

  // POST /api/v1/lessons/consolidate — Trigger lesson consolidation (ADMIN only)
  app.post(
    '/consolidate',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: ConsolidateBody },
    },
    async (request, reply) => {
      const { repoId, minClusterSize, similarityThreshold } = request.body;

      const repo = await fastify.prisma.connection.findUnique({
        select: { id: true },
        where: { id: repoId },
      });
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }

      const workflowId = `consolidate-lessons-${repoId}-${Date.now()}`;
      await fastify.temporal.startConsolidationWorkflow(workflowId, {
        minClusterSize,
        repoId,
        similarityThreshold,
      });

      return reply.status(202).send({ data: { workflowId } });
    }
  );

  // GET /api/v1/lessons/stats — Per-repo aggregate stats (ADMIN only)
  //
  // Aggregated in the DB via groupBy rather than loading every MemoryItem row
  // per repo — a repo with a long history of lessons would otherwise pull its
  // entire memory_items table into gateway memory just to count rows.
  //
  // The repo list is enumerated in its own query rather than derived from the
  // groupBy: a repo that has no lessons yet must still render a zero row. On a
  // fresh deployment EVERY configured repo is in that state, so deriving the
  // list from the groupBy returned nothing and the admin table showed "No
  // repositories found" — and the per-repo "Run now" control vanished with it.
  app.get('/stats', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    // Whole-fleet by design: this is the admin view of memory health across
    // every repo, and the per-repo "Run now" control is built from it.
    const [repos, totalGroups, activeGroups] = await runUnscoped(
      'admin memory-health stats span every team',
      ['Connection', 'MemoryItem'],
      () =>
        Promise.all([
          // `git_repo` only — the Connection table is polymorphic (e.g. `mcp`
          // servers), and a non-repo connection has no org/repo name to show.
          fastify.prisma.connection.findMany({
            select: { id: true, organizationName: true, repoName: true },
            where: { type: 'git_repo' },
          }),
          fastify.prisma.memoryItem.groupBy({
            _count: { _all: true },
            _max: { consolidatedAt: true },
            by: ['repoId'],
            where: { repoId: { not: null }, scope: LESSON_SCOPE },
          }),
          fastify.prisma.memoryItem.groupBy({
            _count: { _all: true },
            by: ['repoId'],
            where: {
              consolidatedAt: null,
              repoId: { not: null },
              scope: LESSON_SCOPE,
              supersededAt: null,
            },
          }),
        ])
    );

    const repoById = new Map(repos.map((r) => [r.id, r]));
    const totalByRepoId = new Map(
      totalGroups
        .filter((g): g is typeof g & { repoId: string } => g.repoId !== null)
        .map((g) => [g.repoId, g] as const)
    );
    const activeCountByRepoId = new Map(activeGroups.map((g) => [g.repoId, g._count._all]));

    // Every git repo, plus (defensively) any repo that has lessons but is
    // absent from that list — the page sums these rows into its summary tiles,
    // so silently dropping one would understate the totals.
    const repoIds = [...new Set([...repoById.keys(), ...totalByRepoId.keys()])];

    const data = repoIds
      .map((id) => {
        const repo = repoById.get(id);
        const group = totalByRepoId.get(id);
        const totalCount = group?._count._all ?? 0;
        const activeCount = activeCountByRepoId.get(id) ?? 0;
        return {
          activeCount,
          consolidatedCount: totalCount - activeCount,
          id,
          lastConsolidatedAt: group?._max.consolidatedAt ?? null,
          organizationName: repo?.organizationName ?? null,
          repoName: repo?.repoName ?? null,
          totalCount,
        };
      })
      .sort(
        (a, b) =>
          (a.organizationName ?? '').localeCompare(b.organizationName ?? '') ||
          (a.repoName ?? '').localeCompare(b.repoName ?? '')
      );

    return { data };
  });

  // DELETE /api/v1/lessons/:id — Delete lesson (ADMIN only)
  app.delete(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: LessonIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      // Channel memory is deleted through its own audited channel route.
      const lesson = await fastify.prisma.memoryItem.findFirst({
        select: {
          createdAt: true,
          failureType: true,
          id: true,
          lessonSummary: true,
          rationale: true,
          repoId: true,
          workflowRunId: true,
        },
        where: { id: request.params.id, scope: LESSON_SCOPE },
      });
      if (!lesson) {
        return reply.status(404).send({
          error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found' },
        });
      }

      // Forgetting follows the lesson into every row that carries it — merged
      // copies, and a merged lesson's own sources — and restores what only a
      // retracted merge was hiding (`forgetMemoryItems`). The delete is
      // irreversible, so the audit row carries the deleted content and both id
      // lists, and commits or rolls back with the forget.
      const result = await fastify.prisma.$transaction(async (tx) => {
        const forgotten = await forgetMemoryItems(tx, [lesson.id]);
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          after: forgotten,
          before: lesson,
          client: tx,
          entityId: lesson.id,
          entityType: 'MemoryItem',
        });
        return forgotten;
      });

      return { data: { deleted: true, forgotten: result.deleted, restored: result.restored } };
    }
  );
};
