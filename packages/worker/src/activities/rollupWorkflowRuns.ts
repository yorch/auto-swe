import { prisma } from '@auto-swe/shared/db';
import { DAY_MS, TX_TIMEOUT_MS } from '@auto-swe/shared/lib/agentTraceRollup';
import { builtRollupDays, markRollupDayBuilt } from '@auto-swe/shared/lib/rollupBuiltDays';
import {
  matchingActiveWorkflows,
  withMatchingActiveWorkflow,
} from '@auto-swe/shared/lib/runActiveWorkflows';
import {
  resolveScheduledSweeps,
  validateScheduledSweepsEnv,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  buildHumanStepDailyRollups,
  buildReviewVerdictDailyRollups,
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
const DIRTY_DETECTION_OVERLAP_MS = 60 * 60 * 1000;
const DIRTY_DETECTION_PAGE_SIZE = 1_000;
const FIX_STEP_NAME = 'executeCIFixImplementation';

async function scanPages<T extends { id: string }>(
  readPage: (cursorId?: string) => Promise<T[]>,
  visit: (row: T) => void
): Promise<void> {
  let cursorId: string | undefined;
  while (true) {
    const page = await readPage(cursorId);
    for (const row of page) {
      visit(row);
    }
    if (page.length < DIRTY_DETECTION_PAGE_SIZE) {
      return;
    }
    cursorId = page.at(-1)?.id;
  }
}

async function dirtyDaysSince(since: Date, now: Date, horizon: Date): Promise<number[]> {
  const lowerBound = new Date(since.getTime() - DIRTY_DETECTION_OVERLAP_MS);
  const dirtyDays = new Set<number>();
  const recordDay = (startedAt: Date) => {
    dirtyDays.add(Math.floor(startedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS);
  };
  await Promise.all([
    scanPages(
      (cursorId) =>
        runUnscoped(
          'the workflow run rollup finds old run days updated since the previous sweep',
          ['WorkflowRun'],
          () =>
            prisma.workflowRun.findMany({
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              select: { id: true, startedAt: true },
              take: DIRTY_DETECTION_PAGE_SIZE,
              where: {
                startedAt: { lt: horizon },
                updatedAt: { gt: lowerBound, lte: now },
              },
            })
        ),
      (run) => recordDay(run.startedAt)
    ),
    scanPages(
      (cursorId) =>
        runUnscoped(
          'the workflow run rollup finds old run days with updated pull requests',
          ['PullRequest', 'WorkflowRun'],
          () =>
            prisma.pullRequest.findMany({
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              select: {
                id: true,
                run: { select: { startedAt: true } },
              },
              take: DIRTY_DETECTION_PAGE_SIZE,
              where: {
                run: { is: { startedAt: { lt: horizon } } },
                runId: { not: null },
                updatedAt: { gt: lowerBound, lte: now },
              },
            })
        ),
      (pr) => {
        if (pr.run) {
          recordDay(pr.run.startedAt);
        }
      }
    ),
    scanPages(
      (cursorId) =>
        runUnscoped(
          'the workflow run rollup finds old run days with completed CI-fix steps',
          ['WorkflowStep', 'WorkflowRun'],
          () =>
            prisma.workflowStep.findMany({
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              select: { id: true, run: { select: { startedAt: true } } },
              take: DIRTY_DETECTION_PAGE_SIZE,
              where: {
                endedAt: { gt: lowerBound, lte: now },
                run: { startedAt: { lt: horizon } },
                stepName: FIX_STEP_NAME,
              },
            })
        ),
      (step) => recordDay(step.run.startedAt)
    ),
    scanPages(
      (cursorId) =>
        runUnscoped(
          'the workflow run rollup finds old run days with new reviewer verdict traces',
          ['AgentTrace', 'WorkflowRun'],
          () =>
            prisma.agentTrace.findMany({
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              select: { id: true, run: { select: { startedAt: true } } },
              take: DIRTY_DETECTION_PAGE_SIZE,
              where: {
                agentKey: 'reviewer',
                createdAt: { gt: lowerBound, lte: now },
                run: { is: { startedAt: { lt: horizon } } },
                runId: { not: null },
                type: 'llm_response',
              },
            })
        ),
      (trace) => {
        if (trace.run) {
          recordDay(trace.run.startedAt);
        }
      }
    ),
    scanPages(
      (cursorId) =>
        runUnscoped(
          'the human-step rollup finds old request days resolved since the previous sweep',
          ['WorkflowHumanStep'],
          () =>
            prisma.workflowHumanStep.findMany({
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              select: { id: true, requestedAt: true },
              take: DIRTY_DETECTION_PAGE_SIZE,
              where: {
                requestedAt: { lt: horizon },
                resolvedAt: { gt: lowerBound, lte: now },
              },
            })
        ),
      (step) => recordDay(step.requestedAt)
    ),
  ]);
  return [...dirtyDays].sort((a, b) => a - b);
}

function parseUtcTimestamp(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error('now must be a canonical UTC timestamp');
  }
  return date;
}

export async function rollupWorkflowRuns(
  nowInput?: string
): Promise<{ days: number; rows: number }> {
  const now = nowInput === undefined ? new Date() : parseUtcTimestamp(nowInput);
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
        select: { lastSuccessfulStartAt: true, pendingDirtyDays: true },
        where: { name: ROLLUP_SWEEP_NAME },
      })
  );
  heartbeat('checking workflow rollup dirty days');
  const detectedDirtyDays = state?.lastSuccessfulStartAt
    ? await dirtyDaysSince(state.lastSuccessfulStartAt, now, horizon)
    : [];
  heartbeat('finished checking workflow rollup dirty days');
  const dirtyDayQueue = new Set([
    ...(state?.pendingDirtyDays ?? []).map((day) => day.getTime()),
    ...detectedDirtyDays,
  ]);
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
      // A built day with no runs has no rollup rows, so coverage comes from the built-day
      // marker. Without it every empty day would count as missing and use up the sweep's
      // backfill budget on each pass.
      const have = await builtRollupDays(
        prisma,
        { gte: new Date(oldestDay), lt: new Date(newestBackfill + WORKFLOW_RUN_DAY_MS) },
        WORKFLOW_RUN_ROLLUP_BUCKET_VERSION
      );
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

  const alreadySelectedDays = new Set(days);
  const dirtyCandidates = [...dirtyDayQueue]
    .filter((day) => !alreadySelectedDays.has(day))
    .sort((a, b) => a - b);
  const selectedDirtyDays = dirtyCandidates.slice(0, MAX_DIRTY_DAYS_PER_SWEEP);
  const pendingDirtyDays = dirtyCandidates.slice(MAX_DIRTY_DAYS_PER_SWEEP);
  for (const day of selectedDirtyDays) {
    days.add(day);
  }
  if (pendingDirtyDays.length) {
    logWarn('workflow run rollup has dirty days queued for a later sweep', {
      cap: MAX_DIRTY_DAYS_PER_SWEEP,
      remaining: pendingDirtyDays.length,
    });
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
            workflowId: true,
          },
          where: { startedAt: { gte: dayStart, lt: dayEnd } },
        })
    );
    const ledgerRows = await matchingActiveWorkflows(
      prisma,
      runs.map((run) => run.workflowId)
    );
    const runIds = runs.map((run) => run.id);
    const [sourceRows, selectedHumanSteps] = await Promise.all([
      runIds.length
        ? Promise.all([
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
                  where: {
                    agentKey: 'reviewer',
                    nodeId: 'runReviewNetwork',
                    runId: { in: runIds },
                    type: 'llm_response',
                  },
                })
            ),
          ])
        : Promise.resolve([[], [], []]),
      runUnscoped(
        'the human-step rollup reads steps requested on one selected UTC day',
        ['WorkflowHumanStep', 'WorkflowRun'],
        () =>
          prisma.workflowHumanStep.findMany({
            select: {
              kind: true,
              requestedAt: true,
              resolvedAt: true,
              resolvedBy: true,
              resolvedVia: true,
              run: {
                select: {
                  attributedOrgId: true,
                  attributedRepoId: true,
                  attributedTeamId: true,
                  launchedById: true,
                },
              },
              status: true,
            },
            where: { requestedAt: { gte: dayStart, lt: dayEnd } },
          })
      ),
    ]);
    const [pullRequests, steps, traces] = sourceRows;
    const dayRows = buildWorkflowRunDailyRollups({
      now,
      pullRequests: pullRequests
        .filter((pr) => pr.runId !== null)
        .map((pr) => ({ ...pr, runId: pr.runId as string })),
      runs: runs.map((run) =>
        workflowRunRollupInputFromRun(withMatchingActiveWorkflow(run, ledgerRows))
      ),
      steps,
      traces,
    });
    const humanRows = buildHumanStepDailyRollups(
      selectedHumanSteps.map((step) => ({
        kind: step.kind,
        launchedById: step.run.launchedById,
        orgId: step.run.attributedOrgId,
        repoId: step.run.attributedRepoId,
        requestedAt: step.requestedAt,
        resolvedAt: step.resolvedAt,
        resolvedBy: step.resolvedBy,
        resolvedVia: step.resolvedVia,
        status: step.status,
        teamId: step.run.attributedTeamId,
      }))
    );
    const reviewRows = buildReviewVerdictDailyRollups({
      runs: runs.map((run) => ({
        attributedOrgId: run.attributedOrgId,
        attributedTeamId: run.attributedTeamId,
        id: run.id,
        launchedById: run.launchedById,
        repoId: run.attributedRepoId,
        startedAt: run.startedAt,
      })),
      traces,
    });
    await runUnscoped(
      'the workflow run rollup replaces one complete UTC day atomically',
      [
        'WorkflowRunDailyRollup',
        'HumanStepDailyRollup',
        'ReviewVerdictDailyRollup',
        'RollupBuiltDay',
      ],
      () =>
        prisma.$transaction(
          async (tx) => {
            await tx.workflowRunDailyRollup.deleteMany({ where: { day: dayStart } });
            await tx.humanStepDailyRollup.deleteMany({ where: { day: dayStart } });
            await tx.reviewVerdictDailyRollup.deleteMany({ where: { day: dayStart } });
            for (let offset = 0; offset < dayRows.length; offset += 500) {
              await tx.workflowRunDailyRollup.createMany({
                data: dayRows.slice(offset, offset + 500),
              });
            }
            for (let offset = 0; offset < humanRows.length; offset += 500) {
              await tx.humanStepDailyRollup.createMany({
                data: humanRows.slice(offset, offset + 500),
              });
            }
            for (let offset = 0; offset < reviewRows.length; offset += 500) {
              await tx.reviewVerdictDailyRollup.createMany({
                data: reviewRows.slice(offset, offset + 500),
              });
            }
            await markRollupDayBuilt(tx, dayStart, WORKFLOW_RUN_ROLLUP_BUCKET_VERSION, now);
          },
          { maxWait: 30_000, timeout: TX_TIMEOUT_MS }
        )
    );
    rowCount += dayRows.length;
    heartbeat(`finished workflow run rollup for ${dayStart.toISOString().slice(0, 10)}`);
  }
  await runUnscoped(
    'the workflow run rollup records the successful sweep watermark and dirty-day backlog',
    ['RollupSweepState'],
    async () => {
      if (state?.lastSuccessfulStartAt && now < state.lastSuccessfulStartAt) {
        logWarn('workflow run rollup clock moved backwards; preserving its previous watermark', {
          lastSuccessfulStartAt: state.lastSuccessfulStartAt.toISOString(),
          now: now.toISOString(),
        });
        await prisma.rollupSweepState.updateMany({
          data: { pendingDirtyDays: pendingDirtyDays.map((day) => new Date(day)) },
          where: { name: ROLLUP_SWEEP_NAME },
        });
        return;
      }
      await prisma.rollupSweepState.upsert({
        create: {
          lastSuccessfulStartAt: now,
          name: ROLLUP_SWEEP_NAME,
          pendingDirtyDays: pendingDirtyDays.map((day) => new Date(day)),
        },
        update: {},
        where: { name: ROLLUP_SWEEP_NAME },
      });
      await prisma.rollupSweepState.updateMany({
        data: {
          lastSuccessfulStartAt: now,
          pendingDirtyDays: pendingDirtyDays.map((day) => new Date(day)),
        },
        where: {
          name: ROLLUP_SWEEP_NAME,
          OR: [{ lastSuccessfulStartAt: null }, { lastSuccessfulStartAt: { lte: now } }],
        },
      });
    }
  );
  return { days: sortedDays.length, rows: rowCount };
}
