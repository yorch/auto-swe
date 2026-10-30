import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import {
  matchingActiveWorkflows,
  withMatchingActiveWorkflow,
} from '@auto-swe/shared/lib/runActiveWorkflows';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  buildHumanStepDailyRollups,
  buildReviewVerdictDailyRollups,
  buildWorkflowRunDailyRollups,
  computeAutomationReport,
  computeHitlReport,
  computeQualityReport,
  deliveryReportFromRollups,
  humanStepMetricsFromRollups,
  qualityMetricsFromRollups,
  qualityReviewFromRollups,
  WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
  workflowRunRollupInputFromRun,
} from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { customRangeFields, refineCustomRange, resolveWindow } from '../lib/dateWindow.js';
import { mapLimited } from '../lib/mapLimited.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { teamMembershipFilter } from '../lib/templateLaunch.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { planWindow } from '../lib/usageWindows.js';
import {
  resolveWorkflowRunAttributionScope,
  workflowRunAttributionWhere,
  workflowRunRollupAttributionWhere,
} from '../lib/workflowRunAttributionScope.js';
import {
  coveredHumanStepRollupDays,
  coveredReviewVerdictRollupDays,
  coveredWorkflowRunRollupDays,
  requestedAtWhere,
  startedAtWhere,
  workflowRunRollupHorizonMs,
} from '../lib/workflowRunRollupWindows.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const REPORT_ROW_CAP = 10_000;
const REPORT_WINDOW_DAYS = [7, 30, 90] as const;
const ReportQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
    teamId: z.string().uuid().optional(),
    window: z.coerce
      .number()
      .int()
      .refine((n) => (REPORT_WINDOW_DAYS as readonly number[]).includes(n), {
        message: `window must be one of ${REPORT_WINDOW_DAYS.join(', ')}`,
      })
      .default(30),
  })
);

function reportWindow(query: z.infer<typeof ReportQuery>) {
  const { end, start } = resolveWindow(query, query.window);
  return { end, start, windowEnd: end.toISOString(), windowStart: start.toISOString() };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function inRanges(date: Date, ranges: readonly { gte: Date; lt: Date }[]): boolean {
  return ranges.some((range) => date >= range.gte && date < range.lt);
}

function numericCategoryCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([category, count]) =>
      typeof count === 'number' && Number.isFinite(count) ? [[category, count]] : []
    )
  );
}

