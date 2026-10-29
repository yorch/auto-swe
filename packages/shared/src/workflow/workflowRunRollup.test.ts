import { describe, expect, it } from 'vitest';
import {
  buildWorkflowRunDailyRollups,
  ciFixRoundsFromBuckets,
  combineWorkflowRunRollupRows,
  durationBucketForMs,
  durationPercentileFromBuckets,
} from './workflowRunRollup.js';

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
        status: 'SUCCESS',
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
});
