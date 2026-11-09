import { Readable } from 'node:stream';
import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  PULL_REQUEST_STATES,
  type PullRequestState,
  pullRequestUrl,
} from '@auto-swe/shared/lib/pullRequest';
import { summarizePullRequestOutcomes } from '@auto-swe/shared/lib/pullRequestOutcomes';
import { resolveGitHubBaseUrl } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type {
  PullRequestCockpit,
  PullRequestListItem,
  PullRequestOutcomesResponse,
  WorkflowRunStatus,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvRow } from '../lib/csv.js';
import { customRangeFields, refineCustomRange, resolveWindow } from '../lib/dateWindow.js';
import {
  COMMIT_SHA,
  type CompareResult,
  readCompare,
  readPullFiles,
} from '../lib/githubPullFiles.js';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  assembleCockpit,
  changedSinceViewed,
  draftsFor,
  sinceLastVisit,
  viewedPaths,
} from '../lib/pullRequestCockpit.js';
import { OUTCOMES_ROW_CAP, outcomesFilters } from '../lib/pullRequestOutcomesQuery.js';
import {
  type ReviewerWrite,
  resolveReviewerWrite,
  type WriteUnavailable,
} from '../lib/reviewerCredential.js';
import { repositoryTeamScope } from '../lib/runTeamScope.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { assertTeamParam } from '../lib/teamParam.js';
import { teamMembershipFilter } from '../lib/templateLaunch.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { MAX_DRAFTS_PER_PULL_REQUEST } from './pullRequestReview.js';

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

/** The host lists at most 3000 files of a pull request, so a person has at most that many marks. */
const MAX_VIEWED_PER_PULL_REQUEST = 3000;
/** Marks one request may set or clear. */
const MAX_VIEWED_PER_REQUEST = 200;

const ViewedBody = z.object({
  files: z
    .array(
      z.object({
        /** The digest the page received with the file; a mark counts only while it still matches. */
        patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
        // Short enough for a btree key (the unique index holds the path).
        path: z.string().min(1).max(500),
      })
    )
    .min(1)
    .max(MAX_VIEWED_PER_REQUEST),
  viewed: z.boolean(),
});

const writeReasonOf = (write: ReviewerWrite): WriteUnavailable | null =>
  write.available ? null : write.reason;

