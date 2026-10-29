import { prisma } from '@auto-swe/shared/db';
import { DAY_MS, TX_TIMEOUT_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import {
  resolveScheduledSweeps,
  validateScheduledSweepsEnv,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  buildWorkflowRunDailyRollups,
  WORKFLOW_RUN_DAY_MS,
  WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
  workflowRunRollupInputFromRun,
} from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';

export const MAX_BACKFILL_DAYS_PER_SWEEP = 10;
export const MAX_DIRTY_DAYS_PER_SWEEP = 60;
const ROLLUP_SWEEP_NAME = 'workflow_run_daily';

async function dirtyDaysSince(
  since: Date,
  now: Date,
  horizon: Date
): Promise<{ days: number[]; hasMore: boolean }> {
  const [endedRuns, changedPullRequests, resolvedSteps] = await Promise.all([
    runUnscoped(
      'the workflow run rollup finds old run days finalized since the previous sweep',
      ['WorkflowRun'],
      () =>
        prisma.workflowRun.findMany({
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          select: { endedAt: true, startedAt: true },
          where: {
            endedAt: { gt: since, lte: now },
            startedAt: { lt: horizon },
          },
        })
    ),
    runUnscoped(
      'the workflow run rollup finds old run days with PR state changes since the previous sweep',
      ['PullRequest', 'WorkflowRun'],
      () =>
        prisma.pullRequest.findMany({
          select: {
            closedAt: true,
            mergedAt: true,
            run: { select: { startedAt: true } },
          },
          where: {
            OR: [{ mergedAt: { gt: since, lte: now } }, { closedAt: { gt: since, lte: now } }],
            run: { is: { startedAt: { lt: horizon } } },
            runId: { not: null },
          },
        })
    ),
    runUnscoped(
      'the workflow run rollup finds old run days with resolved human steps since the previous sweep',
      ['WorkflowHumanStep', 'WorkflowRun'],
      () =>
        prisma.workflowHumanStep.findMany({
          orderBy: [{ run: { startedAt: 'asc' } }, { id: 'asc' }],
          select: {
            resolvedAt: true,
            run: { select: { startedAt: true } },
          },
          where: {
            resolvedAt: { gt: since, lte: now },
            run: { startedAt: { lt: horizon } },
          },
        })
    ),
  ]);

  const changedAtByDay = new Map<number, number>();
  const recordChange = (startedAt: Date, changedAt: Date | null) => {
    if (!changedAt) {
      return;
    }
    const day = Math.floor(startedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS;
    const previous = changedAtByDay.get(day) ?? 0;
    changedAtByDay.set(day, Math.max(previous, changedAt.getTime()));
  };
  for (const run of endedRuns) {
    recordChange(run.startedAt, run.endedAt);
  }
  for (const pr of changedPullRequests) {
    if (pr.run) {
      recordChange(pr.run.startedAt, pr.mergedAt);
      recordChange(pr.run.startedAt, pr.closedAt);
    }
  }
  for (const step of resolvedSteps) {
    recordChange(step.run.startedAt, step.resolvedAt);
  }
  if (changedAtByDay.size === 0) {
    return { days: [], hasMore: false };
  }

  const days = [...changedAtByDay.keys()].sort((a, b) => a - b);
  const builtDays = await runUnscoped(
    'the workflow run rollup skips dirty days already rebuilt after their latest source change',
    ['WorkflowRunDailyRollup'],
    () =>
      prisma.workflowRunDailyRollup.groupBy({
        _max: { builtAt: true },
        by: ['day'],
        where: {
          bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
          day: { in: days.map((day) => new Date(day)) },
        },
      })
  );
  const builtAtByDay = new Map(
    builtDays.map((row) => [row.day.getTime(), row._max.builtAt?.getTime() ?? 0])
  );
  const pendingDays = days.filter(
    (day) => (builtAtByDay.get(day) ?? 0) < (changedAtByDay.get(day) ?? 0)
  );
  return {
    days: pendingDays.slice(0, MAX_DIRTY_DAYS_PER_SWEEP),
    hasMore: pendingDays.length > MAX_DIRTY_DAYS_PER_SWEEP,
  };
}

export async function rollupWorkflowRuns(
  now = new Date()
): Promise<{ days: number; rows: number }> {
  const settings = resolveScheduledSweeps().workflowRunRollup;
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const newest = today - WORKFLOW_RUN_DAY_MS;
  const days = new Set<number>();
  for (let offset = 0; offset < settings.recomputeDays; offset++) {
    days.add(newest - offset * WORKFLOW_RUN_DAY_MS);
  }
  const horizon = new Date(today - settings.recomputeDays * WORKFLOW_RUN_DAY_MS);
  const state = await runUnscoped(
    'the workflow run rollup reads its previous successful sweep start',
    ['RollupSweepState'],
    () =>
      prisma.rollupSweepState.findUnique({
        select: { lastSuccessfulStartAt: true },
        where: { name: ROLLUP_SWEEP_NAME },
      })
  );
  const dirty = state?.lastSuccessfulStartAt
    ? await dirtyDaysSince(state.lastSuccessfulStartAt, now, horizon)
    : { days: [], hasMore: false };
  for (const day of dirty.days) {
    days.add(day);
  }
  if (dirty.hasMore) {
    logWarn(
      'workflow run rollup reached its dirty-day rebuild cap; remaining days wait for the next sweep',
      {
        cap: MAX_DIRTY_DAYS_PER_SWEEP,
      }
    );
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
              bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
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

  let rowCount = 0;
  const sortedDays = [...days].sort((a, b) => a - b);
  for (const day of sortedDays) {
    heartbeat(`rolling up workflow runs for ${new Date(day).toISOString().slice(0, 10)}`);
    const dayStart = new Date(day);
    const dayEnd = new Date(day + DAY_MS);
    const runs = await runUnscoped(
      'the workflow run rollup reads source runs for one selected UTC day',
      ['WorkflowRun'],
      () =>
        prisma.workflowRun.findMany({
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          select: {
            attributedOrgId: true,
            attributedTeamId: true,
            connectionId: true,
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
          where: { startedAt: { gte: dayStart, lt: dayEnd } },
        })
    );
    const runIds = runs.map((run) => run.id);
    const [pullRequests, steps, traces] = runIds.length
      ? await Promise.all([
          runUnscoped(
            'the workflow run rollup reads PRs linked to one selected day',
            ['PullRequest'],
            () =>
              prisma.pullRequest.findMany({
                select: { ciStatus: true, mergedAt: true, runId: true, status: true },
                where: { runId: { in: runIds } },
              })
          ),
          runUnscoped(
            'the workflow run rollup reads terminal CI-fix steps for one selected day',
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
            'the workflow run rollup reads review verdict traces for one selected day',
            ['AgentTrace'],
            () =>
              prisma.agentTrace.findMany({
                select: { error: true, outputJson: true, runId: true },
                where: { nodeId: 'runReviewNetwork', runId: { in: runIds } },
              })
          ),
        ])
      : [[], [], []];
    const dayRows = buildWorkflowRunDailyRollups({
      now,
      pullRequests: pullRequests.filter(
        (pr): pr is typeof pr & { runId: string } => pr.runId !== null
      ),
      runs: runs.map(workflowRunRollupInputFromRun),
      steps,
      traces,
    });
    await runUnscoped(
      'the workflow run rollup replaces one complete UTC day atomically',
      ['WorkflowRunDailyRollup'],
      () =>
        prisma.$transaction(
          async (tx) => {
            await tx.workflowRunDailyRollup.deleteMany({ where: { day: dayStart } });
            for (let offset = 0; offset < dayRows.length; offset += 500) {
              await tx.workflowRunDailyRollup.createMany({
                data: dayRows.slice(offset, offset + 500),
              });
            }
          },
          { maxWait: 30_000, timeout: TX_TIMEOUT_MS }
        )
    );
    rowCount += dayRows.length;
    heartbeat(`finished workflow run rollup for ${dayStart.toISOString().slice(0, 10)}`);
  }
  if (!dirty.hasMore) {
    await runUnscoped(
      'the workflow run rollup advances its successful sweep start after rebuilding selected days',
      ['RollupSweepState'],
      async () => {
        await prisma.rollupSweepState.upsert({
          create: { lastSuccessfulStartAt: now, name: ROLLUP_SWEEP_NAME },
          update: {},
          where: { name: ROLLUP_SWEEP_NAME },
        });
        await prisma.rollupSweepState.updateMany({
          data: { lastSuccessfulStartAt: now },
          where: {
            name: ROLLUP_SWEEP_NAME,
            OR: [{ lastSuccessfulStartAt: null }, { lastSuccessfulStartAt: { lte: now } }],
          },
        });
      }
    );
  }
  return { days: sortedDays.length, rows: rowCount };
}
