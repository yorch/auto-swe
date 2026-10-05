import type { Prisma } from '@auto-swe/shared';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import {
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from '@auto-swe/shared/lib/channelTask';
import { type PullRequestState, pullRequestUrl } from '@auto-swe/shared/lib/pullRequest';
import type { TicketGroup, WorkflowRunStatus } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const Query = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  /** Show agent, channel and template launches that have no ticket of their own. */
  includeAutomated: booleanQueryParam(),
  scope: z.enum(['MINE', 'TEAM']).default('MINE'),
  search: z.string().trim().max(200).optional(),
  teamId: z.string().uuid().optional(),
});

const TICKET_TEXT_MAX = 300;

/** Tracker text as stored: a string, capped. Anything else is no answer. */
function trackerText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, TICKET_TEXT_MAX) : null;
}

/** A tracker link is returned only for an http(s) address, never a `javascript:` one. */
function trackerUrl(value: unknown): string | null {
  const text = trackerText(value);
  if (!text) {
    return null;
  }
  try {
    const { protocol } = new URL(text);
    return protocol === 'https:' || protocol === 'http:' ? text : null;
  } catch {
    return null;
  }
}

/** The tracker's answer at submit time, from `ContextSnapshot.rawTicketData`. */
function readTicket(raw: unknown) {
  const ticket = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    status: trackerText(ticket.status),
    title: trackerText(ticket.title),
    url: trackerUrl(ticket.url),
  };
}

/**
 * Everything filed under one external ticket id, grouped.
 *
 * Which tickets are listed, and in what order, is decided in the database: a
 * `groupBy` over the requests the caller may see and the filters match, newest
 * request first. The aggregates for a listed ticket then cover ALL of its visible
 * requests, not only the ones a search or team filter matched.
 *
 * Every row is judged on its own. A request is visible to its requester, to
 * anyone who can see one of its runs (`buildWorkflowRunVisibilityFilter`, the rule
 * `GET /workflow-runs/requests` lists by), and to anyone who reaches a repository
 * it has a ledger row on or targets. Runs use the run rule; ledger rows (cost) and
 * pull requests count only on repositories the caller can reach. So a ticket
 * worked by two teams, or an epic spanning both, reads differently to each, and a
 * ticket with no visible request does not appear or count.
 */
