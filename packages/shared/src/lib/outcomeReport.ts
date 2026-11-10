/**
 * Reads the deployment's own run data and builds the outcome report (docs/outcome-metrics.md).
 * The arithmetic lives in `workflow/outcomeMetrics.ts` and is pure; this file only selects rows.
 *
 * The report spans every tenant, so callers are platform-level: the ADMIN-only gateway route and the
 * scheduled worker activity.
 */
import type { PrismaClient } from '../index.js';
import {
  CI_FIX_STEP,
  computeOutcomeReport,
  type OutcomePullRequest,
  type OutcomeReport,
  type OutcomeRun,
  type OutcomeStep,
  REVIEW_ROUND_STEP,
  workItemKeyFor,
} from '../workflow/outcomeMetrics.js';
import { matchingActiveWorkflows } from './runActiveWorkflows.js';
import { runUnscoped } from './tenantGuard.js';

export const OUTCOME_REPORT_ROW_CAP = 50_000;
/** How far before the window to read runs, so a retry of older work is not mistaken for new work. */
export const OUTCOME_REPORT_LOOKBACK_DAYS = 30;
export const OUTCOME_REPORT_DEFAULT_WINDOW_DAYS = 90;
export const OUTCOME_REPORT_ARTIFACT_KIND = 'outcome-report';

const DAY_MS = 86_400_000;
const ID_CHUNK = 1_000;

export type OutcomeReportDb = Pick<
  PrismaClient,
  'activeWorkflow' | 'connection' | 'pullRequest' | 'workflowRun' | 'workflowStep'
>;

/** The window the schedule uses: the trailing `days` complete UTC days before `now`. */
export function trailingWindow(now: Date, days: number): { start: Date; end: Date } {
  const end = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  return { end, start: new Date(end.getTime() - days * DAY_MS) };
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += ID_CHUNK) {
    out.push(values.slice(offset, offset + ID_CHUNK));
  }
  return out;
}

export async function buildOutcomeReport(
  db: OutcomeReportDb,
  options: { now?: Date; window?: { start: Date; end: Date } } = {}
): Promise<OutcomeReport> {
  const now = options.now ?? new Date();
  const window = options.window ?? trailingWindow(now, OUTCOME_REPORT_DEFAULT_WINDOW_DAYS);
  const readFrom = new Date(window.start.getTime() - OUTCOME_REPORT_LOOKBACK_DAYS * DAY_MS);

  const rows = await runUnscoped(
    'the outcome report reads every run, as a platform-level report',
    ['WorkflowRun'],
    () =>
      db.workflowRun.findMany({
        orderBy: { startedAt: 'desc' },
        select: {
          attributedRepoId: true,
          costUsdAccrued: true,
          id: true,
          startedAt: true,
          status: true,
          template: { select: { name: true } },
          templateId: true,
          workflowId: true,
          workRequest: {
            select: { externalTicketId: true, id: true, ticketIsSynthetic: true },
          },
        },
        take: OUTCOME_REPORT_ROW_CAP + 1,
        where: { startedAt: { gte: readFrom } },
      })
  );
  const truncated = rows.length > OUTCOME_REPORT_ROW_CAP;
  const runRows = rows.slice(0, OUTCOME_REPORT_ROW_CAP);
  const runIds = runRows.map((run) => run.id);

  const ledger = await matchingActiveWorkflows(
    db,
    runRows.map((run) => run.workflowId)
  );
  const repoIds = [
    ...new Set(runRows.flatMap((run) => (run.attributedRepoId ? [run.attributedRepoId] : []))),
  ];
  const repos = new Map<string, string>();
  for (const ids of chunks(repoIds)) {
    const found = await runUnscoped(
      'the outcome report labels the repositories its runs name',
      ['Connection'],
      () =>
        db.connection.findMany({
          select: { id: true, organizationName: true, repoName: true },
          where: { id: { in: ids } },
        })
    );
    for (const repo of found) {
      repos.set(
        repo.id,
        [repo.organizationName, repo.repoName].filter(Boolean).join('/') || repo.id
      );
    }
  }

  const runs: OutcomeRun[] = runRows.map((run) => {
    const own = Number(run.costUsdAccrued);
    const legacy = ledger.get(run.workflowId);
    const legacyCost = legacy ? Number(legacy.costUsdAccrued) : 0;
    return {
      costUsd: own > 0 ? own : legacyCost,
      id: run.id,
      repoId: run.attributedRepoId,
      repoName: run.attributedRepoId
        ? (repos.get(run.attributedRepoId) ?? 'Inaccessible repository')
        : 'Unattributed',
      startedAt: run.startedAt,
      status: run.status,
      templateId: run.templateId,
      templateName: run.template.name,
      workItemKey: workItemKeyFor({
        id: run.id,
        repoId: run.attributedRepoId,
        ticketId: run.workRequest?.externalTicketId ?? null,
        ticketIsSynthetic: run.workRequest?.ticketIsSynthetic ?? false,
        workRequestId: run.workRequest?.id ?? null,
      }),
    };
  });

  const pullRequests: OutcomePullRequest[] = [];
  const steps: OutcomeStep[] = [];
  for (const ids of chunks(runIds)) {
    const [prs, fixSteps] = await Promise.all([
      runUnscoped('the outcome report joins pull requests to its runs', ['PullRequest'], () =>
        db.pullRequest.findMany({
          select: { ciStatus: true, mergedAt: true, runId: true, status: true },
          where: { runId: { in: ids } },
        })
      ),
      runUnscoped('the outcome report counts fix-loop steps of its runs', ['WorkflowStep'], () =>
        db.workflowStep.findMany({
          select: { runId: true, stepName: true },
          where: {
            runId: { in: ids },
            status: { in: ['PASSED', 'FAILED'] },
            stepName: { in: [REVIEW_ROUND_STEP, CI_FIX_STEP] },
          },
        })
      ),
    ]);
    pullRequests.push(...prs);
    for (const step of fixSteps) {
      if (step.stepName) {
        steps.push({ runId: step.runId, stepName: step.stepName });
      }
    }
  }

  return computeOutcomeReport({ generatedAt: now, pullRequests, runs, steps, truncated, window });
}
