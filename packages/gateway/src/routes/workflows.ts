import type { Prisma } from '@auto-swe/shared';
import { type PullRequestRepo, pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import { resolveGitHubBaseUrl } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type ConnectionEnvelopeColumns,
  type RedactedConnection,
  redactConnection,
} from '../lib/connectionRedaction.js';
import { paginationQuery } from '../lib/pagination.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

// Default high enough that the dashboard's KPI view covers recent history,
// but bounded — the table only grows and this endpoint is polled every 10s.
const ListWorkflowsQuery = paginationQuery({ defaultLimit: 200, maxLimit: 500 });

// The token counters are `BigInt` in the DB (they can exceed Int32 on large
// runs). Fastify's JSON serializer throws on a bare BigInt, so coerce the two
// columns to Number before returning a raw ActiveWorkflow row.
function serializeWorkflow<
  R extends Partial<ConnectionEnvelopeColumns> & PullRequestRepo,
  P extends { prNumber: number | null },
  T extends {
    tokensInputUsed: bigint;
    tokensOutputUsed: bigint;
    repository: R | null;
    pullRequests: P[];
  },
>(
  workflow: T,
  instanceBaseUrl: string
): Omit<T, 'tokensInputUsed' | 'tokensOutputUsed' | 'repository' | 'pullRequests'> & {
  pullRequests: Array<P & { url: string | null }>;
  repository: RedactedConnection<R> | null;
  tokensInputUsed: number;
  tokensOutputUsed: number;
} {
  const repo = workflow.repository;
  return {
    ...workflow,
    // Each PR's link on its host, derived here so a client never assumes the host.
    pullRequests: workflow.pullRequests.map((pr) => ({
      ...pr,
      url: repo ? pullRequestUrl(repo, pr.prNumber, instanceBaseUrl) : null,
    })),
    // The joined connection carries the API-token envelope — strip it.
    repository: repo ? redactConnection(repo) : null,
    tokensInputUsed: Number(workflow.tokensInputUsed),
    tokensOutputUsed: Number(workflow.tokensOutputUsed),
  };
}

const WorkflowIdParams = z.object({ id: z.string().uuid() });

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/workflows
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListWorkflowsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset } = request.query;
      const where: Prisma.ActiveWorkflowWhereInput =
        user.role === 'ADMIN'
          ? {}
          : {
              repository: reachableConnections(user, request.repoAccessGate),
            };

      const [workflows, total, instanceBaseUrl] = await Promise.all([
        fastify.prisma.activeWorkflow.findMany({
          include: { pullRequests: true, repository: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.activeWorkflow.count({ where }),
        resolveGitHubBaseUrl(),
      ]);
      return {
        data: workflows.map((workflow) => serializeWorkflow(workflow, instanceBaseUrl)),
        meta: { limit, offset, total },
      };
    }
  );

  // GET /api/v1/workflows/:id
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const where: Prisma.ActiveWorkflowWhereInput = {
        id: request.params.id,
        ...(user.role !== 'ADMIN' && {
          repository: reachableConnections(user, request.repoAccessGate),
        }),
      };

      const workflow = await fastify.prisma.activeWorkflow.findFirst({
        include: { pullRequests: true, repository: true, workRequest: true },
        where,
      });
      if (!workflow) {
        return reply.status(404).send({
          error: {
            code: 'WORKFLOW_NOT_FOUND',
            message: `No workflow with id ${request.params.id}`,
          },
        });
      }
      return { data: serializeWorkflow(workflow, await resolveGitHubBaseUrl()) };
    }
  );
};
