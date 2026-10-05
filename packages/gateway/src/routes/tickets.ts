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
 * A group is built only from rows the caller may see: the requests (the same
 * rule as `GET /work-requests`), the runs (`buildWorkflowRunVisibilityFilter`),
 * and the ledger rows and PRs on repositories they can reach. Counts, cost and
 * title never include a row they could not list, and a group with no visible
 * request does not appear.
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

      const requestWhere: Prisma.RunInputWhereInput = {
        AND: [
          isAdmin ? {} : { activeWorkflows: { some: { repository: reachable } } },
          ...(scope === 'MINE' ? [{ requestedById: user.sub }] : []),
          ...(teamId
            ? [
                {
                  activeWorkflows: {
                    some: {
                      repository: { OR: [{ teamId }, { shares: { some: { teamId } } }] },
                    },
                  },
                },
              ]
            : []),
          ...(search
            ? [
                {
                  OR: [
                    { externalTicketId: { contains: search, mode: 'insensitive' as const } },
                    { description: { contains: search, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
          // Agent runs, channel tasks and the channel assistant file their own
          // synthetic ids; they are not tickets.
          ...(includeAutomated
            ? []
            : [
                {
                  NOT: {
                    workflowRuns: {
                      some: {
                        OR: [
                          { template: { origin: AGENT_RUN_TEMPLATE_ORIGIN } },
                          {
                            template: {
                              name: {
                                in: [CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME],
                              },
                            },
                          },
                          { channelId: { not: null } },
                        ],
                      },
                    },
                  },
                },
              ]),
        ],
      };

      const [requests, runActivity] = await Promise.all([
        fastify.prisma.runInput.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true, externalTicketId: true, id: true },
          where: requestWhere,
        }),
        fastify.prisma.workflowRun.groupBy({
          _max: { startedAt: true },
          by: ['workRequestId'],
          where: { AND: [runVisibility, { workRequest: requestWhere }] },
        }),
      ]);
      const lastRun = new Map(runActivity.map((row) => [row.workRequestId, row._max.startedAt]));

      // A template launch with no ticket of its own files the work request's own
      // uuid as the ticket id: a correlation key, not a ticket.
      const groups = new Map<string, { ids: string[]; lastActivityAt: Date }>();
      for (const row of requests) {
        if (!includeAutomated && row.externalTicketId === row.id) {
          continue;
        }
        const at = new Date(Math.max(row.createdAt.getTime(), lastRun.get(row.id)?.getTime() ?? 0));
        const group = groups.get(row.externalTicketId);
        if (group) {
          group.ids.push(row.id);
          if (at > group.lastActivityAt) {
            group.lastActivityAt = at;
          }
        } else {
          groups.set(row.externalTicketId, { ids: [row.id], lastActivityAt: at });
        }
      }
      const ordered = [...groups.entries()].sort(
        ([ticketA, a], [ticketB, b]) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || ticketA.localeCompare(ticketB)
      );
      const page = ordered.slice(offset, offset + limit);
      const requestIds = page.flatMap(([, group]) => group.ids);

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

      const data: TicketGroup[] = page.map(([ticketId, group]) => {
        const ids = new Set(group.ids);
        const groupRuns = runs.filter((run) => run.workRequestId && ids.has(run.workRequestId));
        const runCounts: Partial<Record<WorkflowRunStatus, number>> = {};
        for (const run of groupRuns) {
          const status = run.status as WorkflowRunStatus;
          runCounts[status] = (runCounts[status] ?? 0) + 1;
        }
        // The newest visible request that carries a tracker answer.
        const snapshot = group.ids
          .map((id) => snapshots.find((item) => item.workRequestId === id))
          .find((item) => item?.rawTicketData != null);
        const ticket = readTicket(snapshot?.rawTicketData);
        return {
          costUsd: ledgers
            .filter((ledger) => ledger.workRequestId && ids.has(ledger.workRequestId))
            .reduce((sum, ledger) => sum + ledger.costUsdAccrued, 0),
          lastActivityAt: group.lastActivityAt.toISOString(),
          latestRun: groupRuns[0]
            ? { id: groupRuns[0].id, status: groupRuns[0].status as WorkflowRunStatus }
            : null,
          latestWorkRequestId: group.ids[0] as string,
          pullRequests: pullRequests
            .filter((pr) => pr.workflow?.workRequestId && ids.has(pr.workflow.workRequestId))
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
          requestCount: group.ids.length,
          runCounts,
          status: ticket.status,
          ticketId,
          title: ticket.title,
          url: ticket.url,
        };
      });
      return { data, meta: { limit, offset, total: ordered.length } };
    }
  );
};
