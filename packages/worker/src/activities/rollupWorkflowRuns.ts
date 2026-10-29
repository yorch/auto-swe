import { prisma } from '@auto-swe/shared/db';
import {
  resolveScheduledSweeps,
  validateScheduledSweepsEnv,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { buildWorkflowRunDailyRollups, WORKFLOW_RUN_DAY_MS } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';

const MAX_BACKFILL_DAYS_PER_SWEEP = 10;

export async function rollupWorkflowRuns(
  now = new Date()
): Promise<{ days: number; rows: number }> {
  const settings = resolveScheduledSweeps().workflowRunRollup;
  const today = Math.floor(now.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS;
  const newest = today - WORKFLOW_RUN_DAY_MS;
  const days = new Set<number>();
  for (let offset = 0; offset < settings.recomputeDays; offset++) {
    days.add(newest - offset * WORKFLOW_RUN_DAY_MS);
  }
  const invalid = validateScheduledSweepsEnv().filter((problem) =>
    problem.startsWith('WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS')
  );
  if (invalid.length) {
    logWarn('workflow run rollup backfill disabled: invalid configuration', {
      problem: invalid.join('; '),
    });
  }
  if (settings.backfillDays > 0) {
    const oldest = await runUnscoped(
      'the workflow run rollup backfill finds the oldest source run',
      ['WorkflowRun'],
      () => prisma.workflowRun.aggregate({ _min: { startedAt: true } })
    );
    const lower = today - settings.backfillDays * WORKFLOW_RUN_DAY_MS;
    const oldestDay = oldest._min.startedAt
      ? Math.max(
          lower,
          Math.floor(oldest._min.startedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS
        )
      : null;
    if (oldestDay !== null) {
      const newestBackfill = newest - settings.recomputeDays * WORKFLOW_RUN_DAY_MS;
      const present = await runUnscoped(
        'the workflow run rollup backfill lists already-built days',
        ['WorkflowRunDailyRollup'],
        () =>
          prisma.workflowRunDailyRollup.groupBy({
            by: ['day'],
            where: {
              day: { gte: new Date(oldestDay), lt: new Date(newestBackfill + WORKFLOW_RUN_DAY_MS) },
            },
          })
      );
      const have = new Set(present.map((row) => row.day.getTime()));
      let count = 0;
      for (let day = newestBackfill; day >= oldestDay; day -= WORKFLOW_RUN_DAY_MS) {
        if (!have.has(day)) {
          if (count >= MAX_BACKFILL_DAYS_PER_SWEEP) {
            break;
          }
          days.add(day);
          count++;
        }
      }
    }
  }

  const sortedDays = [...days].sort((a, b) => a - b);
  const firstDay = sortedDays[0];
  const lastDay = sortedDays.at(-1);
  if (firstDay === undefined || lastDay === undefined) {
    return { days: 0, rows: 0 };
  }
  const start = firstDay;
  const end = lastDay + WORKFLOW_RUN_DAY_MS;
  const runs = await runUnscoped(
    'the workflow run rollup reads source runs for the configured rebuild window',
    ['WorkflowRun'],
    () =>
      prisma.workflowRun.findMany({
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        select: {
          attributedOrgId: true,
          attributedTeamId: true,
          costUsdAccrued: true,
          endedAt: true,
          estimatedHumanTimeSaved: true,
          hadHumanStep: true,
          id: true,
          outcomeDomain: true,
          outcomeType: true,
          startedAt: true,
          status: true,
          templateId: true,
          templateVersion: true,
          wasAutonomous: true,
          workflowId: true,
          workRequest: {
            select: {
              activeWorkflows: {
                select: { costUsdAccrued: true, repoId: true, temporalWorkflowId: true },
              },
            },
          },
        },
        where: { startedAt: { gte: new Date(start), lt: new Date(end) } },
      })
  );
  const runIds = runs.map((run) => run.id);
  const [pullRequests, steps, traces] = runIds.length
    ? await Promise.all([
        runUnscoped(
          'the workflow run rollup reads PRs linked by persisted run attribution',
          ['PullRequest'],
          () =>
            prisma.pullRequest.findMany({
              select: { ciStatus: true, mergedAt: true, runId: true, status: true },
              where: { runId: { in: runIds } },
            })
        ),
        runUnscoped(
          'the workflow run rollup reads terminal CI-fix steps for source runs',
          ['WorkflowStep'],
          () =>
            prisma.workflowStep.findMany({
              select: { runId: true, status: true, stepName: true },
              where: {
                runId: { in: runIds },
                status: { in: ['PASSED', 'FAILED'] },
                stepName: 'executeCIFixImplementation',
              },
            })
        ),
        runUnscoped(
          'the workflow run rollup reads review verdict traces for source runs',
          ['AgentTrace'],
          () =>
            prisma.agentTrace.findMany({
              select: { error: true, outputJson: true, runId: true },
              where: { nodeId: 'runReviewNetwork', runId: { in: runIds } },
            })
        ),
      ])
    : [[], [], []];
  const built = buildWorkflowRunDailyRollups({
    now,
    pullRequests: pullRequests.filter(
      (pr): pr is typeof pr & { runId: string } => pr.runId !== null
    ),
    runs: runs.map((run) => ({
      ...run,
      legacyCostUsd: (run.workRequest?.activeWorkflows ?? [])
        .filter((workflow) => workflow.temporalWorkflowId === run.workflowId)
        .reduce((sum, workflow) => sum + workflow.costUsdAccrued, 0),
      repoId:
        run.workRequest?.activeWorkflows.find(
          (workflow) => workflow.temporalWorkflowId === run.workflowId
        )?.repoId ?? null,
    })),
    steps,
    traces,
  });
  let rowCount = 0;
  for (const day of sortedDays) {
    heartbeat(`rolling up workflow runs for ${new Date(day).toISOString().slice(0, 10)}`);
    const dayRows = built.filter((row) => row.day.getTime() === day);
    await runUnscoped(
      'the workflow run rollup replaces one complete UTC day atomically',
      ['WorkflowRunDailyRollup'],
      () =>
        prisma.$transaction(async (tx) => {
          await tx.workflowRunDailyRollup.deleteMany({ where: { day: new Date(day) } });
          if (dayRows.length) {
            await tx.workflowRunDailyRollup.createMany({ data: dayRows });
          }
        })
    );
    rowCount += dayRows.length;
  }
  return { days: sortedDays.length, rows: rowCount };
}
