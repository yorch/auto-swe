import { describe, expect, it } from 'vitest';
import { computeDailyRunSeries } from './analytics.js';
import { computeDeliveryReport } from './reports.js';
import {
  buildWorkflowRunDailyRollups,
  ciFixRoundsFromBuckets,
  combineWorkflowRunRollupRows,
  durationBucketForMs,
  durationPercentileFromBuckets,
} from './workflowRunRollup.js';
import {
  dailyRunSeriesFromRollups,
  deliveryReportFromRollups,
  workflowRunDurationStatsFromRollups,
} from './workflowRunRollupReports.js';

describe('WorkflowRun daily rollups', () => {
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

  it('buckets durations geometrically and caps CI rounds at the overflow bucket', () => {
    const durations = Array.from({ length: 31 }, () => 0);
    durations[durationBucketForMs(1000)] = 2;
    expect(durationPercentileFromBuckets(durations, 0.5)).toBe(500);

    const rounds = Array.from({ length: 21 }, () => 0);
    rounds[20] = 2;
    expect(ciFixRoundsFromBuckets(rounds)).toEqual({ avgPerRun: 20, p95PerRun: 20 });
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

  it('matches live delivery metrics and daily series, with merge percentiles in the same bucket', () => {
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
    expect(durationBucketForMs(rollupDuration.p50DurationMs ?? 0)).toBe(
      durationBucketForMs(60_000)
    );
    expect(durationBucketForMs(rollupDuration.p95DurationMs ?? 0)).toBe(
      durationBucketForMs(60_000)
    );

    const windowEnd = new Date('2026-10-02T00:00:00Z');
    const liveDaily = computeDailyRunSeries(liveRuns, start, new Date(windowEnd.getTime() - 1));
    const rollupDaily = dailyRunSeriesFromRollups(
      rollups,
      start,
      new Date(windowEnd.getTime() - 1)
    );
    expect(rollupDaily).toEqual(liveDaily);
  });
});
