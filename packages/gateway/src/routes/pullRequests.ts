import { Readable } from 'node:stream';
import type { Prisma } from '@auto-swe/shared';
import {
  PULL_REQUEST_STATES,
  type PullRequestState,
  pullRequestUrl,
} from '@auto-swe/shared/lib/pullRequest';
import { summarizePullRequestOutcomes } from '@auto-swe/shared/lib/pullRequestOutcomes';
import { resolveGitHubBaseUrl } from '@auto-swe/shared/lib/systemConfig';
import type {
  PullRequestListItem,
  PullRequestOutcomesResponse,
  WorkflowRunStatus,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvRow } from '../lib/csv.js';
import { customRangeFields, refineCustomRange, resolveWindow } from '../lib/dateWindow.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  type AttributedTemplateRun,
  templateAttributionForPullRequest,
} from '../lib/pullRequestAttribution.js';
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

const OutcomesQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
    repoId: z.string().uuid().optional(),
    scope: z.enum(['MINE', 'TEAM']).default('TEAM'),
    teamId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    window: z.coerce.number().int().min(1).max(365).default(30),
  })
);

/** Most rows one outcomes read takes; one more is fetched to detect a cut. */
const OUTCOMES_ROW_CAP = 10_000;
const OUTCOMES_TOP_REPOSITORIES = 10;

const OutcomesExportQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
    format: z.enum(['csv', 'ndjson']).default('csv'),
    repoId: z.string().uuid().optional(),
    scope: z.enum(['MINE', 'TEAM']).default('TEAM'),
    teamId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    window: z.coerce.number().int().min(1).max(365).default(30),
  })
);
/** An export is a file for a person, not a backup: it stops here and says so in a header. */
const OUTCOMES_EXPORT_MAX_ROWS = 50_000;
const OUTCOMES_EXPORT_BATCH = 500;
const OUTCOMES_TEMPLATE_RUN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const OUTCOMES_EXPORT_COLUMNS = [
  'pull_request_id',
  'repository_org',
  'repository_name',
  'pr_number',
  'status',
  'is_draft',
  'ci_status',
  'opened_at',
  'merged_at',
  'closed_at',
  'time_to_merge_ms',
  'template_id',
  'template_name',
] as const;

/**
 * The pull requests an outcomes read or export covers: the ones the caller may reach, opened in
 * `[openedFrom, end)`, narrowed by the query. One definition, so the export can never reach a row
 * the summary would not.
 */
