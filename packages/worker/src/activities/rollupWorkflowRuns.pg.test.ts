import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

const enabled = process.env.ROLLUP_WORKFLOW_RUNS_PG_TEST === '1';
const SWEEP_NAME = 'workflow_run_daily';

describe.skipIf(!enabled)('workflow run rollup sweep against Postgres', () => {
  let prisma: typeof import('@auto-swe/shared/db').prisma;
  let rollupWorkflowRuns: typeof import('./rollupWorkflowRuns.js').rollupWorkflowRuns;
  let templateId = '';
  let runId = '';
  let humanStepId = '';
  let traceId = '';
  let dayStart: Date;
  let previousState: { lastSuccessfulStartAt: Date | null } | null = null;
  let now: Date;
  /** November 2026: no fixture run starts there, so a day built in it has no rollup rows. */
  const emptyWindow = { gte: new Date(Date.UTC(2026, 10, 1)), lt: new Date(Date.UTC(2026, 11, 1)) };

  beforeAll(async () => {
    vi.stubEnv('WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS', '1');
    vi.stubEnv('WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS', '0');
    ({ prisma } = await import('@auto-swe/shared/db'));
    ({ rollupWorkflowRuns } = await import('./rollupWorkflowRuns.js'));
    now = new Date(Date.UTC(2026, 10, 15, 12));
    dayStart = new Date(Date.UTC(2026, 9, 1));
    previousState = await prisma.rollupSweepState.findUnique({
      select: { lastSuccessfulStartAt: true },
      where: { name: SWEEP_NAME },
    });
    await prisma.rollupSweepState.upsert({
      create: {
        lastSuccessfulStartAt: new Date(now.getTime() - 3_600_000),
        name: SWEEP_NAME,
      },
      update: { lastSuccessfulStartAt: new Date(now.getTime() - 3_600_000) },
      where: { name: SWEEP_NAME },
    });
    templateId = (
      await prisma.workflowTemplate.create({
        data: { name: `rollup-pg-${randomUUID()}` },
      })
    ).id;
    runId = (
      await prisma.workflowRun.create({
        data: {
          endedAt: new Date(now.getTime() - 1_800_000),
          specSnapshot: {},
          startedAt: new Date(dayStart.getTime() + 3_600_000),
          status: 'SUCCESS',
          templateId,
          templateVersion: 1,
          workflowId: `rollup-pg-${randomUUID()}`,
        },
      })
    ).id;
    humanStepId = (
      await prisma.workflowHumanStep.create({
        data: {
          description: null,
          kind: 'APPROVAL',
          nodeId: 'approval',
          requestedAt: new Date(dayStart.getTime() + 7_200_000),
          resolvedAt: new Date(now.getTime() - 900_000),
          resolvedVia: 'web',
          runId,
          signalName: 'approval',
          status: 'RESOLVED',
          title: 'Approve',
        },
      })
    ).id;
    traceId = (
      await prisma.agentTrace.create({
        data: {
          agentKey: 'reviewer',
          createdAt: new Date(now.getTime() - 600_000),
          nodeId: 'runReviewNetwork',
          outputJson: {
            approved: false,
            findings: [{ category: 'correctness', message: 'Fix this', severity: 'CRITICAL' }],
            reviewer: 'SECURITY',
            severity: 'CRITICAL',
            summary: 'Needs changes',
          },
          runId,
          seq: 1,
          type: 'llm_response',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (runId) {
      await runUnscoped(
        'remove the workflow-run rollup test fixture',
        ['WorkflowRunDailyRollup'],
        () => prisma.workflowRunDailyRollup.deleteMany({ where: { day: dayStart } })
      );
      await runUnscoped('remove the human-step rollup test fixture', ['HumanStepDailyRollup'], () =>
        prisma.humanStepDailyRollup.deleteMany({ where: { day: dayStart } })
      );
      await runUnscoped(
        'remove the review-verdict rollup test fixture',
        ['ReviewVerdictDailyRollup'],
        () => prisma.reviewVerdictDailyRollup.deleteMany({ where: { day: dayStart } })
      );
      await runUnscoped('remove the built-day marker test fixture', ['RollupBuiltDay'], () =>
        prisma.rollupBuiltDay.deleteMany({
          where: { OR: [{ day: dayStart }, { day: { gte: emptyWindow.gte, lt: emptyWindow.lt } }] },
        })
      );
      if (traceId) {
        await runUnscoped('remove the review trace test fixture', ['AgentTrace'], () =>
          prisma.agentTrace.deleteMany({ where: { id: traceId } })
        );
      }
      if (humanStepId) {
        await prisma.workflowHumanStep.deleteMany({ where: { id: humanStepId } });
      }
      await prisma.workflowRun.deleteMany({ where: { id: runId } });
    }
    if (templateId) {
      await runUnscoped('remove the workflow-run template test fixture', ['WorkflowTemplate'], () =>
        prisma.workflowTemplate.deleteMany({ where: { id: templateId } })
      );
    }
    if (previousState) {
      await prisma.rollupSweepState.update({
        data: { lastSuccessfulStartAt: previousState.lastSuccessfulStartAt },
        where: { name: SWEEP_NAME },
      });
    } else {
      await prisma.rollupSweepState.deleteMany({ where: { name: SWEEP_NAME } });
    }
    vi.unstubAllEnvs();
  });

  it('rebuilds an old finalized run day and persists the successful sweep watermark', async () => {
    const dirtyCandidates = await runUnscoped(
      'verify the finalized old run is selected as a dirty-day source',
      ['WorkflowRun'],
      () =>
        prisma.workflowRun.findMany({
          select: { id: true },
          where: {
            endedAt: { gt: new Date(now.getTime() - 3_600_000), lte: now },
            startedAt: { lt: new Date(Date.UTC(2026, 10, 14)) },
          },
        })
    );
    expect(dirtyCandidates.map((run) => run.id)).toContain(runId);
    const result = await rollupWorkflowRuns(now.toISOString());
    const [rows, humanRows, reviewRows] = await Promise.all([
      runUnscoped('read the workflow-run rollup test fixture', ['WorkflowRunDailyRollup'], () =>
        prisma.workflowRunDailyRollup.findMany({
          where: { bucketVersion: 4, day: dayStart },
        })
      ),
      runUnscoped('read the human-step rollup test fixture', ['HumanStepDailyRollup'], () =>
        prisma.humanStepDailyRollup.findMany({ where: { bucketVersion: 4, day: dayStart } })
      ),
      runUnscoped('read the review-verdict rollup test fixture', ['ReviewVerdictDailyRollup'], () =>
        prisma.reviewVerdictDailyRollup.findMany({
          where: { bucketVersion: 4, day: dayStart },
        })
      ),
    ]);
    const state = await prisma.rollupSweepState.findUniqueOrThrow({
      select: { lastSuccessfulStartAt: true },
      where: { name: SWEEP_NAME },
    });

    expect(result).toEqual({ days: 2, rows: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runs).toBe(1);
    expect(humanRows).toMatchObject([{ resolvedVia: 'web', steps: 1 }]);
    expect(reviewRows).toMatchObject([{ findings: 1, reviewer: 'SECURITY', verdicts: 1 }]);
    expect(state.lastSuccessfulStartAt).toEqual(now);

    // A day with no runs writes no rollup rows, yet it is marked built so it is not rebuilt forever.
    const emptyRows = await runUnscoped(
      'read the rollup rows of a day with no runs',
      ['WorkflowRunDailyRollup'],
      () => prisma.workflowRunDailyRollup.count({ where: { day: emptyWindow } })
    );
    const markers = await runUnscoped('read the built-day markers', ['RollupBuiltDay'], () =>
      prisma.rollupBuiltDay.findMany({ where: { bucketVersion: 4, day: emptyWindow } })
    );
    expect(emptyRows).toBe(0);
    expect(markers.length).toBeGreaterThan(0);
    expect(await prisma.rollupBuiltDay.count({ where: { bucketVersion: 4, day: dayStart } })).toBe(
      1
    );
  });
});