/** What a compare reads as for a pull request with no repository to ask. */
const NO_COMPARE: CompareResult = { reason: 'not-found', type: 'unavailable' };

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
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: Query },
    },
    async (request) => {
      const user = requireUser(request);
      if (request.query.teamId) {
        await assertTeamParam(fastify.prisma, user, request.query.teamId);
      }
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
        // Owned or shared: a list shows the work the team can open. Its own AND term, so it only narrows.
        filters.push({ repository: repositoryTeamScope(teamId) });
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
    async (request, reply) => {
      const user = requireUser(request);
      if (request.query.templateId && user.role !== 'ADMIN') {
        const visibleTemplate = await runUnscoped(
          'outcome template filters must use the workflow-template visibility rule',
          ['WorkflowTemplate'],
          () =>
            fastify.prisma.workflowTemplate.findFirst({
              select: { id: true },
              where: { AND: [{ id: request.query.templateId }, teamMembershipFilter(user)] },
            })
        );
        if (!visibleTemplate) {
          return sendError(reply, 404, 'TEMPLATE_NOT_FOUND', 'Template not found');
        }
      }
      if (request.query.teamId) {
        await assertTeamParam(fastify.prisma, user, request.query.teamId);
      }
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
          template: { select: { name: true } },
          templateId: true,
        },
        take: OUTCOMES_ROW_CAP + 1,
        where: { AND: filters },
      });
      const capped = rows.length > OUTCOMES_ROW_CAP;
      const kept = rows.slice(0, OUTCOMES_ROW_CAP);
      const visibleTemplateIds =
        user.role === 'ADMIN'
          ? null
          : new Set(
              (
                await runUnscoped(
                  'outcome template labels are limited to the caller-visible template ids',
                  ['WorkflowTemplate'],
                  () =>
                    fastify.prisma.workflowTemplate.findMany({
                      select: { id: true },
                      where: {
                        AND: [
                          teamMembershipFilter(user),
                          { id: { in: [...new Set(kept.flatMap((row) => row.templateId ?? []))] } },
                        ],
                      },
                    })
                )
              ).map((template) => template.id)
            );
      const templateOf = (r: (typeof kept)[number]) =>
        r.templateId && (visibleTemplateIds === null || visibleTemplateIds.has(r.templateId))
          ? { templateId: r.templateId, templateName: r.template?.name ?? 'Unknown' }
          : null;
      // Newest first, so a capped read loses the previous window before this one. The extra row
      // fetched past the cap is the first one lost: this window is cut only if it is in this window.
      const firstLost = rows[OUTCOMES_ROW_CAP]?.openedAt;
      const isTruncated = capped && firstLost !== undefined && firstLost >= start;

      const currentAll = kept.filter((r) => r.openedAt >= start);
      const previousAll = kept.filter((r) => r.openedAt < start);
      const matchesTemplate = (r: (typeof kept)[number]) =>
        !request.query.templateId || r.templateId === request.query.templateId;
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
      if (request.query.templateId && user.role !== 'ADMIN') {
        const visibleTemplate = await runUnscoped(
          'outcome export template filters must use the workflow-template visibility rule',
          ['WorkflowTemplate'],
          () =>
            fastify.prisma.workflowTemplate.findFirst({
              select: { id: true },
              where: { AND: [{ id: request.query.templateId }, teamMembershipFilter(user)] },
            })
        );
        if (!visibleTemplate) {
          return sendError(reply, 404, 'TEMPLATE_NOT_FOUND', 'Template not found');
        }
      }
      if (request.query.teamId) {
        await assertTeamParam(fastify.prisma, user, request.query.teamId);
      }
      const { end, start } = resolveWindow(request.query, request.query.window);
      const where: Prisma.PullRequestWhereInput = {
        AND: outcomesFilters(user, request.repoAccessGate, request.query, start, end),
      };
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
        template: { select: { name: true } },
        templateId: true,
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
      const cells = (r: Batch[number], visibleTemplateIds: Set<string>) => [
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
        user.role === 'ADMIN' || (r.templateId !== null && visibleTemplateIds.has(r.templateId))
          ? r.templateId
          : null,
        user.role === 'ADMIN' || (r.templateId !== null && visibleTemplateIds.has(r.templateId))
          ? (r.template?.name ?? null)
          : null,
      ];
      const encode = (r: Batch[number], visibleTemplateIds: Set<string>) => {
        const values = cells(r, visibleTemplateIds);
        return format === 'csv'
          ? csvRow(values)
          : `${JSON.stringify(Object.fromEntries(OUTCOMES_EXPORT_COLUMNS.map((c, i) => [c, values[i]])))}\n`;
      };
      const encodeBatch = async (batch: Batch) => {
        const ids = [...new Set(batch.flatMap((row) => row.templateId ?? []))];
        const visibleTemplateIds =
          user.role === 'ADMIN' || ids.length === 0
            ? new Set(ids)
            : new Set(
                (
                  await runUnscoped(
                    'outcome export template labels are limited to the caller-visible batch ids',
                    ['WorkflowTemplate'],
                    () =>
                      fastify.prisma.workflowTemplate.findMany({
                        select: { id: true },
                        where: { AND: [teamMembershipFilter(user), { id: { in: ids } }] },
                      })
                  )
                ).map((template) => template.id)
              );
        return batch.map((row) => encode(row, visibleTemplateIds)).join('');
      };

      // Everything that can fail before the first byte is awaited here, so a database error is a
      // plain 500. Once streaming starts the headers are gone; see the Limitations of the doc.
      const [matching, firstBatch] = await Promise.all([
        fastify.prisma.pullRequest.count({ where }),
        readBatch(undefined),
      ]);
      async function* lines() {
        if (format === 'csv') {
          yield csvRow(OUTCOMES_EXPORT_COLUMNS);
        }
        let rows = firstBatch;
        let written = 0;
        while (rows.length > 0) {
          const batch = rows.slice(0, OUTCOMES_EXPORT_MAX_ROWS - written);
          yield await encodeBatch(batch);
          written += batch.length;
          if (rows.length < OUTCOMES_EXPORT_BATCH || written >= OUTCOMES_EXPORT_MAX_ROWS) {
            return;
          }
          rows = await readBatch(rows[rows.length - 1]?.id);
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
        .header('X-Export-Truncated', String(matching > OUTCOMES_EXPORT_MAX_ROWS))
        .send(Readable.from(lines()));
    }
  );
  // GET /api/v1/pull-requests/:id/cockpit — what the review page shows: the latest stored
  // evaluation and the changed files read live from the host. A repository the caller cannot reach
  // is a 404, and the host is not asked until that has been decided.
  app.get(
    '/:id/cockpit',
    {
      onRequest: engineerOnly,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const reach =
        user.role === 'ADMIN'
          ? {}
          : { connection: reachableConnections(user, request.repoAccessGate) };
      const row = await fastify.prisma.pullRequest.findFirst({
        include: {
          repository: {
            select: {
              githubApiUrl: true,
              githubUrl: true,
              id: true,
              installation: { select: { host: true, installationId: true } },
              organizationName: true,
              repoName: true,
              team: { select: { orgId: true } },
              teamId: true,
            },
          },
          workflow: {
            select: {
              costUsdAccrued: true,
              repoId: true,
              temporalWorkflowId: true,
              workRequest: { select: { externalTicketId: true, id: true, requestedById: true } },
            },
          },
        },
        where: {
          id: request.params.id,
          ...(user.role === 'ADMIN'
            ? {}
            : { repository: reachableConnections(user, request.repoAccessGate) }),
        },
      });
      if (!row) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const ledger = row.workflow && row.workflow.repoId === row.repoId ? row.workflow : null;
      const [
        instanceBaseUrl,
        run,
        evaluation,
        files,
        viewedRows,
        visit,
        draftRows,
        reviewerWrite,
        feedbackLoopEnabled,
      ] = await Promise.all([
        resolveGitHubBaseUrl(),
        ledger
          ? fastify.prisma.workflowRun.findFirst({
              select: { id: true, launchedById: true, status: true },
              where: {
                AND: [
                  buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
                  { workflowId: ledger.temporalWorkflowId },
                ],
              },
            })
          : null,
        row.repoId !== null && row.prNumber !== null
          ? fastify.prisma.prEvaluation.findFirst({
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: {
                brief: true,
                createdAt: true,
                headSha: true,
                id: true,
                mode: true,
                reasons: true,
                requiredApprovers: true,
                riskClass: true,
                statusState: true,
              },
              where: { connectionId: row.repoId, prNumber: row.prNumber, ...reach },
            })
          : null,
        row.repository && row.prNumber !== null
          ? readPullFiles(row.repository, row.prNumber)
          : ({ reason: 'not-found', type: 'unavailable' } as const),
        // The caller's own marks only; the route has already decided they may see this pull request.
        fastify.prisma.prFileView.findMany({
          select: { patchDigest: true, path: true },
          take: MAX_VIEWED_PER_PULL_REQUEST,
          where: { pullRequestId: row.id, userId: user.sub },
        }),
        fastify.prisma.prReviewVisit.findUnique({
          select: { lastHeadSha: true, lastVisitedAt: true },
          where: { userId_pullRequestId: { pullRequestId: row.id, userId: user.sub } },
        }),
        // The caller's own unsent comments, bounded by what the draft route lets them keep.
        fastify.prisma.prReviewDraft.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            body: true,
            createdAt: true,
            headSha: true,
            id: true,
            line: true,
            patchDigest: true,
            path: true,
          },
          take: MAX_DRAFTS_PER_PULL_REQUEST,
          where: { pullRequestId: row.id, userId: user.sub },
        }),
        // Whether the caller can write as themselves; the token is dropped at once, never sent.
        row.repository
          ? resolveReviewerWrite(fastify.prisma, {
              connectionId: row.repository.id,
              userId: user.sub,
            })
          : null,
        row.repository
          ? resolveSetting('github.prFeedbackAutomationsEnabled', {
              ...(row.repository.team?.orgId ? { orgId: row.repository.team.orgId } : {}),
              teamId: row.repository.teamId,
            })
          : false,
      ]);
      const parts = assembleCockpit({ evaluation, files, storedHeadSha: row.headSha });
      const repository = row.repository;
      const since = await sinceLastVisit({
        compare: (base, head) =>
          repository ? readCompare(repository, base, head) : Promise.resolve(NO_COMPARE),
        files,
        visit,
      });
      // `pull` first: the in-app assistant keeps only the start of a long answer, and the title,
      // state and CI are what it must not lose to the patches that follow.
      const data: PullRequestCockpit = {
        pull: {
          ciStatus: row.ciStatus,
          closedAt: row.closedAt?.toISOString() ?? null,
          costUsd: ledger?.costUsdAccrued ?? null,
          headSha: row.headSha,
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
        },
        ...parts,
        changedSinceViewed: changedSinceViewed(parts.files, viewedRows),
        drafts: draftsFor(files, draftRows),
        sinceLastVisit: since,
        viewed: viewedPaths(parts.files, viewedRows),
        write: {
          // The platform sets aside the approval of whoever launched or requested the work, for the
          // whole work and not only the run shown here; this warns for the part it can see.
          approvalMayNotCount:
            user.sub === run?.launchedById || user.sub === ledger?.workRequest?.requestedById,
          available: reviewerWrite?.available ?? false,
          feedbackLoopEnabled,
          reason: reviewerWrite === null ? 'unusable' : writeReasonOf(reviewerWrite),
        },
      };
      return { data };
    }
  );
  // POST /api/v1/pull-requests/:id/visit — note that the caller has now seen this head. The page
  // sends it once per head after it has rendered, never from a refresh, so the next visit can say
  // what moved since. It names no host data, so nothing is read from the host here.
  app.post(
    '/:id/visit',
    {
      onRequest: engineerOnly,
      schema: {
        body: z.object({ headSha: z.string().regex(COMMIT_SHA) }),
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = await fastify.prisma.pullRequest.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...(user.role === 'ADMIN'
            ? {}
            : { repository: reachableConnections(user, request.repoAccessGate) }),
        },
      });
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const { headSha } = request.body;
      const now = new Date();
      await fastify.prisma.prReviewVisit.upsert({
        create: {
          firstVisitedAt: now,
          lastHeadSha: headSha,
          lastVisitedAt: now,
          pullRequestId: pull.id,
          userId: user.sub,
        },
        update: { lastHeadSha: headSha, lastVisitedAt: now },
        where: { userId_pullRequestId: { pullRequestId: pull.id, userId: user.sub } },
      });
      return { data: { recorded: true } };
    }
  );
  // PUT /api/v1/pull-requests/:id/viewed — mark files viewed, or clear the marks, for the caller
  // alone. The caller must be able to reach the pull request's repository; a mark names no host
  // data, so nothing is read from the host here.
  app.put(
    '/:id/viewed',
    {
      onRequest: engineerOnly,
      schema: { body: ViewedBody, params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = await fastify.prisma.pullRequest.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...(user.role === 'ADMIN'
            ? {}
            : { repository: reachableConnections(user, request.repoAccessGate) }),
        },
      });
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      // One mark per path in a request, the last one given.
      const byPath = new Map(request.body.files.map((f) => [f.path, f.patchDigest]));
      const paths = [...byPath.keys()];
      const mine = { pullRequestId: pull.id, userId: user.sub };
      if (!request.body.viewed) {
        const cleared = await fastify.prisma.prFileView.deleteMany({
          where: { ...mine, path: { in: paths } },
        });
        return { data: { updated: cleared.count } };
      }
      const [already, total] = await Promise.all([
        fastify.prisma.prFileView.findMany({
          select: { path: true },
          where: { ...mine, path: { in: paths } },
        }),
        fastify.prisma.prFileView.count({ where: mine }),
      ]);
      if (total + (paths.length - already.length) > MAX_VIEWED_PER_PULL_REQUEST) {
        return sendError(
          reply,
          400,
          'TOO_MANY_VIEWED_FILES',
          `At most ${MAX_VIEWED_PER_PULL_REQUEST} files can be marked viewed on one pull request`
        );
      }
      await fastify.prisma.$transaction(
        [...byPath].map(([path, patchDigest]) =>
          fastify.prisma.prFileView.upsert({
            create: { ...mine, patchDigest, path },
            update: { patchDigest, viewedAt: new Date() },
            where: { userId_pullRequestId_path: { ...mine, path } },
          })
        )
      );
      return { data: { updated: paths.length } };
    }
  );
};
