import { describe, expect, it } from 'vitest';
import { computeDailyRunSeries } from './analytics.js';
import { computeDeliveryReport, computeHitlReport, computeQualityReport } from './reports.js';
import {
  buildHumanStepDailyRollups,
  buildReviewVerdictDailyRollups,
  buildWorkflowRunDailyRollups,
  ciFixRoundsFromBuckets,
  combineWorkflowRunRollupRows,
  DURATION_BUCKET_BOUNDS_MS,
  durationBucketForMs,
  durationPercentileFromBuckets,
  WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
  workflowRunRollupInputFromRun,
} from './workflowRunRollup.js';
import {
  dailyRunSeriesFromRollups,
  deliveryReportFromRollups,
  humanStepMetricsFromRollups,
  qualityReviewFromRollups,
  workflowRunDurationStatsFromRollups,
  workflowTemplatePerVersionFromRollups,
} from './workflowRunRollupReports.js';

describe('WorkflowRun daily rollups', () => {
  it('uses one run mapper for sweep and live inputs, including the workspace/repo fallback', () => {
    const run = {
      attributedOrgId: 'org',
      attributedTeamId: 'team',
      connectionId: 'workspace-connection',
      costUsdAccrued: 0,
      endedAt: null,
      estimatedHumanTimeSaved: null,
      hadHumanStep: null,
      id: 'run-1',
      outcomeDomain: null,
      outcomeType: null,
      startedAt: new Date('2026-10-01T10:00:00Z'),
      status: 'SUCCESS',
      templateId: 'template',
      templateVersion: 1,
      wasAutonomous: true,
      workflowId: 'workflow-1',
      workRequest: {
        activeWorkflows: [
          {
            costUsdAccrued: 2,
            repoId: 'repo',
            temporalWorkflowId: 'workflow-1',
          },
        ],
      },
    };
    const mappedForSweep = workflowRunRollupInputFromRun(run);
    const mappedForLive = workflowRunRollupInputFromRun(run);
    expect(mappedForSweep).toMatchObject({
      legacyCostUsd: 2,
      repoId: 'repo',
    });
    expect(
      buildWorkflowRunDailyRollups({
        now: run.startedAt,
        pullRequests: [],
        runs: [mappedForSweep],
        steps: [],
        traces: [],
      })
    ).toEqual(
      buildWorkflowRunDailyRollups({
        now: run.startedAt,
        pullRequests: [],
        runs: [mappedForLive],
        steps: [],
        traces: [],
      })
    );
  });
  it('aggregates successful time saved, PRs, fallback spend, and CI fix histograms', () => {
    const start = new Date('2026-10-01T10:00:00Z');
    const rows = buildWorkflowRunDailyRollups({
      now: start,
      pullRequests: [
        {
          ciStatus: 'PASSED',
          mergedAt: new Date(start.getTime() + 2000),
          runId: '1',
          status: 'MERGED',
        },
        { ciStatus: 'PENDING', mergedAt: null, runId: '2', status: 'OPEN' },
      ],
      runs: [1, 2].map((id) => ({
        attributedOrgId: 'org',
        attributedTeamId: 'team',
        costUsdAccrued: id === 1 ? 0 : 1,
        endedAt: new Date(start.getTime() + id * 1000),
        estimatedHumanTimeSaved: id === 1 ? 30 : 20,
        hadHumanStep: false,
        id: String(id),
        legacyCostUsd: 2,
        outcomeDomain: null,
        outcomeType: null,
        repoId: 'repo',
        startedAt: start,
        status: 'SUCCESS' as const,
        templateId: 'template',
        templateVersion: 1,
        wasAutonomous: true,
      })),
      steps: [
        { runId: '1', status: 'PASSED', stepName: 'executeCIFixImplementation' },
        { runId: '1', status: 'FAILED', stepName: 'executeCIFixImplementation' },
      ],
      traces: [],
    });
    expect(rows).toHaveLength(1);
    const summary = combineWorkflowRunRollupRows(rows);
    expect(summary).toMatchObject({
      costUsd: 3,
      prsMerged: 1,
      runs: 2,
      timeSavedMinutes: 50,
    });
    expect(rows[0]?.ciFixRoundsBuckets[2]).toBe(1);
    expect(rows[0]?.ciFixRoundsBuckets[0]).toBe(1);
    expect(summary.averageFixRounds).toBe(1);
    expect(summary.p95FixRounds).toBe(2);
  });

  it('uses versioned sub-second and logarithmic duration buckets', () => {
    expect(WORKFLOW_RUN_ROLLUP_BUCKET_VERSION).toBe(2);
    expect(DURATION_BUCKET_BOUNDS_MS.slice(0, 7)).toEqual([10, 25, 50, 100, 250, 500, 1000]);
    expect(durationBucketForMs(10)).toBe(0);
    expect(durationBucketForMs(11)).toBe(1);
    expect(durationBucketForMs(250)).toBe(4);

    const firstBucket = Array.from({ length: DURATION_BUCKET_BOUNDS_MS.length + 1 }, () => 0);
    firstBucket[0] = 3;
    expect(durationPercentileFromBuckets(firstBucket, 0.5)).toBe(5);

    const logBucket = Array.from({ length: DURATION_BUCKET_BOUNDS_MS.length + 1 }, () => 0);
    logBucket[7] = 3;
    expect(durationPercentileFromBuckets(logBucket, 0.5)).toBeCloseTo(
      Math.sqrt((DURATION_BUCKET_BOUNDS_MS[6] ?? 1000) * (DURATION_BUCKET_BOUNDS_MS[7] ?? 1100))
    );

    const cap = 30 * 24 * 60 * 60 * 1000;
    const overflow = Array.from({ length: DURATION_BUCKET_BOUNDS_MS.length + 1 }, () => 0);
    overflow[overflow.length - 1] = 1;
    expect(durationBucketForMs(cap + 1)).toBe(DURATION_BUCKET_BOUNDS_MS.length);
    expect(durationPercentileFromBuckets(overflow, 0.95)).toBe(cap);

    const start = new Date('2026-10-01T10:00:00Z');
    const row = buildWorkflowRunDailyRollups({
      now: start,
      pullRequests: [],
      runs: [
        {
          attributedOrgId: null,
          attributedTeamId: null,
          costUsdAccrued: 0,
          endedAt: new Date(start.getTime() + 250),
          estimatedHumanTimeSaved: null,
          hadHumanStep: null,
          id: 'sub-second-run',
          outcomeDomain: null,
          outcomeType: null,
          repoId: null,
          startedAt: start,
          status: 'SUCCESS',
          templateId: 'template',
          templateVersion: 1,
          wasAutonomous: null,
        },
      ],
      steps: [],
      traces: [],
    })[0];
    expect(row?.bucketVersion).toBe(2);
    expect(row?.durationBuckets[durationBucketForMs(250)]).toBe(1);

    const rounds = Array.from({ length: 21 }, () => 0);
    rounds[20] = 2;
    expect(ciFixRoundsFromBuckets(rounds)).toEqual({ avgPerRun: 20, p95PerRun: 20 });
  });

  it('estimates lognormal p50 and p95 from buckets within five percent of exact ranks', () => {
    let state = 17;
    const random = () => {
      state = (state * 16807) % 2_147_483_647;
      return state / 2_147_483_647;
    };
    const durations: number[] = [];
    for (let index = 0; index < 20_000; index++) {
      const u1 = Math.max(Number.MIN_VALUE, random());
      const u2 = random();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      durations.push(Math.exp(8 + 0.8 * normal));
    }
    const buckets = Array.from({ length: DURATION_BUCKET_BOUNDS_MS.length + 1 }, () => 0);
    for (const duration of durations) {
      buckets[durationBucketForMs(duration)] = (buckets[durationBucketForMs(duration)] ?? 0) + 1;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    for (const q of [0.5, 0.95]) {
      const exact = sorted[Math.ceil(sorted.length * q) - 1] ?? 0;
      const estimate = durationPercentileFromBuckets(buckets, q) ?? 0;
      expect(Math.abs(estimate - exact) / exact).toBeLessThan(0.05);
    }
  });

  it('uses exact ranks for live-only duration windows and template versions', () => {
    const start = new Date('2026-10-01T10:00:00Z');
    const liveRows = [100, 200, 300, 400, 500].map((duration, index) => ({
      endedAt: new Date(start.getTime() + duration),
      startedAt: start,
      templateVersion: 1,
      ...{
        attributedOrgId: null,
        attributedTeamId: null,
        costUsdAccrued: 0,
        estimatedHumanTimeSaved: null,
        hadHumanStep: null,
        id: `live-${index}`,
        outcomeDomain: null,
        outcomeType: null,
        repoId: null,
        status: 'SUCCESS',
        templateId: 'template',
        wasAutonomous: null,
        workflowId: `workflow-${index}`,
      },
    }));
    expect(workflowRunDurationStatsFromRollups([], liveRows)).toMatchObject({
      p50DurationMs: 300,
      p95DurationMs: 500,
    });
    const liveRollups = buildWorkflowRunDailyRollups({
      now: start,
      pullRequests: [],
      runs: liveRows.map(workflowRunRollupInputFromRun),
      steps: [],
      traces: [],
    });
    const exactMerges = [100, 200, 300].map((durationMs) => ({
      durationMs,
      repoId: null,
      teamId: null,
      templateId: 'template',
    }));
    expect(deliveryReportFromRollups(liveRollups, {}, exactMerges)).toMatchObject({
      byTeam: [{ medianTimeToMergeMs: 200 }],
      medianTimeToMergeMs: 200,
    });
    expect(
      workflowTemplatePerVersionFromRollups(
        liveRollups,
        new Map([[1, [100, 200, 300, 400, 500]]])
      )[0]?.p50DurationMs
    ).toBe(300);
  });

  it('ignores PR attribution outside the run cohort', () => {
    const run = {
      attributedOrgId: null,
      attributedTeamId: null,
      costUsdAccrued: 1,
      endedAt: null,
      estimatedHumanTimeSaved: null,
      hadHumanStep: null,
      id: 'cohort-run',
      outcomeDomain: null,
      outcomeType: null,
      repoId: null,
      startedAt: new Date('2026-10-01T00:00:00Z'),
      status: 'SUCCESS',
      templateId: 'template',
      templateVersion: 1,
      wasAutonomous: null,
    };
    const rows = buildWorkflowRunDailyRollups({
      now: run.startedAt,
      pullRequests: [
        { ciStatus: 'PASSED', mergedAt: new Date(), runId: 'outside-run', status: 'MERGED' },
      ],
      runs: [run],
      steps: [],
      traces: [],
    });
    expect(combineWorkflowRunRollupRows(rows)).toMatchObject({
      prsCiPassed: 0,
      prsMerged: 0,
      prsOpened: 0,
      runsWithPr: 0,
    });
  });

  it('matches live delivery metrics and daily series, with duration percentiles', () => {
    const start = new Date('2026-10-01T10:00:00Z');
    const liveRuns = [
      {
        attributedOrgId: 'org-1',
        attributedTeamId: 'team-1',
        costUsdAccrued: 10,
        endedAt: new Date(start.getTime() + 60_000),
        estimatedHumanTimeSaved: 20,
        hadHumanStep: false,
        id: 'run-1',
        outcomeDomain: null,
        outcomeType: null,
        repoId: 'repo-1',
        startedAt: start,
        status: 'SUCCESS' as const,
        templateId: 'template-1',
        templateVersion: 1,
        wasAutonomous: true,
        workflowId: 'wf-1',
      },
      {
        attributedOrgId: 'org-1',
        attributedTeamId: 'team-1',
        costUsdAccrued: 5,
        endedAt: new Date(start.getTime() + 60 * 60_000 + 60_000),
        estimatedHumanTimeSaved: null,
        hadHumanStep: true,
        id: 'run-2',
        outcomeDomain: null,
        outcomeType: null,
        repoId: 'repo-1',
        startedAt: new Date(start.getTime() + 60 * 60_000),
        status: 'FAILED' as const,
        templateId: 'template-1',
        templateVersion: 1,
        wasAutonomous: false,
        workflowId: 'wf-2',
      },
    ];
    const prs = [
      {
        ciStatus: 'PASSED',
        mergedAt: new Date(start.getTime() + 60_000),
        runId: 'run-1',
        status: 'MERGED',
      },
      { ciStatus: 'PENDING', mergedAt: null, runId: 'run-2', status: 'OPEN' },
    ];
    const steps = [
      { runId: 'run-1', status: 'PASSED', stepName: 'executeCIFixImplementation' },
      { runId: 'run-2', status: 'FAILED', stepName: 'executeCIFixImplementation' },
    ];
    const rollups = buildWorkflowRunDailyRollups({
      now: start,
      pullRequests: prs,
      runs: liveRuns,
      steps,
      traces: [],
    });
    const liveDelivery = computeDeliveryReport(
      liveRuns.map((run) => ({
        ciFixRounds: steps.filter((step) => step.runId === run.id).length,
        costUsdAccrued: run.costUsdAccrued,
        id: run.id,
        pullRequests: prs
          .filter((pr) => pr.runId === run.id)
          .map(({ ciStatus, mergedAt }) => ({ ciStatus, mergedAt })),
        repoId: run.repoId,
        repositoryName: 'acme/api',
        startedAt: run.startedAt,
        status: run.status,
        teamId: run.attributedTeamId,
        teamName: 'Platform',
        templateId: run.templateId,
        templateName: 'Build',
        workflowId: run.workflowId,
      }))
    );
    const rollupDelivery = deliveryReportFromRollups(rollups, {
      repos: new Map([['repo-1', 'acme/api']]),
      teams: new Map([['team-1', 'Platform']]),
      templates: new Map([['template-1', 'Build']]),
    });
    expect(rollupDelivery).toMatchObject({
      byTeam: [{ runsStarted: 2, spendUsd: 15, teamId: 'team-1', teamName: 'Platform' }],
      ciFixRounds: liveDelivery.ciFixRounds,
      costPerMergedPr: liveDelivery.costPerMergedPr,
      prsCiPassed: liveDelivery.prsCiPassed,
      prsMerged: liveDelivery.prsMerged,
      runsStarted: liveDelivery.runsStarted,
      runsSucceeded: liveDelivery.runsSucceeded,
      runsWithPr: liveDelivery.runsWithPr,
      spendUsd: liveDelivery.spendUsd,
      successRate: liveDelivery.successRate,
    });
    expect(durationBucketForMs(rollupDelivery.medianTimeToMergeMs ?? 0)).toBe(
      durationBucketForMs(liveDelivery.medianTimeToMergeMs ?? 0)
    );
    const rollupDuration = workflowRunDurationStatsFromRollups(rollups);
    expect(rollupDuration.p50DurationMs).not.toBeNull();
    expect(rollupDuration.p95DurationMs).not.toBeNull();

    const windowEnd = new Date('2026-10-02T00:00:00Z');
    const liveDaily = computeDailyRunSeries(liveRuns, start, new Date(windowEnd.getTime() - 1));
    const rollupDaily = dailyRunSeriesFromRollups(
      rollups,
      start,
      new Date(windowEnd.getTime() - 1)
    );
    expect(rollupDaily).toEqual(liveDaily);
  });

  it('matches live HITL and reviewer metrics from daily rollups', () => {
    const requestedAt = new Date('2026-10-01T10:00:00.000Z');
    const steps = [
      {
        kind: 'APPROVAL',
        requestedAt,
        resolvedAt: new Date(requestedAt.getTime() + 5),
        resolvedBy: 'user-1',
        resolvedByName: 'Ada',
        resolvedVia: 'web',
        status: 'RESOLVED',
      },
      {
        kind: 'REVIEW',
        requestedAt,
        resolvedAt: null,
        resolvedBy: null,
        resolvedByName: null,
        resolvedVia: null,
        status: 'TIMED_OUT',
      },
    ];
    const liveHitl = computeHitlReport({
      autonomyDecisions: [],
      now: requestedAt,
      pendingSteps: [],
      windowSteps: steps,
    });
    const rollupHitl = humanStepMetricsFromRollups(
      buildHumanStepDailyRollups(
        steps.map((step) => ({ ...step, orgId: 'org-1', teamId: 'team-1' }))
      ),
      new Map([['user-1', 'Ada']])
    );
    expect(rollupHitl).toEqual({
      byApprover: liveHitl.byApprover,
      byKind: liveHitl.byKind,
      byVia: liveHitl.byVia,
      medianWaitMs: liveHitl.medianWaitMs,
      p95WaitMs: liveHitl.p95WaitMs,
      timedOut: liveHitl.timedOut,
    });

    const runs = [
      {
        attributedOrgId: 'org-1',
        attributedTeamId: 'team-1',
        id: 'run-1',
        startedAt: requestedAt,
      },
    ];
    const traces = [
      {
        error: null,
        outputJson: {
          approved: false,
          findings: [{ category: 'correctness' }, { category: 'correctness' }],
          reviewer: 'SECURITY',
          severity: 'CRITICAL',
        },
        runId: 'run-1',
      },
      { error: null, outputJson: { approved: true }, runId: 'run-1' },
    ];
    const liveReview = computeQualityReport({
      pullRequests: [],
      reviewTraces: traces,
      runs: [{ id: 'run-1' }],
      steps: [],
    }).review;
    const rollupReview = qualityReviewFromRollups(buildReviewVerdictDailyRollups({ runs, traces }));
    expect(rollupReview).toEqual(liveReview);
  });
});