export const ticketRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: Query },
    },
    async (request) => {
      const user = requireUser(request);
      const { includeAutomated, limit, offset, scope, search, teamId } = request.query;
      const isAdmin = user.role === 'ADMIN';
      const reachable = reachableConnections(user, request.repoAccessGate);
      const runVisibility = buildWorkflowRunVisibilityFilter(user, request.repoAccessGate);
      /** A repository predicate that a non-ADMIN also has to reach, in ONE clause. */
      const reachableAnd = (repo: Prisma.ConnectionWhereInput): Prisma.ConnectionWhereInput =>
        isAdmin ? repo : { AND: [reachable, repo] };

      const visibleRequests: Prisma.RunInputWhereInput = isAdmin
        ? {}
        : {
            OR: [
              { requestedById: user.sub },
              { workflowRuns: { some: runVisibility } },
              { activeWorkflows: { some: { repository: reachable } } },
              { connection: reachable },
            ],
          };
      const filters: Prisma.RunInputWhereInput[] = [visibleRequests];
      if (scope === 'MINE') {
        filters.push({ requestedById: user.sub });
      }
      if (teamId) {
        const inTeam = { OR: [{ teamId }, { shares: { some: { teamId } } }] };
        filters.push({
          OR: [
            { activeWorkflows: { some: { repository: reachableAnd(inTeam) } } },
            { connection: reachableAnd(inTeam) },
            { workflowRuns: { some: { AND: [runVisibility, { connection: inTeam }] } } },
          ],
        });
      }
      if (search) {
        filters.push({
          OR: [
            { externalTicketId: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        });
      }
      // Agent runs, channel tasks and the channel assistant file their own
      // synthetic ids, and a launch that named no ticket files the request's own
      // id: none of those is a ticket.
      if (!includeAutomated) {
        filters.push({
          NOT: {
            workflowRuns: {
              some: {
                OR: [
                  { template: { origin: AGENT_RUN_TEMPLATE_ORIGIN } },
                  {
                    template: {
                      name: { in: [CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME] },
                    },
                  },
                  { channelId: { not: null } },
                ],
              },
            },
          },
          ticketIsSynthetic: false,
        });
      }
      const where: Prisma.RunInputWhereInput = { AND: filters };

      const [page, everyTicket] = await Promise.all([
        fastify.prisma.runInput.groupBy({
          _max: { createdAt: true },
          by: ['externalTicketId'],
          orderBy: [{ _max: { createdAt: 'desc' } }, { externalTicketId: 'asc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.runInput.groupBy({ by: ['externalTicketId'], where }),
      ]);
      const tickets = page.map((row) => row.externalTicketId);

      const requests = await fastify.prisma.runInput.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { externalTicketId: true, id: true },
        where: { AND: [visibleRequests, { externalTicketId: { in: tickets } }] },
      });
      const requestIds = requests.map((row) => row.id);

      const [runs, ledgers, pullRequests, snapshots] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true, workRequestId: true },
          where: { AND: [runVisibility, { workRequestId: { in: requestIds } }] },
        }),
        fastify.prisma.activeWorkflow.findMany({
          select: { costUsdAccrued: true, workRequestId: true },
          where: {
            workRequestId: { in: requestIds },
            ...(isAdmin ? {} : { repository: reachable }),
          },
        }),
        fastify.prisma.pullRequest.findMany({
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            isDraft: true,
            prNumber: true,
            repository: {
              select: { githubUrl: true, id: true, organizationName: true, repoName: true },
            },
            status: true,
            workflow: { select: { workRequestId: true } },
          },
          where: {
            workflow: { workRequestId: { in: requestIds } },
            ...(isAdmin ? {} : { repository: reachable }),
          },
        }),
        fastify.prisma.contextSnapshot.findMany({
          select: { rawTicketData: true, workRequestId: true },
          where: { workRequestId: { in: requestIds } },
        }),
      ]);

      const data: TicketGroup[] = page.map((row) => {
        const ticketId = row.externalTicketId;
        const ids = requests.filter((r) => r.externalTicketId === ticketId).map((r) => r.id);
        const own = new Set(ids);
        const groupRuns = runs.filter((run) => run.workRequestId && own.has(run.workRequestId));
        const runCounts: Partial<Record<WorkflowRunStatus, number>> = {};
        for (const run of groupRuns) {
          const status = run.status as WorkflowRunStatus;
          runCounts[status] = (runCounts[status] ?? 0) + 1;
        }
        // The newest visible request that carries a tracker answer.
        const snapshot = ids
          .map((id) => snapshots.find((item) => item.workRequestId === id))
          .find((item) => item?.rawTicketData != null);
        const ticket = readTicket(snapshot?.rawTicketData);
        return {
          costUsd: ledgers
            .filter((ledger) => ledger.workRequestId && own.has(ledger.workRequestId))
            .reduce((sum, ledger) => sum + ledger.costUsdAccrued, 0),
          lastActivityAt: (row._max.createdAt ?? new Date(0)).toISOString(),
          latestRun: groupRuns[0]
            ? { id: groupRuns[0].id, status: groupRuns[0].status as WorkflowRunStatus }
            : null,
          latestWorkRequestId: ids[0] as string,
          pullRequests: pullRequests
            .filter((pr) => pr.workflow?.workRequestId && own.has(pr.workflow.workRequestId))
            .map((pr) => ({
              id: pr.id,
              isDraft: pr.isDraft,
              prNumber: pr.prNumber,
              repository: pr.repository
                ? {
                    id: pr.repository.id,
                    name: pr.repository.repoName ?? '',
                    org: pr.repository.organizationName ?? '',
                  }
                : null,
              status: pr.status as PullRequestState,
              url: pr.repository ? pullRequestUrl(pr.repository, pr.prNumber) : null,
            })),
          requestCount: ids.length,
          runCounts,
          status: ticket.status,
          ticketId,
          title: ticket.title,
          url: ticket.url,
        };
      });
      return { data, meta: { limit, offset, total: everyTicket.length } };
    }
  );
};
