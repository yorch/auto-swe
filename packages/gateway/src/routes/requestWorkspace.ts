import type { Prisma } from '@auto-swe/shared';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import { pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import { resolveGitHubBaseUrl } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { humanStepListWhere } from '../lib/humanStepFilters.js';
import { groupRequestExecutions } from '../lib/requestExecutions.js';
import { runListTeamScope } from '../lib/runTeamScope.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { assertTeamParam } from '../lib/teamParam.js';
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

function earliest(dates: Date[]): string | null {
  const first = dates.map((d) => d.getTime()).sort((a, b) => a - b)[0];
  return first === undefined ? null : new Date(first).toISOString();
}

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
      if (request.query.teamId) {
        await assertTeamParam(fastify.prisma, user, request.query.teamId);
      }
      const { scope, search, state, limit, offset, requestId, teamId } = request.query;
      const visibility = buildWorkflowRunVisibilityFilter(user, request.repoAccessGate);
      const where: Prisma.WorkflowRunWhereInput = {
        AND: [
          visibility,
          // Its own AND term: the team filter can only narrow what visibility allows.
          ...(teamId ? [runListTeamScope(teamId)] : []),
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
                { workRequest: { title: { contains: search, mode: 'insensitive' } } },
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
      // A run can show steps the caller may see but not answer (a repository shared to their
      // team). Attention and `pendingStepCount` mean "waiting on you", so only the steps the caller
      // controls count; visibility is never widened, the control filter is ANDed onto the candidates.
      // The same predicate as the approvals list and the sidebar badge, so the counts agree: it
      // also leaves out steps the caller already approved and steps that have expired.
      const waitingOnMe = humanStepListWhere(user, request.repoAccessGate, {
        actionable: true,
        answeredByMe: false,
        overdue: false,
        status: 'PENDING',
      });
      const candidateRunIds = executions
        .filter((run) => run._count.humanSteps > 0)
        .map((r) => r.id);
      const controlled = new Map<string, number>();
      const deadlines = new Map<string, Date[]>();
      if (candidateRunIds.length > 0) {
        const steps = await fastify.prisma.workflowHumanStep.findMany({
          select: { id: true, runId: true, timeoutAt: true },
          where: { AND: [waitingOnMe, { runId: { in: candidateRunIds } }] },
        });
        for (const step of steps) {
          controlled.set(step.runId, (controlled.get(step.runId) ?? 0) + 1);
          if (step.timeoutAt) {
            deadlines.set(step.runId, [...(deadlines.get(step.runId) ?? []), step.timeoutAt]);
          }
        }
      }
      const latest = groupRequestExecutions(
        executions.map((run) => ({ ...run, _count: { humanSteps: controlled.get(run.id) ?? 0 } }))
      );
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
      // Where a repository that names no host of its own links its PRs.
      const instanceBaseUrl = await resolveGitHubBaseUrl();
      const rows = await fastify.prisma.workflowRun.findMany({
        include: {
          connection: { select: connectionSelect },
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
          const reviewUrl = target
            ? pullRequestUrl(
                {
                  githubUrl: target.githubUrl,
                  organizationName: target.organizationName,
                  repoName: target.repoName,
                },
                prNumber ?? null,
                instanceBaseUrl
              )
            : null;
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
            // The soonest deadline among the counted steps, across every execution of the
            // request, so a list can say how long is left and a count above zero has a deadline.
            pendingStepDeadline: earliest(group.runIds.flatMap((id) => deadlines.get(id) ?? [])),
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