export const reportsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const readAnalytics = requireAuth({ requiredRole: 'ENGINEER' });

  app.get(
    '/delivery',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const scope = await resolveWorkflowRunAttributionScope(
        fastify.prisma,
        user,
        request.repoAccessGate,
        request.query.teamId
      );
      if (!scope.authorized) {
        return reply.status(403).send({ error: 'Team report access is not authorized' });
      }
      const nowMs = Date.now();
      const covered = await coveredWorkflowRunRollupDays(
        fastify.prisma,
        range.start.getTime(),
        range.end.getTime(),
        nowMs
      );
      const plan = planWindow(
        range.start.getTime(),
        range.end.getTime(),
        covered,
        workflowRunRollupHorizonMs(nowMs)
      );
      const rollupRows = plan.rollupDays.length
        ? await runUnscoped(
            'delivery rollups are filtered by the caller attribution scope',
            ['WorkflowRunDailyRollup'],
            () =>
              fastify.prisma.workflowRunDailyRollup.findMany({
                where: {
                  AND: [
                    {
                      bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
                      day: { in: plan.rollupDays },
                    },
                    workflowRunRollupAttributionWhere(scope),
                  ],
                },
              })
          )
        : [];
      const liveRunsResult = plan.live.length
        ? await runUnscoped(
            'delivery live rows are filtered by the same caller attribution scope as rollups',
            ['WorkflowRun'],
            () =>
              fastify.prisma.workflowRun.findMany({
                orderBy: { startedAt: 'desc' },
                select: {
                  attributedOrgId: true,
                  attributedRepoId: true,
                  attributedTeamId: true,
                  costUsdAccrued: true,
                  endedAt: true,
                  estimatedHumanTimeSaved: true,
                  hadHumanStep: true,
                  hasError: true,
                  id: true,
                  outcomeDomain: true,
                  outcomeType: true,
                  startedAt: true,
                  status: true,
                  templateId: true,
                  templateVersion: true,
                  wasAutonomous: true,
                  workflowId: true,
                },
                take: REPORT_ROW_CAP + 1,
                where: {
                  AND: [startedAtWhere(plan.live), workflowRunAttributionWhere(scope)],
                },
              })
          )
        : [];
      const runsTruncated = liveRunsResult.length > REPORT_ROW_CAP;
      const liveRuns = liveRunsResult.slice(0, REPORT_ROW_CAP);
      const runIds = liveRuns.map((run) => run.id);
      const ledgerRows = await matchingActiveWorkflows(
        fastify.prisma,
        liveRuns.map((run) => run.workflowId)
      );
      const [pullRequests, fixSteps] = await Promise.all([
        runIds.length
          ? runUnscoped(
              'delivery joins PRs only for caller-visible live cohort runs',
              ['PullRequest'],
              () =>
                fastify.prisma.pullRequest.findMany({
                  orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
                  select: { ciStatus: true, mergedAt: true, runId: true, status: true },
                  take: REPORT_ROW_CAP + 1,
                  where: { runId: { in: runIds } },
                })
            )
          : [],
        runIds.length
          ? runUnscoped(
              'delivery counts steps only for caller-visible live cohort runs',
              ['WorkflowStep'],
              () =>
                fastify.prisma.workflowStep.findMany({
                  orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                  select: { runId: true, status: true },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    runId: { in: runIds },
                    status: { in: ['PASSED', 'FAILED'] },
                    stepName: 'executeCIFixImplementation',
                  },
                })
            )
          : [],
      ]);
      const prsTruncated = pullRequests.length > REPORT_ROW_CAP;
      const ciFixStepsTruncated = fixSteps.length > REPORT_ROW_CAP;
      const prsByRun = new Map<
        string,
        Array<{ ciStatus: string; mergedAt: Date | null; status: string }>
      >();
      for (const pr of pullRequests.slice(0, REPORT_ROW_CAP)) {
        if (pr.runId) {
          const group = prsByRun.get(pr.runId) ?? [];
          group.push({ ciStatus: pr.ciStatus, mergedAt: pr.mergedAt, status: pr.status });
          prsByRun.set(pr.runId, group);
        }
      }
      const ciRoundsByRun = new Map<string, number>();
      for (const step of fixSteps.slice(0, REPORT_ROW_CAP)) {
        ciRoundsByRun.set(step.runId, (ciRoundsByRun.get(step.runId) ?? 0) + 1);
      }
      const liveRunInputs = liveRuns.map((run) =>
        workflowRunRollupInputFromRun(withMatchingActiveWorkflow(run, ledgerRows))
      );
      const liveRollups = buildWorkflowRunDailyRollups({
        now: new Date(),
        pullRequests: liveRuns.flatMap((run) =>
          (prsByRun.get(run.id) ?? []).map((pr) => ({
            ciStatus: pr.ciStatus,
            mergedAt: pr.mergedAt,
            runId: run.id,
            status: pr.status,
          }))
        ),
        runs: liveRunInputs,
        steps: fixSteps.slice(0, REPORT_ROW_CAP).map((step) => ({
          runId: step.runId,
          status: step.status,
          stepName: 'executeCIFixImplementation',
        })),
        traces: [],
      });
      const allRows = [...rollupRows, ...liveRollups];
      const exactLiveMergeDurations =
        rollupRows.length === 0
          ? liveRunInputs.flatMap((run) =>
              (prsByRun.get(run.id) ?? []).flatMap((pr) =>
                pr.status === 'MERGED' && pr.mergedAt
                  ? [
                      {
                        durationMs: Math.max(0, pr.mergedAt.getTime() - run.startedAt.getTime()),
                        repoId: run.repoId,
                        teamId: run.attributedTeamId,
                        templateId: run.templateId,
                      },
                    ]
                  : []
              )
            )
          : undefined;
      const [repos, teams, templates] = await Promise.all([
        runUnscoped(
          'delivery labels are resolved only for IDs present in caller-scoped rollups',
          ['Connection'],
          () =>
            fastify.prisma.connection.findMany({
              select: { id: true, organizationName: true, repoName: true },
              where: {
                AND: [
                  {
                    id: { in: unique(allRows.flatMap((row) => (row.repoId ? [row.repoId] : []))) },
                  },
                  reachableConnections(user, request.repoAccessGate),
                ],
              },
            })
        ),
        runUnscoped(
          'delivery team labels are resolved only for caller-scoped rollup team IDs',
          ['Team'],
          () =>
            fastify.prisma.team.findMany({
              select: { id: true, name: true },
              where: {
                AND: [
                  {
                    id: { in: unique(allRows.flatMap((row) => (row.teamId ? [row.teamId] : []))) },
                  },
                  user.role === 'ADMIN'
                    ? {}
                    : {
                        OR: [{ id: { in: scope.teamIds } }, { orgId: { in: scope.orgIds } }],
                      },
                ],
              },
            })
        ),
        runUnscoped(
          'delivery template labels are resolved only for caller-scoped rollup template IDs',
          ['WorkflowTemplate'],
          () =>
            fastify.prisma.workflowTemplate.findMany({
              select: { id: true, name: true },
              where: {
                AND: [
                  {
                    id: {
                      in: unique(
                        allRows.flatMap((row) => (row.templateId ? [row.templateId] : []))
                      ),
                    },
                  },
                  teamMembershipFilter(user),
                ],
              },
            })
        ),
      ]);
      const repoNames = new Map(
        unique(allRows.flatMap((row) => (row.repoId ? [row.repoId] : []))).map((repoId) => [
          repoId,
          'Inaccessible repository',
        ])
      );
      for (const repo of repos) {
        repoNames.set(
          repo.id,
          [repo.organizationName, repo.repoName].filter(Boolean).join('/') || repo.id
        );
      }
      const templateNames = new Map(
        unique(allRows.flatMap((row) => (row.templateId ? [row.templateId] : []))).map(
          (templateId) => [templateId, 'Private template']
        )
      );
      for (const template of templates) {
        templateNames.set(template.id, template.name);
      }
      const otherTeamId = '__other_team__';
      const visibleTeamIds = new Set(teams.map((team) => team.id));
      const reportRows = allRows.map((row) =>
        row.teamId && !visibleTeamIds.has(row.teamId) ? { ...row, teamId: otherTeamId } : row
      );
      const reportMergeDurations = exactLiveMergeDurations?.map((merge) =>
        merge.teamId && !visibleTeamIds.has(merge.teamId)
          ? { ...merge, teamId: otherTeamId }
          : merge
      );
      const deliveryReport = deliveryReportFromRollups(
        reportRows,
        {
          repos: repoNames,
          teams: new Map([
            ...teams.map((team) => [team.id, team.name] as const),
            [otherTeamId, 'Other team'],
          ]),
          templates: templateNames,
        },
        reportMergeDurations
      );
      const report = {
        ...deliveryReport,
        byTeam: deliveryReport.byTeam.map((team) =>
          team.teamId === otherTeamId ? { ...team, teamId: null } : team
        ),
      };
      return {
        data: {
          ...report,
          ciFixStepsTruncated,
          liveDays: plan.live.reduce(
            (sum, live) => sum + (live.lt.getTime() - live.gte.getTime()) / 86_400_000,
            0
          ),
          prsTruncated,
          rollupDays: plan.rollupDays.length,
          runsTruncated,
          truncated: runsTruncated || prsTruncated || ciFixStepsTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
        },
      };
    }
  );

  app.get(
    '/quality',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const scope = await resolveWorkflowRunAttributionScope(
        fastify.prisma,
        user,
        request.repoAccessGate,
        request.query.teamId
      );
      if (!scope.authorized) {
        return reply.status(403).send({ error: 'Team report access is not authorized' });
      }
      const runRows = await asPlatformAdmin(
        user,
        'admin quality report spans every tenant',
        ['WorkflowRun'],
        () =>
          fastify.prisma.workflowRun.findMany({
            orderBy: { startedAt: 'desc' },
            select: {
              attributedOrgId: true,
              attributedRepoId: true,
              attributedTeamId: true,
              id: true,
              launchedById: true,
              startedAt: true,
              templateId: true,
              workflowId: true,
            },
            take: REPORT_ROW_CAP + 1,
            where: {
              AND: [
                { startedAt: { gte: range.start, lt: range.end } },
                workflowRunAttributionWhere(scope),
              ],
            },
          })
      );
      const runsTruncated = runRows.length > REPORT_ROW_CAP;
      const runs = runRows.slice(0, REPORT_ROW_CAP);
      const runIds = runs.map((run) => run.id);
      const nowMs = Date.now();
      const reviewCovered = await coveredReviewVerdictRollupDays(
        fastify.prisma,
        range.start.getTime(),
        range.end.getTime(),
        nowMs
      );
      const reviewPlan = planWindow(
        range.start.getTime(),
        range.end.getTime(),
        reviewCovered,
        workflowRunRollupHorizonMs(nowMs)
      );
      const liveReviewRunIds = runs
        .filter((run) => inRanges(run.startedAt, reviewPlan.live))
        .map((run) => run.id);
      const [steps, pullRequests, traces] = await Promise.all([
        runIds.length
          ? runUnscoped(
              'quality report groups steps only for visible cohort runs',
              ['WorkflowStep'],
              () =>
                fastify.prisma.workflowStep.groupBy({
                  _count: { _all: true },
                  by: ['runId', 'stepName', 'status'],
                  orderBy: [{ runId: 'asc' }, { stepName: 'asc' }, { status: 'asc' }],
                  where: {
                    runId: { in: runIds },
                    stepName: {
                      in: [
                        'runLint',
                        'runTypecheck',
                        'runTests',
                        'runBuild',
                        'runVulnScan',
                        'runPerfBench',
                        'executeGateFixImplementation',
                        'executeReviewFixImplementation',
                        'executeCIFixImplementation',
                      ],
                    },
                  },
                })
            )
          : [],
        runIds.length
          ? runUnscoped(
              'quality report joins only run ids visible to the caller',
              ['PullRequest'],
              () =>
                fastify.prisma.pullRequest.findMany({
                  orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
                  select: {
                    ciStatus: true,
                    mergedAt: true,
                    runId: true,
                  },
                  take: REPORT_ROW_CAP + 1,
                  where: { runId: { in: runIds } },
                })
            )
          : [],
        liveReviewRunIds.length
          ? runUnscoped(
              'quality report reads review traces only for visible cohort runs',
              ['AgentTrace'],
              () =>
                fastify.prisma.agentTrace.findMany({
                  orderBy: { createdAt: 'desc' },
                  select: { error: true, outputJson: true, runId: true },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    agentKey: 'reviewer',
                    error: null,
                    nodeId: 'runReviewNetwork',
                    runId: { in: liveReviewRunIds },
                    type: 'llm_response',
                  },
                })
            )
          : [],
      ]);
      const covered = await coveredWorkflowRunRollupDays(
        fastify.prisma,
        range.start.getTime(),
        range.end.getTime(),
        nowMs
      );
      const plan = planWindow(
        range.start.getTime(),
        range.end.getTime(),
        covered,
        workflowRunRollupHorizonMs(nowMs)
      );
      const [rollupRows, metricRunRows] = await Promise.all([
        plan.rollupDays.length
          ? runUnscoped(
              'quality rollups use the same persisted attribution scope as live metric rows',
              ['WorkflowRunDailyRollup'],
              () =>
                fastify.prisma.workflowRunDailyRollup.findMany({
                  where: {
                    AND: [
                      {
                        bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
                        day: { in: plan.rollupDays },
                      },
                      workflowRunRollupAttributionWhere(scope),
                    ],
                  },
                })
            )
          : Promise.resolve([]),
        plan.live.length
          ? runUnscoped(
              'quality live metric rows use the same persisted attribution scope as rollups',
              ['WorkflowRun'],
              () =>
                fastify.prisma.workflowRun.findMany({
                  orderBy: { startedAt: 'desc' },
                  select: {
                    attributedOrgId: true,
                    attributedRepoId: true,
                    attributedTeamId: true,
                    costUsdAccrued: true,
                    endedAt: true,
                    estimatedHumanTimeSaved: true,
                    hadHumanStep: true,
                    id: true,
                    launchedById: true,
                    outcomeDomain: true,
                    outcomeType: true,
                    startedAt: true,
                    status: true,
                    templateId: true,
                    templateVersion: true,
                    wasAutonomous: true,
                  },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    AND: [startedAtWhere(plan.live), workflowRunAttributionWhere(scope)],
                  },
                })
            )
          : Promise.resolve([]),
      ]);
      const reviewRollupRows = reviewPlan.rollupDays.length
        ? await runUnscoped(
            'quality reviewer rollups use the persisted attribution scope',
            ['ReviewVerdictDailyRollup'],
            () =>
              fastify.prisma.reviewVerdictDailyRollup.findMany({
                where: {
                  AND: [
                    {
                      bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
                      day: { in: reviewPlan.rollupDays },
                    },
                    workflowRunRollupAttributionWhere(scope),
                  ],
                },
              })
          )
        : [];
      const metricRunsTruncated = metricRunRows.length > REPORT_ROW_CAP;
      const metricRuns = metricRunRows.slice(0, REPORT_ROW_CAP);
      const metricRunIds = metricRuns.map((run) => run.id);
      const [metricPrsResult, metricStepsResult, metricTracesResult] = await Promise.all([
        metricRunIds.length
          ? runUnscoped(
              'quality live PR metrics are limited to caller-scoped runs',
              ['PullRequest'],
              () =>
                fastify.prisma.pullRequest.findMany({
                  orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
                  select: { ciStatus: true, mergedAt: true, runId: true, status: true },
                  take: REPORT_ROW_CAP + 1,
                  where: { runId: { in: metricRunIds } },
                })
            )
          : Promise.resolve([]),
        metricRunIds.length
          ? runUnscoped(
              'quality live CI-fix metrics are limited to caller-scoped runs',
              ['WorkflowStep'],
              () =>
                fastify.prisma.workflowStep.findMany({
                  orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                  select: { runId: true, status: true },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    runId: { in: metricRunIds },
                    status: { in: ['PASSED', 'FAILED'] },
                    stepName: 'executeCIFixImplementation',
                  },
                })
            )
          : Promise.resolve([]),
        metricRunIds.length
          ? runUnscoped(
              'quality live review metrics are limited to caller-scoped runs',
              ['AgentTrace'],
              () =>
                fastify.prisma.agentTrace.findMany({
                  orderBy: { createdAt: 'desc' },
                  select: { error: true, outputJson: true, runId: true },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    agentKey: 'reviewer',
                    nodeId: 'runReviewNetwork',
                    runId: { in: metricRunIds },
                    type: 'llm_response',
                  },
                })
            )
          : Promise.resolve([]),
      ]);
      const metricPrsTruncated = metricPrsResult.length > REPORT_ROW_CAP;
      const metricStepsTruncated = metricStepsResult.length > REPORT_ROW_CAP;
      const metricTracesTruncated = metricTracesResult.length > REPORT_ROW_CAP;
      const metricPrs = metricPrsResult.slice(0, REPORT_ROW_CAP);
      const metricSteps = metricStepsResult.slice(0, REPORT_ROW_CAP);
      const metricTraces = metricTracesResult.slice(0, REPORT_ROW_CAP);
      const metricRunsRollup = buildWorkflowRunDailyRollups({
        pullRequests: metricPrs.flatMap((pr) =>
          pr.runId
            ? [{ ciStatus: pr.ciStatus, mergedAt: pr.mergedAt, runId: pr.runId, status: pr.status }]
            : []
        ),
        runs: metricRuns.map((run) => ({
          attributedOrgId: run.attributedOrgId,
          attributedTeamId: run.attributedTeamId,
          costUsdAccrued: Number(run.costUsdAccrued),
          endedAt: run.endedAt,
          estimatedHumanTimeSaved: run.estimatedHumanTimeSaved,
          hadHumanStep: run.hadHumanStep,
          id: run.id,
          launchedById: run.launchedById,
          outcomeDomain: run.outcomeDomain,
          outcomeType: run.outcomeType,
          repoId: run.attributedRepoId,
          startedAt: run.startedAt,
          status: run.status,
          templateId: run.templateId,
          templateVersion: run.templateVersion,
          wasAutonomous: run.wasAutonomous,
        })),
        steps: metricSteps.map((step) => ({
          runId: step.runId,
          status: step.status,
          stepName: 'executeCIFixImplementation',
        })),
        traces: metricTraces.map((trace) => ({
          error: trace.error,
          outputJson: trace.outputJson,
          runId: trace.runId,
        })),
      });
      const metricRollups = [...rollupRows, ...metricRunsRollup];
      const prsTruncated = pullRequests.length > REPORT_ROW_CAP;
      const liveReviewRuns = runs.filter((run) => inRanges(run.startedAt, reviewPlan.live));
      const liveReviewTraces = traces;
      const tracesTruncated = liveReviewTraces.length > REPORT_ROW_CAP;
      const reportPrs = pullRequests.slice(0, REPORT_ROW_CAP).flatMap((pr) => {
        if (!pr.runId) {
          return [];
        }
        return [{ ciStatus: pr.ciStatus, mergedAt: pr.mergedAt, runId: pr.runId }];
      });
      const report = computeQualityReport({
        pullRequests: reportPrs,
        reviewTraces: liveReviewTraces.slice(0, REPORT_ROW_CAP).map((trace) => ({
          error: trace.error,
          outputJson: trace.outputJson,
          runId: trace.runId,
        })),
        runs: runs.map((run) => ({ id: run.id })),
        steps: steps.map((step) => ({
          count: step._count._all,
          runId: step.runId,
          status: step.status,
          stepName: step.stepName,
        })),
      });
      const reviewerRollups = [
        ...reviewRollupRows.map((row) => ({
          ...row,
          categoryCounts: numericCategoryCounts(row.categoryCounts),
        })),
        ...buildReviewVerdictDailyRollups({
          runs: liveReviewRuns.map((run) => ({
            attributedOrgId: run.attributedOrgId,
            attributedTeamId: run.attributedTeamId,
            id: run.id,
            launchedById: run.launchedById,
            repoId: run.attributedRepoId,
            startedAt: run.startedAt,
          })),
          traces: liveReviewTraces.slice(0, REPORT_ROW_CAP).map((trace) => ({
            error: trace.error,
            outputJson: trace.outputJson,
            runId: trace.runId,
          })),
        }),
      ];
      report.review = qualityReviewFromRollups(reviewerRollups);
      Object.assign(report, qualityMetricsFromRollups(metricRollups));
      return {
        data: {
          ...report,
          liveDays: plan.live.reduce(
            (sum, live) => sum + (live.lt.getTime() - live.gte.getTime()) / 86_400_000,
            0
          ),
          metricPrsTruncated,
          metricRunsTruncated,
          metricStepsTruncated,
          metricTracesTruncated,
          prsTruncated,
          rollupDays: plan.rollupDays.length,
          runsTruncated,
          tracesTruncated,
          truncated:
            runsTruncated ||
            prsTruncated ||
            tracesTruncated ||
            metricRunsTruncated ||
            metricPrsTruncated ||
            metricStepsTruncated ||
            metricTracesTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
        },
      };
    }
  );

  app.get(
    '/budget',
    { onRequest: requireAuth(), schema: { querystring: ReportQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const organizations =
        user.role === 'ADMIN'
          ? await asPlatformAdmin(
              user,
              'admin budget report spans every organization',
              ['Organization'],
              () =>
                fastify.prisma.organization.findMany({
                  orderBy: { name: 'asc' },
                  select: {
                    budgetAlertThresholdPercent: true,
                    id: true,
                    monthlyBudgetUsdCents: true,
                    name: true,
                  },
                  take: REPORT_ROW_CAP + 1,
                })
            )
          : await fastify.prisma.organization.findMany({
              orderBy: { name: 'asc' },
              select: {
                budgetAlertThresholdPercent: true,
                id: true,
                monthlyBudgetUsdCents: true,
                name: true,
              },
              take: REPORT_ROW_CAP + 1,
              where: { memberships: { some: { role: 'ORG_ADMIN', userId: user.sub } } },
            });
      if (user.role !== 'ADMIN' && organizations.length === 0) {
        return reply.status(403).send({ error: 'ORG_ADMIN membership is required' });
      }
      const scope = await resolveWorkflowRunAttributionScope(
        fastify.prisma,
        user,
        request.repoAccessGate
      );
      const organizationsTruncated = organizations.length > REPORT_ROW_CAP;
      const orgs = organizations.slice(0, REPORT_ROW_CAP);
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const orgReports = await mapLimited(orgs, 3, async (org) => {
        const [spend, topRunRows] = await Promise.all([
          orgMonthSpend(fastify.prisma, org.id),
          asPlatformAdmin(
            user,
            'budget top runs are scoped to an organization',
            ['WorkflowRun'],
            () =>
              fastify.prisma.workflowRun.findMany({
                orderBy: { costUsdAccrued: 'desc' },
                select: {
                  costUsdAccrued: true,
                  id: true,
                  startedAt: true,
                  status: true,
                  workflowId: true,
                },
                take: 6,
                where: {
                  AND: [
                    {
                      attributedOrgId: org.id,
                      startedAt: { gte: monthStart, lt: monthEnd },
                    },
                    workflowRunAttributionWhere(scope),
                  ],
                },
              })
          ),
        ]);
        const forecast = forecastMonthlyBudget({
          alertThresholdPercent: org.budgetAlertThresholdPercent,
          monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
          now,
          spendUsd: spend.totalUsd,
        });
        return {
          ...forecast,
          monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
          mtdUsd: spend.totalUsd,
          name: org.name,
          orgId: org.id,
          topRuns: topRunRows.slice(0, 5).map((run) => ({
            costUsd: Number(run.costUsdAccrued),
            id: run.id,
            startedAt: run.startedAt,
            status: run.status,
            workflowId: run.workflowId,
          })),
          topRunsTruncated: topRunRows.length > 5,
        };
      });
      return {
        data: {
          organizations: orgReports,
          truncated: organizationsTruncated,
          windowEnd: monthEnd.toISOString(),
          windowStart: monthStart.toISOString(),
        },
      };
    }
  );

  app.get(
    '/automations',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const scope = await resolveWorkflowRunAttributionScope(
        fastify.prisma,
        user,
        request.repoAccessGate,
        request.query.teamId
      );
      if (!scope.authorized) {
        return reply.status(403).send({ error: 'Team report access is not authorized' });
      }
      // A non-member team filter is authorized only through an org with analytics.orgWideReports
      // enabled, so that org-wide grant (like ADMIN) sees every automation of the filtered team.
      const teamWide =
        user.role === 'ADMIN' ||
        (!!request.query.teamId && !scope.teamIds.includes(request.query.teamId));
      const accessibleAutomations = await runUnscoped(
        'automation reports follow the automation list repository and team scopes',
        ['Automation'],
        () =>
          fastify.prisma.automation.findMany({
            orderBy: { id: 'asc' },
            select: { connectionId: true, id: true, teamId: true },
            take: REPORT_ROW_CAP + 1,
            where: {
              AND: [
                teamWide
                  ? {}
                  : {
                      OR: [
                        { connection: reachableConnections(user, request.repoAccessGate) },
                        {
                          connectionId: null,
                          team: { memberships: { some: { userId: user.sub } } },
                        },
                      ],
                    },
                request.query.teamId
                  ? {
                      OR: [
                        { teamId: request.query.teamId },
                        { connection: { teamId: request.query.teamId } },
                      ],
                    }
                  : {},
              ],
            },
          })
      );
      const automationsTruncated = accessibleAutomations.length > REPORT_ROW_CAP;
      const visibleAutomationIds = accessibleAutomations
        .slice(0, REPORT_ROW_CAP)
        .map((automation) => automation.id);
      const fireRows = await runUnscoped(
        'automation fires are limited to the caller visible automation ids',
        ['AutomationFire'],
        () =>
          fastify.prisma.automationFire.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
              automation: { select: { enabled: true, name: true } },
              automationId: true,
              createdAt: true,
              outcome: true,
              reason: true,
              temporalWorkflowId: true,
            },
            take: REPORT_ROW_CAP + 1,
            where: {
              createdAt: { gte: range.start, lt: range.end },
              ...(user.role === 'ADMIN' && !request.query.teamId
                ? {}
                : { automationId: { in: visibleAutomationIds } }),
            },
          })
      );
      const firesTruncated = fireRows.length > REPORT_ROW_CAP;
      const fires = fireRows.slice(0, REPORT_ROW_CAP);
      const startedWorkflowIds = unique(
        fires.flatMap((fire) =>
          fire.outcome === 'STARTED' && fire.temporalWorkflowId ? [fire.temporalWorkflowId] : []
        )
      );
      const runRows = startedWorkflowIds.length
        ? await runUnscoped(
            'automation fire ids were authorized before produced-run lookup',
            ['WorkflowRun'],
            () =>
              fastify.prisma.workflowRun.findMany({
                orderBy: { workflowId: 'asc' },
                select: { status: true, workflowId: true },
                take: REPORT_ROW_CAP + 1,
                where: { workflowId: { in: startedWorkflowIds } },
              })
          )
        : [];
      const producedRunsTruncated = runRows.length > REPORT_ROW_CAP;
      const runStatuses = new Map(runRows.map((run) => [run.workflowId, run.status]));
      const report = computeAutomationReport(
        fires.map((fire) => ({
          automationEnabled: fire.automation?.enabled ?? null,
          automationId: fire.automationId,
          automationName: fire.automation?.name ?? null,
          createdAt: fire.createdAt,
          outcome: fire.outcome,
          reason: fire.reason,
          temporalWorkflowId: fire.temporalWorkflowId,
        })),
        runStatuses
      );
      return {
        data: {
          automations: report,
          automationsTruncated,
          firesTruncated,
          producedRunsTruncated,
          truncated: automationsTruncated || firesTruncated || producedRunsTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
        },
      };
    }
  );

  app.get(
    '/hitl',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request, reply) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const scope = await resolveWorkflowRunAttributionScope(
        fastify.prisma,
        user,
        request.repoAccessGate,
        request.query.teamId
      );
      if (!scope.authorized) {
        return reply.status(403).send({ error: 'Team report access is not authorized' });
      }
      const nowMs = Date.now();
      const covered = await coveredHumanStepRollupDays(
        fastify.prisma,
        range.start.getTime(),
        range.end.getTime(),
        nowMs
      );
      const hitlPlan = planWindow(
        range.start.getTime(),
        range.end.getTime(),
        covered,
        workflowRunRollupHorizonMs(nowMs)
      );
      const visibleRun = workflowRunAttributionWhere(scope);
      const [windowSteps, pendingCount, pendingOldest, decisions, hitlRollupRows] =
        await Promise.all([
          asPlatformAdmin(user, 'admin HITL report spans every tenant', ['WorkflowHumanStep'], () =>
            fastify.prisma.workflowHumanStep.findMany({
              orderBy: { requestedAt: 'desc' },
              select: {
                kind: true,
                requestedAt: true,
                resolvedAt: true,
                resolvedBy: true,
                resolvedVia: true,
                status: true,
              },
              take: REPORT_ROW_CAP + 1,
              where: {
                AND: [requestedAtWhere(hitlPlan.live), { run: visibleRun }],
              },
            })
          ),
          asPlatformAdmin(
            user,
            'admin pending approval report spans every tenant',
            ['WorkflowHumanStep'],
            () =>
              fastify.prisma.workflowHumanStep.count({
                where: {
                  run: visibleRun,
                  status: 'PENDING',
                },
              })
          ),
          asPlatformAdmin(
            user,
            'admin pending approval age spans every tenant',
            ['WorkflowHumanStep'],
            () =>
              fastify.prisma.workflowHumanStep.findFirst({
                orderBy: { requestedAt: 'asc' },
                select: { requestedAt: true },
                where: {
                  run: visibleRun,
                  status: 'PENDING',
                },
              })
          ),
          asPlatformAdmin(
            user,
            'admin autonomy report spans every tenant',
            ['AutonomyDecision'],
            () =>
              fastify.prisma.autonomyDecision.findMany({
                orderBy: { createdAt: 'desc' },
                select: { event: true, riskClass: true },
                take: REPORT_ROW_CAP + 1,
                where: {
                  createdAt: { gte: range.start, lt: range.end },
                  run: visibleRun,
                },
              })
          ),
          hitlPlan.rollupDays.length
            ? runUnscoped(
                'HITL rollups use the same persisted attribution scope as live steps',
                ['HumanStepDailyRollup'],
                () =>
                  fastify.prisma.humanStepDailyRollup.findMany({
                    where: {
                      AND: [
                        {
                          bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
                          day: { in: hitlPlan.rollupDays },
                        },
                        workflowRunRollupAttributionWhere(scope),
                      ],
                    },
                  })
              )
            : Promise.resolve([]),
        ]);
      const approverIds = unique([
        ...hitlRollupRows.flatMap((row) => (row.resolvedBy ? [row.resolvedBy] : [])),
        ...windowSteps.flatMap((step) => (step.resolvedBy ? [step.resolvedBy] : [])),
      ]);
      const approverNames = new Map<string, string | null>(
        approverIds.map((id) => [id, user.role === 'ADMIN' ? 'Unknown approver' : 'Other approver'])
      );
      const visibleApproverIds = new Set<string>();
      if (approverIds.length) {
        const visibleApprovers = await runUnscoped(
          'HITL approver labels are resolved only for caller-visible users',
          ['User'],
          () =>
            fastify.prisma.user.findMany({
              select: { id: true, name: true },
              where: {
                AND: [
                  { id: { in: approverIds } },
                  user.role === 'ADMIN'
                    ? {}
                    : {
                        OR: [
                          { id: { in: [user.sub] } },
                          ...(scope.teamIds.length
                            ? [{ memberships: { some: { teamId: { in: scope.teamIds } } } }]
                            : []),
                          ...(scope.orgIds.length
                            ? [{ orgMemberships: { some: { orgId: { in: scope.orgIds } } } }]
                            : []),
                        ],
                      },
                ],
              },
            })
        );
        for (const approver of visibleApprovers) {
          visibleApproverIds.add(approver.id);
          approverNames.set(approver.id, approver.name);
        }
      }
      const otherApproverId = '__other_approver__';
      if (user.role !== 'ADMIN') {
        approverNames.set(otherApproverId, 'Other approver');
      }
      const reportApproverId = (id: string | null) =>
        user.role !== 'ADMIN' && id && !visibleApproverIds.has(id) ? otherApproverId : id;
      const liveWindowSteps = windowSteps.slice(0, REPORT_ROW_CAP).map((step) => ({
        kind: step.kind,
        requestedAt: step.requestedAt,
        resolvedAt: step.resolvedAt,
        resolvedBy: reportApproverId(step.resolvedBy),
        resolvedByName: step.resolvedBy ? (approverNames.get(step.resolvedBy) ?? null) : null,
        resolvedVia: step.resolvedVia,
        status: step.status,
      }));
      const reportHitlRollupRows =
        user.role === 'ADMIN'
          ? hitlRollupRows
          : hitlRollupRows.map((row) => ({
              ...row,
              resolvedBy: reportApproverId(row.resolvedBy),
            }));
      const report = computeHitlReport({
        autonomyDecisions: decisions.slice(0, REPORT_ROW_CAP),
        now: new Date(),
        pendingSteps: [],
        windowSteps: liveWindowSteps,
      });
      const liveHumanRows = buildHumanStepDailyRollups(
        liveWindowSteps.map((step) => ({
          kind: step.kind,
          orgId: null,
          requestedAt: step.requestedAt,
          resolvedAt: step.resolvedAt,
          resolvedBy: step.resolvedBy,
          resolvedVia: step.resolvedVia,
          status: step.status,
          teamId: null,
        }))
      );
      if (hitlPlan.rollupDays.length) {
        Object.assign(
          report,
          humanStepMetricsFromRollups([...reportHitlRollupRows, ...liveHumanRows], approverNames)
        );
      }
      Object.assign(report, {
        oldestPendingAgeMs: pendingOldest ? Date.now() - pendingOldest.requestedAt.getTime() : null,
        pendingNow: pendingCount,
      });
      const windowStepsTruncated = windowSteps.length > REPORT_ROW_CAP;
      const decisionsTruncated = decisions.length > REPORT_ROW_CAP;
      return {
        data: {
          ...report,
          decisionsTruncated,
          liveDays: hitlPlan.live.reduce(
            (sum, live) => sum + (live.lt.getTime() - live.gte.getTime()) / 86_400_000,
            0
          ),
          pendingStepsTruncated: false,
          rollupDays: hitlPlan.rollupDays.length,
          truncated: windowStepsTruncated || decisionsTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
          windowStepsTruncated,
        },
      };
    }
  );
};
