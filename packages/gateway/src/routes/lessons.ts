import type { Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ConsolidateBody = z.object({
  minClusterSize: z.number().int().min(2).max(20).optional(),
  repoId: z.string().uuid(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
});

const LessonListQuery = paginationQuery({ defaultLimit: 100, maxLimit: 200 }).extend({
  includeConsolidated: z.coerce.boolean().default(false),
});

const LessonSearchQuery = z.object({
  includeConsolidated: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().min(1),
  repoId: z.string().uuid(),
});

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
      const { includeConsolidated, limit, offset } = request.query;

      const accessFilter: Prisma.MemoryItemWhereInput =
        user.role === 'ADMIN'
          ? {}
          : { repository: { team: { memberships: { some: { userId: user.sub } } } } };

      const where: Prisma.MemoryItemWhereInput = {
        ...accessFilter,
        ...(!includeConsolidated && { consolidatedAt: null }),
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
            team: { memberships: { some: { userId: user.sub } } },
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
              ...(!includeConsolidated && { consolidatedAt: null }),
              repoId,
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
            where: { repoId: { not: null } },
          }),
          fastify.prisma.memoryItem.groupBy({
            _count: { _all: true },
            by: ['repoId'],
            where: { consolidatedAt: null, repoId: { not: null } },
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
  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
    },
    async (request, reply) => {
      const lesson = await fastify.prisma.memoryItem.findUnique({
        where: { id: request.params.id },
      });
      if (!lesson) {
        return reply.status(404).send({
          error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found' },
        });
      }

      await fastify.prisma.memoryItem.delete({
        where: { id: request.params.id },
      });

      return { data: { deleted: true } };
    }
  );
};
