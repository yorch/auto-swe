import type { Prisma } from '@auto-swe/shared';
import {
  PULL_REQUEST_STATES,
  type PullRequestState,
  pullRequestUrl,
} from '@auto-swe/shared/lib/pullRequest';
import type { PullRequestListItem, WorkflowRunStatus } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const Query = paginationQuery({ defaultLimit: 50, maxLimit: 100 }).extend({
  draft: z.enum(['any', 'draft', 'ready']).default('any'),
  repoId: z.string().uuid().optional(),
  scope: z.enum(['MINE', 'TEAM']).default('MINE'),
  state: z.enum([...PULL_REQUEST_STATES, 'all']).default('all'),
  teamId: z.string().uuid().optional(),
  /** Substring match on the ticket id of the request the PR came from. */
  ticket: z.string().trim().max(200).optional(),
});

/**
 * Pull requests the platform opened, newest first.
 *
 * A row is visible when the caller may reach the PR's repository. What it
 * carries from its ledger row (ticket, request, cost, run) is read only while
 * that row is on the same repository, and the run only while the caller may
 * see the run itself.
 */
export const pullRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: Query },
    },
    async (request) => {
      const user = requireUser(request);
      const { draft, limit, offset, repoId, scope, state, teamId, ticket } = request.query;
      const filters: Prisma.PullRequestWhereInput[] = [
        user.role === 'ADMIN'
          ? {}
          : { repository: reachableConnections(user, request.repoAccessGate) },
      ];
      if (state !== 'all') {
        filters.push({ status: state });
      }
      if (draft !== 'any') {
        filters.push({ isDraft: draft === 'draft' });
      }
      if (repoId) {
        filters.push({ repoId });
      }
      if (teamId) {
        filters.push({ repository: { OR: [{ teamId }, { shares: { some: { teamId } } }] } });
      }
      if (scope === 'MINE') {
        filters.push({ workflow: { workRequest: { requestedById: user.sub } } });
      }
      if (ticket) {
        filters.push({
          workflow: {
            workRequest: { externalTicketId: { contains: ticket, mode: 'insensitive' } },
          },
        });
      }
      const where: Prisma.PullRequestWhereInput = { AND: filters };
      const [rows, total] = await Promise.all([
        fastify.prisma.pullRequest.findMany({
          include: {
            repository: {
              select: { githubUrl: true, id: true, organizationName: true, repoName: true },
            },
            workflow: {
              select: {
                costUsdAccrued: true,
                repoId: true,
                temporalWorkflowId: true,
                workRequest: { select: { externalTicketId: true, id: true } },
              },
            },
          },
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.pullRequest.count({ where }),
      ]);

      const ledgerOf = (row: (typeof rows)[number]) =>
        row.workflow && row.workflow.repoId === row.repoId ? row.workflow : null;
      const runs = await fastify.prisma.workflowRun.findMany({
        select: { id: true, status: true, workflowId: true },
        where: {
          AND: [
            buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
            {
              workflowId: {
                in: rows.flatMap((row) => ledgerOf(row)?.temporalWorkflowId ?? []),
              },
            },
          ],
        },
      });
      const runByWorkflow = new Map(runs.map((run) => [run.workflowId, run]));

      const data: PullRequestListItem[] = rows.map((row) => {
        const ledger = ledgerOf(row);
        const run = ledger ? runByWorkflow.get(ledger.temporalWorkflowId) : undefined;
        return {
          ciStatus: row.ciStatus,
          closedAt: row.closedAt?.toISOString() ?? null,
          costUsd: ledger?.costUsdAccrued ?? null,
          id: row.id,
          isDraft: row.isDraft,
          latestRun: run ? { id: run.id, status: run.status as WorkflowRunStatus } : null,
          mergedAt: row.mergedAt?.toISOString() ?? null,
          openedAt: row.openedAt.toISOString(),
          prNumber: row.prNumber,
          repository: row.repository
            ? {
                id: row.repository.id,
                name: row.repository.repoName ?? '',
                org: row.repository.organizationName ?? '',
              }
            : null,
          status: row.status as PullRequestState,
          ticketId: ledger?.workRequest?.externalTicketId ?? null,
          title: row.title,
          url: row.repository ? pullRequestUrl(row.repository, row.prNumber) : null,
          workRequestId: ledger?.workRequest?.id ?? null,
        };
      });
      return { data, meta: { limit, offset, total } };
    }
  );
};
