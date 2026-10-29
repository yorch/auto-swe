import { orgMonthSpend } from '@auto-swe/shared/lib/billing';
import { forecastMonthlyBudget } from '@auto-swe/shared/lib/budgetForecast';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  computeAutomationReport,
  computeDeliveryReport,
  computeHitlReport,
  computeQualityReport,
} from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { customRangeFields, refineCustomRange, resolveWindow } from '../lib/dateWindow.js';
import { mapLimited } from '../lib/mapLimited.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const REPORT_ROW_CAP = 10_000;
const REPORT_WINDOW_DAYS = [7, 30, 90] as const;
const ReportQuery = refineCustomRange(
  z.object({
    ...customRangeFields,
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

function visibility(
  user: { role: string; sub: string },
  gate: Parameters<typeof buildWorkflowRunVisibilityFilter>[1]
) {
  return user.role === 'ADMIN' ? {} : buildWorkflowRunVisibilityFilter(user, gate);
}

export const reportsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const readAnalytics = requireAuth({ requiredRole: 'ENGINEER' });

  app.get(
    '/delivery',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const runsResult = await asPlatformAdmin(
        user,
        'admin delivery report spans every tenant',
        ['WorkflowRun'],
        () =>
          fastify.prisma.workflowRun.findMany({
            orderBy: { startedAt: 'desc' },
            select: {
              costUsdAccrued: true,
              id: true,
              startedAt: true,
              status: true,
              template: { select: { name: true } },
              templateId: true,
              workflowId: true,
            },
            take: REPORT_ROW_CAP + 1,
            where: {
              AND: [
                { startedAt: { gte: range.start, lt: range.end } },
                visibility(user, request.repoAccessGate),
              ],
            },
          })
      );
      const runsTruncated = runsResult.length > REPORT_ROW_CAP;
      const runs = runsResult.slice(0, REPORT_ROW_CAP);
      const runIds = runs.map((run) => run.id);
      const workflowIds = runs.map((run) => run.workflowId);
      const [activeWorkflows, pullRequests, fixSteps] = await Promise.all([
        workflowIds.length
          ? runUnscoped(
              'delivery report joins only workflow ids visible to the caller',
              ['ActiveWorkflow'],
              () =>
                fastify.prisma.activeWorkflow.findMany({
                  orderBy: { temporalWorkflowId: 'asc' },
                  select: {
                    costUsdAccrued: true,
                    repoId: true,
                    repository: { select: { organizationName: true, repoName: true } },
                    temporalWorkflowId: true,
                  },
                  take: REPORT_ROW_CAP + 1,
                  where: { temporalWorkflowId: { in: workflowIds } },
                })
            )
          : [],
        runIds.length
          ? runUnscoped(
              'delivery report joins only run ids visible to the caller',
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
        runIds.length
          ? runUnscoped(
              'delivery report counts steps only for visible cohort runs',
              ['WorkflowStep'],
              () =>
                fastify.prisma.workflowStep.findMany({
                  orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
                  select: { runId: true },
                  take: REPORT_ROW_CAP + 1,
                  where: {
                    runId: { in: runIds },
                    stepName: 'executeCIFixImplementation',
                  },
                })
            )
          : [],
      ]);
      const activeWorkflowsTruncated = activeWorkflows.length > REPORT_ROW_CAP;
      const prsTruncated = pullRequests.length > REPORT_ROW_CAP;
      const ciFixStepsTruncated = fixSteps.length > REPORT_ROW_CAP;
      const activeByWorkflowId = new Map(
        activeWorkflows
          .slice(0, REPORT_ROW_CAP)
          .map((workflow) => [workflow.temporalWorkflowId, workflow])
      );
      const prsByRun = new Map<string, Array<{ ciStatus: string; mergedAt: Date | null }>>();
      for (const pr of pullRequests.slice(0, REPORT_ROW_CAP)) {
        if (!pr.runId) {
          continue;
        }
        const rows = prsByRun.get(pr.runId) ?? [];
        rows.push({ ciStatus: pr.ciStatus, mergedAt: pr.mergedAt });
        prsByRun.set(pr.runId, rows);
      }
      const ciRoundsByRun = new Map<string, number>();
      for (const step of fixSteps.slice(0, REPORT_ROW_CAP)) {
        ciRoundsByRun.set(step.runId, (ciRoundsByRun.get(step.runId) ?? 0) + 1);
      }
      const reportRuns = runs.map((run) => {
        const active = activeByWorkflowId.get(run.workflowId);
        const repoName =
          active?.repository?.organizationName && active.repository.repoName
            ? `${active.repository.organizationName}/${active.repository.repoName}`
            : (active?.repository?.repoName ?? active?.repository?.organizationName ?? null);
        return {
          ciFixRounds: ciRoundsByRun.get(run.id) ?? 0,
          costUsdAccrued:
            Number(run.costUsdAccrued) === 0
              ? Number(active?.costUsdAccrued ?? 0)
              : Number(run.costUsdAccrued),
          id: run.id,
          pullRequests: prsByRun.get(run.id) ?? [],
          repoId: active?.repoId ?? null,
          repositoryName: repoName,
          startedAt: run.startedAt,
          status: run.status,
          templateId: run.templateId,
          templateName: run.template.name,
          workflowId: run.workflowId,
        };
      });
      const report = computeDeliveryReport(reportRuns);
      return {
        data: {
          ...report,
          activeWorkflowsTruncated,
          ciFixStepsTruncated,
          prsTruncated,
          runsTruncated,
          truncated:
            runsTruncated || activeWorkflowsTruncated || prsTruncated || ciFixStepsTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
        },
      };
    }
  );

  app.get(
    '/quality',
    { onRequest: readAnalytics, schema: { querystring: ReportQuery } },
    async (request) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const runRows = await asPlatformAdmin(
        user,
        'admin quality report spans every tenant',
        ['WorkflowRun'],
        () =>
          fastify.prisma.workflowRun.findMany({
            orderBy: { startedAt: 'desc' },
            select: {
              id: true,
              startedAt: true,
              template: { select: { name: true } },
              templateId: true,
              workflowId: true,
            },
            take: REPORT_ROW_CAP + 1,
            where: {
              AND: [
                { startedAt: { gte: range.start, lt: range.end } },
                visibility(user, request.repoAccessGate),
              ],
            },
          })
      );
      const runsTruncated = runRows.length > REPORT_ROW_CAP;
      const runs = runRows.slice(0, REPORT_ROW_CAP);
      const runIds = runs.map((run) => run.id);
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
        runIds.length
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
                    runId: { in: runIds },
                    type: 'llm_response',
                  },
                })
            )
          : [],
      ]);
      const prsTruncated = pullRequests.length > REPORT_ROW_CAP;
      const tracesTruncated = traces.length > REPORT_ROW_CAP;
      const reportPrs = pullRequests.slice(0, REPORT_ROW_CAP).flatMap((pr) => {
        if (!pr.runId) {
          return [];
        }
        return [{ ciStatus: pr.ciStatus, mergedAt: pr.mergedAt, runId: pr.runId }];
      });
      const report = computeQualityReport({
        pullRequests: reportPrs,
        reviewTraces: traces.slice(0, REPORT_ROW_CAP).map((trace) => ({
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
      return {
        data: {
          ...report,
          prsTruncated,
          runsTruncated,
          tracesTruncated,
          truncated: runsTruncated || prsTruncated || tracesTruncated,
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
                    { startedAt: { gte: monthStart, lt: monthEnd } },
                    {
                      OR: [
                        { workRequest: { connection: { team: { orgId: org.id } } } },
                        {
                          connection: { team: { orgId: org.id } },
                          OR: [{ workRequestId: null }, { workRequest: { connectionId: null } }],
                        },
                        {
                          connectionId: null,
                          workRequest: {
                            activeWorkflows: {
                              some: { repository: { team: { orgId: org.id } } },
                            },
                            connectionId: null,
                          },
                        },
                        {
                          connectionId: null,
                          workRequest: {
                            activeWorkflows: { none: { repoId: { not: null } } },
                            billingOrgId: org.id,
                            connectionId: null,
                          },
                        },
                      ],
                    },
                    visibility(user, request.repoAccessGate),
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
    async (request) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const accessibleAutomations = await runUnscoped(
        'automation reports follow the automation list repository and team scopes',
        ['Automation'],
        () =>
          fastify.prisma.automation.findMany({
            orderBy: { id: 'asc' },
            select: { connectionId: true, id: true, teamId: true },
            take: REPORT_ROW_CAP + 1,
            where:
              user.role === 'ADMIN'
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
              ...(user.role === 'ADMIN' ? {} : { automationId: { in: visibleAutomationIds } }),
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
    async (request) => {
      const user = requireUser(request);
      const range = reportWindow(request.query);
      const [windowSteps, pendingSteps, decisions] = await Promise.all([
        asPlatformAdmin(user, 'admin HITL report spans every tenant', ['WorkflowHumanStep'], () =>
          fastify.prisma.workflowHumanStep.findMany({
            orderBy: { requestedAt: 'desc' },
            select: {
              kind: true,
              requestedAt: true,
              resolvedAt: true,
              resolvedBy: true,
              resolvedByUser: { select: { name: true } },
              status: true,
            },
            take: REPORT_ROW_CAP + 1,
            where: {
              requestedAt: { gte: range.start, lt: range.end },
              run: visibility(user, request.repoAccessGate),
            },
          })
        ),
        asPlatformAdmin(
          user,
          'admin pending approval report spans every tenant',
          ['WorkflowHumanStep'],
          () =>
            fastify.prisma.workflowHumanStep.findMany({
              orderBy: { requestedAt: 'asc' },
              select: {
                kind: true,
                requestedAt: true,
                resolvedAt: true,
                resolvedBy: true,
                resolvedByUser: { select: { name: true } },
                status: true,
              },
              take: REPORT_ROW_CAP + 1,
              where: {
                run: visibility(user, request.repoAccessGate),
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
                run: visibility(user, request.repoAccessGate),
              },
            })
        ),
      ]);
      const report = computeHitlReport({
        autonomyDecisions: decisions.slice(0, REPORT_ROW_CAP),
        now: new Date(),
        pendingSteps: pendingSteps.slice(0, REPORT_ROW_CAP).map((step) => ({
          kind: step.kind,
          requestedAt: step.requestedAt,
          resolvedAt: step.resolvedAt,
          resolvedBy: step.resolvedBy,
          resolvedByName: step.resolvedByUser?.name ?? null,
          status: step.status,
        })),
        windowSteps: windowSteps.slice(0, REPORT_ROW_CAP).map((step) => ({
          kind: step.kind,
          requestedAt: step.requestedAt,
          resolvedAt: step.resolvedAt,
          resolvedBy: step.resolvedBy,
          resolvedByName: step.resolvedByUser?.name ?? null,
          status: step.status,
        })),
      });
      const windowStepsTruncated = windowSteps.length > REPORT_ROW_CAP;
      const pendingStepsTruncated = pendingSteps.length > REPORT_ROW_CAP;
      const decisionsTruncated = decisions.length > REPORT_ROW_CAP;
      return {
        data: {
          ...report,
          decisionsTruncated,
          pendingStepsTruncated,
          truncated: windowStepsTruncated || pendingStepsTruncated || decisionsTruncated,
          windowEnd: range.windowEnd,
          windowStart: range.windowStart,
          windowStepsTruncated,
        },
      };
    }
  );
};