function outcomesFilters(
  user: ReturnType<typeof requireUser>,
  gate: FastifyRequest['repoAccessGate'],
  query: { repoId?: string | undefined; scope: 'MINE' | 'TEAM'; teamId?: string | undefined },
  openedFrom: Date,
  end: Date
): Prisma.PullRequestWhereInput[] {
  const filters: Prisma.PullRequestWhereInput[] = [
    user.role === 'ADMIN' ? {} : { repository: reachableConnections(user, gate) },
    { openedAt: { gte: openedFrom, lt: end } },
  ];
  if (query.repoId) {
    filters.push({ repoId: query.repoId });
  }
  if (query.teamId) {
    const { teamId } = query;
    filters.push({ repository: { OR: [{ teamId }, { shares: { some: { teamId } } }] } });
  }
  if (query.scope === 'MINE') {
    filters.push({ workflow: { workRequest: { requestedById: user.sub } } });
  }
  return filters;
}

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
      const [rows, total, instanceBaseUrl] = await Promise.all([
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
        // Where a repository that names no host of its own links its PRs.
        resolveGitHubBaseUrl(),
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
          url: row.repository
            ? pullRequestUrl(row.repository, row.prNumber, instanceBaseUrl)
            : null,
          workRequestId: ledger?.workRequest?.id ?? null,
        };
      });
      return { data, meta: { limit, offset, total } };
    }
  );

  const engineerOnly = requireAuth({ requiredRole: 'ENGINEER' });
  // Delivery metric: the cohort of PRs opened in the window, judged as of now.
  app.get(
    '/outcomes',
    {
      onRequest: engineerOnly,
      schema: { querystring: OutcomesQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { days, end, previousStart, start } = resolveWindow(
        request.query,
        request.query.window
      );
      const filters = outcomesFilters(
        user,
        request.repoAccessGate,
        request.query,
        previousStart,
        end
      );
      let templateRunsTruncated = false;
      if (request.query.templateId) {
        const templateRuns = await fastify.prisma.workflowRun.findMany({
          orderBy: { startedAt: 'desc' },
          select: { workflowId: true },
          take: OUTCOMES_EXPORT_MAX_ROWS + 1,
          where: {
            AND: [
              buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
              {
                startedAt: {
                  gte: new Date(previousStart.getTime() - OUTCOMES_TEMPLATE_RUN_LOOKBACK_MS),
                  lt: end,
                },
              },
              { templateId: request.query.templateId },
            ],
          },
        });
        templateRunsTruncated = templateRuns.length > OUTCOMES_EXPORT_MAX_ROWS;
        const workflowIds = templateRuns
          .slice(0, OUTCOMES_EXPORT_MAX_ROWS)
          .map((run) => run.workflowId);
        filters.push(
          workflowIds.length > 0
            ? { workflow: { temporalWorkflowId: { in: workflowIds } } }
            : { id: { in: [] } }
        );
      }
      const rows = await fastify.prisma.pullRequest.findMany({
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        select: {
          ciStatus: true,
          isDraft: true,
          mergedAt: true,
          openedAt: true,
          repoId: true,
          repository: { select: { id: true, organizationName: true, repoName: true } },
          status: true,
          workflow: { select: { repoId: true, temporalWorkflowId: true } },
        },
        take: OUTCOMES_ROW_CAP + 1,
        where: { AND: filters },
      });
      const capped = rows.length > OUTCOMES_ROW_CAP;
      const kept = rows.slice(0, OUTCOMES_ROW_CAP);
      const workflowIds = kept.flatMap((r) =>
        r.workflow?.temporalWorkflowId ? [r.workflow.temporalWorkflowId] : []
      );
      const runs = workflowIds.length
        ? await fastify.prisma.workflowRun.findMany({
            select: { template: { select: { name: true } }, templateId: true, workflowId: true },
            where: {
              AND: [
                buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
                { workflowId: { in: workflowIds } },
              ],
            },
          })
        : [];
      const runByWorkflowId = new Map(runs.map((r) => [r.workflowId, r]));
      const templateOf = (r: (typeof kept)[number]) =>
        templateAttributionForPullRequest(r, runByWorkflowId);
      // Newest first, so a capped read loses the previous window before this one. The extra row
      // fetched past the cap is the first one lost: this window is cut only if it is in this window.
      const firstLost = rows[OUTCOMES_ROW_CAP]?.openedAt;
      const isTruncated =
        templateRunsTruncated || (capped && firstLost !== undefined && firstLost >= start);

      const currentAll = kept.filter((r) => r.openedAt >= start);
      const previousAll = kept.filter((r) => r.openedAt < start);
      const matchesTemplate = (r: (typeof kept)[number]) =>
        !request.query.templateId || templateOf(r)?.templateId === request.query.templateId;
      const current = currentAll.filter(matchesTemplate);
      const previous = previousAll.filter(matchesTemplate);

      const byRepo = new Map<
        string,
        {
          repository: NonNullable<(typeof current)[number]['repository']>;
          rows: typeof current;
        }
      >();
      for (const row of current) {
        const repository = row.repository;
        if (!repository) {
          continue;
        }
        const group = byRepo.get(repository.id) ?? { repository, rows: [] };
        group.rows.push(row);
        byRepo.set(repository.id, group);
      }
      const byRepository = [...byRepo.values()]
        .sort((a, b) => b.rows.length - a.rows.length)
        .slice(0, OUTCOMES_TOP_REPOSITORIES)
        .map(({ repository, rows: repoRows }) => ({
          repository: {
            id: repository.id,
            name: repository.repoName ?? '',
            org: repository.organizationName ?? '',
          },
          summary: summarizePullRequestOutcomes(repoRows),
        }));
      const byTemplateGroups = new Map<
        string,
        { templateId: string | null; templateName: string; rows: typeof current }
      >();
      for (const row of current) {
        const template = templateOf(row);
        const templateId = template?.templateId ?? null;
        const key = templateId ?? '';
        const group = byTemplateGroups.get(key) ?? {
          rows: [],
          templateId,
          templateName: template?.templateName ?? 'Unattributed',
        };
        group.rows.push(row);
        byTemplateGroups.set(key, group);
      }
      const byTemplate = [...byTemplateGroups.values()]
        .map(({ rows: templateRows, ...template }) => {
          const summary = summarizePullRequestOutcomes(templateRows);
          return {
            ...template,
            closedUnmerged: summary.closedUnmerged,
            medianTimeToMergeMs: summary.timeToMergeMs.p50,
            merged: summary.merged,
            mergeRate: summary.mergeRate,
            opened: summary.opened,
          };
        })
        .sort((a, b) => b.opened - a.opened);

      const data: PullRequestOutcomesResponse = {
        byRepository,
        byTemplate,
        current: summarizePullRequestOutcomes(current),
        isTruncated,
        previous: capped ? null : summarizePullRequestOutcomes(previous),
        previousComplete: !capped,
        window: { days, end: end.toISOString(), start: start.toISOString() },
      };
      return { data };
    }
  );

  // The window's pull requests as a file for a spreadsheet or BI tool: one row per PR opened in
  // the window, newest first, the same rows `/outcomes` summarises (no previous window).
  app.get(
    '/outcomes/export',
    {
      config: { activity: 'export' },
      onRequest: engineerOnly,
      schema: { querystring: OutcomesExportQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { end, start } = resolveWindow(request.query, request.query.window);
      const where: Prisma.PullRequestWhereInput = {
        AND: outcomesFilters(user, request.repoAccessGate, request.query, start, end),
      };
      let sourceTruncated = false;
      if (request.query.templateId) {
        const templateRuns = await fastify.prisma.workflowRun.findMany({
          orderBy: { startedAt: 'desc' },
          select: { workflowId: true },
          take: OUTCOMES_EXPORT_MAX_ROWS + 1,
          where: {
            AND: [
              buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
              {
                startedAt: {
                  gte: new Date(start.getTime() - OUTCOMES_TEMPLATE_RUN_LOOKBACK_MS),
                  lt: end,
                },
              },
              { templateId: request.query.templateId },
            ],
          },
        });
        sourceTruncated = templateRuns.length > OUTCOMES_EXPORT_MAX_ROWS;
        const templateWorkflowIds = templateRuns
          .slice(0, OUTCOMES_EXPORT_MAX_ROWS)
          .map((r) => r.workflowId);
        const workflows = templateWorkflowIds.length
          ? await fastify.prisma.activeWorkflow.findMany({
              select: { repoId: true, temporalWorkflowId: true },
              take: OUTCOMES_EXPORT_MAX_ROWS + 1,
              where: { temporalWorkflowId: { in: templateWorkflowIds } },
            })
          : [];
        sourceTruncated ||= workflows.length > OUTCOMES_EXPORT_MAX_ROWS;
        const consistentLinks = workflows.slice(0, OUTCOMES_EXPORT_MAX_ROWS).map((workflow) => ({
          repoId: workflow.repoId,
          workflow: { temporalWorkflowId: workflow.temporalWorkflowId },
        }));
        (where.AND as Prisma.PullRequestWhereInput[]).push(
          consistentLinks.length > 0
            ? {
                OR: consistentLinks.map((link) => ({
                  repoId: link.repoId,
                  workflow: { temporalWorkflowId: link.workflow.temporalWorkflowId },
                })),
              }
            : { id: { in: [] } }
        );
      }
      const { format } = request.query;
      const select = {
        ciStatus: true,
        closedAt: true,
        id: true,
        isDraft: true,
        mergedAt: true,
        openedAt: true,
        prNumber: true,
        repoId: true,
        repository: { select: { organizationName: true, repoName: true } },
        status: true,
        workflow: { select: { repoId: true, temporalWorkflowId: true } },
      } satisfies Prisma.PullRequestSelect;
      const readBatch = (cursor: string | undefined) =>
        fastify.prisma.pullRequest.findMany({
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          select,
          take: OUTCOMES_EXPORT_BATCH,
          where,
        });
      type Batch = Awaited<ReturnType<typeof readBatch>>;
      const runsFor = (rows: Batch) => {
        const ids = rows.flatMap((r) =>
          r.workflow?.temporalWorkflowId ? [r.workflow.temporalWorkflowId] : []
        );
        return ids.length
          ? fastify.prisma.workflowRun.findMany({
              select: { template: { select: { name: true } }, templateId: true, workflowId: true },
              where: {
                AND: [
                  buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
                  { workflowId: { in: ids } },
                ],
              },
            })
          : Promise.resolve([]);
      };
      const cells = (r: Batch[number], runByWorkflow: Map<string, AttributedTemplateRun>) => {
        const attribution = templateAttributionForPullRequest(r, runByWorkflow);
        return [
          r.id,
          r.repository?.organizationName ?? null,
          r.repository?.repoName ?? null,
          r.prNumber,
          r.status,
          r.isDraft,
          r.ciStatus,
          r.openedAt.toISOString(),
          r.mergedAt?.toISOString() ?? null,
          r.closedAt?.toISOString() ?? null,
          r.mergedAt ? r.mergedAt.getTime() - r.openedAt.getTime() : null,
          attribution?.templateId ?? null,
          attribution?.templateName ?? null,
        ];
      };
      const encode = (r: Batch[number], runsByWorkflow: Map<string, AttributedTemplateRun>) => {
        const values = cells(r, runsByWorkflow);
        return format === 'csv'
          ? csvRow(values)
          : `${JSON.stringify(Object.fromEntries(OUTCOMES_EXPORT_COLUMNS.map((c, i) => [c, values[i]])))}\n`;
      };

      // Everything that can fail before the first byte is awaited here, so a database error is a
      // plain 500. Once streaming starts the headers are gone; see the Limitations of the doc.
      const [matching, firstBatch] = await Promise.all([
        fastify.prisma.pullRequest.count({ where }),
        readBatch(undefined),
      ]);
      const firstRuns = await runsFor(firstBatch);
      async function* lines() {
        if (format === 'csv') {
          yield csvRow(OUTCOMES_EXPORT_COLUMNS);
        }
        let rows = firstBatch;
        let runRows = firstRuns;
        let written = 0;
        while (rows.length > 0) {
          // Never write past the cap, even when it does not fall on a batch boundary.
          const runByWorkflow = new Map(runRows.map((run) => [run.workflowId, run]));
          const eligible = request.query.templateId
            ? rows.filter(
                (row) =>
                  templateAttributionForPullRequest(row, runByWorkflow)?.templateId ===
                  request.query.templateId
              )
            : rows;
          const batch = eligible.slice(0, OUTCOMES_EXPORT_MAX_ROWS - written);
          yield batch.map((row) => encode(row, runByWorkflow)).join('');
          written += batch.length;
          if (rows.length < OUTCOMES_EXPORT_BATCH || written >= OUTCOMES_EXPORT_MAX_ROWS) {
            return;
          }
          rows = await readBatch(rows[rows.length - 1]?.id);
          runRows = await runsFor(rows);
        }
      }
      return reply
        .header(
          'Content-Type',
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8'
        )
        .header(
          'Content-Disposition',
          `attachment; filename="pull-request-outcomes.${format === 'csv' ? 'csv' : 'ndjson'}"`
        )
        .header('X-Export-Row-Limit', String(OUTCOMES_EXPORT_MAX_ROWS))
        .header(
          'X-Export-Truncated',
          String(sourceTruncated || matching > OUTCOMES_EXPORT_MAX_ROWS)
        )
        .send(Readable.from(lines()));
    }
  );
};
