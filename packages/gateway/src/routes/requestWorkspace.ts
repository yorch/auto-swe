import type { Prisma } from '@auto-swe/shared';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { groupRequestExecutions } from '../lib/requestExecutions.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { projectRunSummary, RunListPaginationQuery } from './workflowProjections.js';

const Query = RunListPaginationQuery.extend({
  requestId: z.string().uuid().optional(),
  scope: z.enum(['MINE', 'TEAM']).default('MINE'),
  search: z.string().trim().max(200).optional(),
  state: z.enum(['all', 'active', 'attention', 'finished', 'failed', 'success']).default('all'),
  teamId: z.string().uuid().optional(),
});

/** Group BEFORE filtering or paging: an old failed attempt must not hide a successful retry. */
export const requestWorkspaceRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/requests',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: Query },
    },
    async (request) => {
      const user = requireUser(request);
      const { scope, search, state, limit, offset, requestId, teamId } = request.query;
      const visibility = buildWorkflowRunVisibilityFilter(user, request.repoAccessGate);
      const where: Prisma.WorkflowRunWhereInput = {
        AND: [
          visibility,
          ...(teamId
            ? [
                {
                  OR: [
                    { connection: { OR: [{ teamId }, { shares: { some: { teamId } } }] } },
                    {
                      workRequest: {
                        connection: { OR: [{ teamId }, { shares: { some: { teamId } } }] },
                      },
                    },
                    {
                      workRequest: {
                        activeWorkflows: {
                          some: {
                            repository: { OR: [{ teamId }, { shares: { some: { teamId } } }] },
                          },
                        },
                        isCrossRepo: false,
                      },
                    },
                    { template: { teamId } },
                  ],
                },
              ]
            : []),
        ],
        template: {
          name: { notIn: [CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME] },
        },
        workRequestId: requestId ?? { not: null },
        ...(scope === 'MINE' ? { workRequest: { requestedById: user.sub } } : {}),
        ...(search
          ? {
              OR: [
                { workRequest: { description: { contains: search, mode: 'insensitive' } } },
                { workRequest: { externalTicketId: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };
      // Read only identity/status for the latest visible attempt of each request.
      // Prisma distinct keeps the first row in this deterministic order. Filtering
      // status before distinct would resurrect old failures after a successful retry.
      const executions = await fastify.prisma.workflowRun.findMany({
        distinct: ['workRequestId', 'connectionId'],
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        select: {
          _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
          id: true,
          status: true,
          workflowId: true,
          workRequest: {
            select: {
              activeWorkflows: { select: { currentStatus: true, temporalWorkflowId: true } },
              isCrossRepo: true,
            },
          },
          workRequestId: true,
        },
        where,
      });
      const latest = groupRequestExecutions(executions);
      const matching = latest.filter((run) => {
        switch (state) {
          case 'active':
            return run.status === 'RUNNING';
          case 'attention':
            return (
              run.failedExecutionCount > 0 ||
              run.needsMerge ||
              run.pendingStepCount > 0 ||
              run.status === 'FAILED' ||
              run.status === 'TIMED_OUT'
            );
          case 'finished':
            return run.status !== 'RUNNING';
          case 'failed':
            return run.status === 'FAILED' || run.status === 'TIMED_OUT';
          case 'success':
            return run.status === 'SUCCESS';
          default:
            return true;
        }
      });
      const ids = matching.slice(offset, offset + limit).map((run) => run.id);
      if (!ids.length) {
        return { data: [], meta: { limit, offset, total: matching.length } };
      }
      const connectionSelect = {
        githubUrl: true,
        name: true,
        organizationName: true,
        repoName: true,
      } as const;
      const rows = await fastify.prisma.workflowRun.findMany({
        include: {
          _count: { select: { humanSteps: { where: { status: 'PENDING' } } } },
          connection: { select: connectionSelect },
          humanSteps: { select: { timeoutAt: true }, where: { status: 'PENDING' } },
          template: { select: { name: true, workspaceProvider: true } },
          workRequest: {
            select: {
              _count: { select: { workflowRuns: { where: visibility } } },
              activeWorkflows: {
                orderBy: { updatedAt: 'desc' },
                select: {
                  currentStatus: true,
                  pullRequests: { select: { prNumber: true } },
                  repository: { select: connectionSelect },
                  temporalWorkflowId: true,
                },
                where: { repository: reachableConnections(user, request.repoAccessGate) },
              },
              connection: { select: connectionSelect },
              description: true,
              externalTicketId: true,
              id: true,
              requestPayload: true,
            },
          },
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        where: { AND: [where, { id: { in: ids } }] },
      });
      const byId = new Map(rows.map((run) => [run.id, run]));
      return {
        data: matching.slice(offset, offset + limit).flatMap((group) => {
          const run = byId.get(group.id);
          if (!run) {
            return [];
          }
          const wr = run.workRequest;
          const ledger = wr?.activeWorkflows.find(
            (item) => item.temporalWorkflowId === run.workflowId
          );
          const target =
            run.connection ??
            wr?.connection ??
            ledger?.repository ??
            wr?.activeWorkflows[0]?.repository;
          const prNumber = ledger?.pullRequests.find((pr) => pr.prNumber != null)?.prNumber;
          let reviewUrl: string | null = null;
          if (prNumber && target?.repoName && target.organizationName) {
            try {
              const base = new URL(target.githubUrl ?? 'https://github.com');
              if (base.protocol === 'https:' || base.protocol === 'http:') {
                reviewUrl = `${base.href.replace(/\/$/, '')}/${encodeURIComponent(target.organizationName)}/${encodeURIComponent(target.repoName)}/pull/${prNumber}`;
              }
            } catch {
              /* A malformed legacy URL is never linked. */
            }
          }
          return {
            ...projectRunSummary(
              {
                ...run,
                workRequest: wr
                  ? {
                      description: wr.description,
                      externalTicketId: wr.externalTicketId,
                      id: wr.id,
                      requestPayload: wr.requestPayload,
                    }
                  : null,
              },
              user.sub
            ),
            attemptCount: wr?._count.workflowRuns ?? 1,
            failedExecutionCount: group.failedExecutionCount,
            isCrossRepo: group.isCrossRepo,
            needsMerge: group.needsMerge,
            pendingStepCount: group.pendingStepCount,
            // The soonest deadline among the steps waiting on a person, so a list can say how
            // long is left without opening each request.
            pendingStepDeadline:
              run.humanSteps
                .map((step) => step.timeoutAt)
                .filter((at): at is Date => at != null)
                .sort((a, b) => a.getTime() - b.getTime())[0]
                ?.toISOString() ?? null,
            reviewUrl,
            stage: run.status === 'RUNNING' ? (ledger?.currentStatus ?? null) : null,
            status: group.status,
            target: target?.repoName
              ? [target.organizationName, target.repoName].filter(Boolean).join('/')
              : (target?.name ?? null),
            visibleExecutionCount: group.visibleExecutionCount,
          };
        }),
        meta: { limit, offset, total: matching.length },
      };
    }
  );
};
