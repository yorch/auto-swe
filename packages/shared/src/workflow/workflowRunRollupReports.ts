import { WORKFLOW_RUN_FAILURE_STATUSES, type WorkflowRunStatus } from '../types/api.js';
import { wilsonInterval } from './analytics.js';
import type { DeliveryMetrics, DeliveryReport } from './reports.js';
import {
  CI_FIX_ROUND_BUCKETS,
  ciFixRoundsFromBuckets,
  combineWorkflowRunRollupRows,
  durationBucketForMs,
  durationPercentileFromBuckets,
  type WorkflowRunRollupRow,
} from './workflowRunRollup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorkflowRunDurationStats {
  averageDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface WorkflowRunTemplateVersionMetrics {
  avgCostPerRun: number | null;
  mergeRate: number | null;
  mergeRateCi95: [number, number] | null;
  p50DurationMs: number | null;
  prMerged: number;
  prOpen: number;
  prOpened: number;
  runs: number;
  succeeded: number;
  successRate: number | null;
  successRateCi95: [number, number] | null;
  version: number;
}

export function qualityMetricsFromRollups(rows: readonly WorkflowRunRollupRow[]) {
  const totals = combineWorkflowRunRollupRows(rows);
  const rejectingPrRuns = totals.runsReviewRejectedWithPr;
  const rejectingMergedRuns = totals.runsReviewRejectedMerged;
  const otherPrRuns = Math.max(0, totals.runsWithPr - rejectingPrRuns);
  const otherMergedRuns = Math.max(0, totals.runsWithPrMerged - rejectingMergedRuns);
  return {
    ciSelfHealRate: totals.runsWithCiFix > 0 ? totals.runsCiHealed / totals.runsWithCiFix : null,
    mergeRateByReviewOutcome: {
      withoutRejectingVerdict: {
        mergedRuns: otherMergedRuns,
        mergeRate: otherPrRuns > 0 ? otherMergedRuns / otherPrRuns : null,
        runsWithPr: otherPrRuns,
      },
      withRejectingVerdict: {
        mergedRuns: rejectingMergedRuns,
        mergeRate: rejectingPrRuns > 0 ? rejectingMergedRuns / rejectingPrRuns : null,
        runsWithPr: rejectingPrRuns,
      },
    },
  };
}

export function dailyRunSeriesFromRollups(
  rows: readonly Pick<WorkflowRunRollupRow, 'day' | 'runs' | 'status'>[],
  windowStart: Date,
  windowEnd: Date,
  liveRows: readonly { startedAt: Date; status: string }[] = []
) {
  const first = Math.floor(windowStart.getTime() / DAY_MS) * DAY_MS;
  const days = new Map<
    string,
    { active: number; completed: number; date: string; failed: number }
  >();
  for (let t = first; t <= windowEnd.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.set(date, { active: 0, completed: 0, date, failed: 0 });
  }
  const add = (startedAt: Date, status: string, count: number) => {
    const cell = days.get(startedAt.toISOString().slice(0, 10));
    if (!cell) {
      return;
    }
    if (status === 'SUCCESS') {
      cell.completed += count;
    } else if (WORKFLOW_RUN_FAILURE_STATUSES.has(status as WorkflowRunStatus)) {
      cell.failed += count;
    } else {
      cell.active += count;
    }
  };
  for (const row of rows) {
    add(row.day, row.status, row.runs);
  }
  for (const row of liveRows) {
    add(row.startedAt, row.status, 1);
  }
  return [...days.values()];
}

export function workflowRunDurationStatsFromRollups(
  rows: readonly Pick<
    WorkflowRunRollupRow,
    'durationBuckets' | 'durationCount' | 'durationMsSum'
  >[],
  liveRows: readonly { endedAt: Date | null; startedAt: Date }[] = []
): WorkflowRunDurationStats {
  const buckets = Array.from({ length: rows[0]?.durationBuckets.length ?? 1 }, () => 0);
  let count = 0;
  let sum = 0;
  for (const row of rows) {
    count += row.durationCount;
    sum += Number(row.durationMsSum);
    for (let index = 0; index < row.durationBuckets.length; index++) {
      buckets[index] = (buckets[index] ?? 0) + (row.durationBuckets[index] ?? 0);
    }
  }
  for (const row of liveRows) {
    if (!row.endedAt) {
      continue;
    }
    const duration = Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
    count++;
    sum += duration;
    const index = durationBucketForMs(duration);
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  if (count === 0) {
    return { averageDurationMs: null, p50DurationMs: null, p95DurationMs: null };
  }
  return {
    averageDurationMs: sum / count,
    p50DurationMs: durationPercentileFromBuckets(buckets, 0.5),
    p95DurationMs: durationPercentileFromBuckets(buckets, 0.95),
  };
}

export function workflowTemplatePerVersionFromRollups(
  rows: readonly WorkflowRunRollupRow[]
): WorkflowRunTemplateVersionMetrics[] {
  const byVersion = new Map<number, WorkflowRunRollupRow[]>();
  for (const row of rows) {
    if (row.templateVersion === null) {
      continue;
    }
    const versionRows = byVersion.get(row.templateVersion) ?? [];
    versionRows.push(row);
    byVersion.set(row.templateVersion, versionRows);
  }
  return [...byVersion.entries()]
    .map(([version, versionRows]) => {
      const totals = combineWorkflowRunRollupRows(versionRows);
      const decided = versionRows
        .filter(
          (row) =>
            row.status === 'SUCCESS' ||
            WORKFLOW_RUN_FAILURE_STATUSES.has(row.status as WorkflowRunStatus)
        )
        .reduce((sum, row) => sum + row.runs, 0);
      const succeeded = versionRows
        .filter((row) => row.status === 'SUCCESS')
        .reduce((sum, row) => sum + row.runs, 0);
      const prOpen = Math.max(0, totals.prsOpened - totals.prsMerged - totals.prsClosedUnmerged);
      const mergeDecided = totals.prsMerged + totals.prsClosedUnmerged;
      return {
        avgCostPerRun: totals.runs > 0 ? totals.costUsd / totals.runs : null,
        mergeRate: mergeDecided > 0 ? totals.prsMerged / mergeDecided : null,
        mergeRateCi95: wilsonInterval(totals.prsMerged, mergeDecided),
        p50DurationMs: totals.p50DurationMs,
        prMerged: totals.prsMerged,
        prOpen,
        prOpened: totals.prsOpened,
        runs: totals.runs,
        succeeded,
        successRate: decided > 0 ? succeeded / decided : null,
        successRateCi95: wilsonInterval(succeeded, decided),
        version,
      };
    })
    .sort((a, b) => a.version - b.version);
}

export function deliveryReportFromRollups(
  rows: readonly WorkflowRunRollupRow[],
  labels: {
    repos?: ReadonlyMap<string, string>;
    teams?: ReadonlyMap<string, string>;
    templates?: ReadonlyMap<string, string>;
  } = {}
): DeliveryReport {
  const metrics = (slice: readonly WorkflowRunRollupRow[]): DeliveryMetrics => {
    const totals = combineWorkflowRunRollupRows(slice);
    const runsSucceeded = slice
      .filter((row) => row.status === 'SUCCESS')
      .reduce((sum, row) => sum + row.runs, 0);
    const fixRounds = ciFixRoundsFromBuckets(totals.ciFixRoundsBuckets);
    return {
      ciFixRounds: fixRounds,
      costPerMergedPr: totals.prsMerged > 0 ? totals.costUsd / totals.prsMerged : null,
      medianTimeToMergeMs: durationPercentileFromBuckets(totals.mergeMsBuckets, 0.5),
      prsCiPassed: totals.prsCiPassed,
      prsMerged: totals.prsMerged,
      runsStarted: totals.runs,
      runsSucceeded,
      runsWithPr: totals.runsWithPr,
      spendUsd: totals.costUsd,
      successRate: totals.runs > 0 ? runsSucceeded / totals.runs : null,
    };
  };
  const group = <K extends string | null>(
    keyOf: (row: WorkflowRunRollupRow) => K,
    includeNull: boolean
  ) => {
    const groups = new Map<K, WorkflowRunRollupRow[]>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null && !includeNull) {
        continue;
      }
      const values = groups.get(key) ?? [];
      values.push(row);
      groups.set(key, values);
    }
    return groups;
  };
  const byRepo = [...group((row) => row.repoId, false).entries()]
    .map(([repoId, grouped]) => ({
      ...metrics(grouped),
      repoId: repoId as string,
      repositoryName: labels.repos?.get(repoId as string) ?? (repoId as string),
    }))
    .sort(
      (a, b) => b.runsStarted - a.runsStarted || a.repositoryName.localeCompare(b.repositoryName)
    );
  const byTemplate = [...group((row) => row.templateId, true).entries()]
    .map(([templateId, grouped]) => ({
      ...metrics(grouped),
      templateId: templateId ?? 'unattributed',
      templateName: templateId ? (labels.templates?.get(templateId) ?? templateId) : 'Unattributed',
    }))
    .sort((a, b) => b.runsStarted - a.runsStarted || a.templateName.localeCompare(b.templateName));
  const byTeam = [...group((row) => row.teamId, true).entries()]
    .map(([teamId, grouped]) => ({
      ...metrics(grouped),
      teamId,
      teamName: teamId ? (labels.teams?.get(teamId) ?? teamId) : 'Unattributed',
    }))
    .sort((a, b) => b.runsStarted - a.runsStarted || a.teamName.localeCompare(b.teamName));
  return { ...metrics(rows), byRepo, byTeam, byTemplate };
}

export function emptyCiFixRoundsBuckets(): number[] {
  return Array.from({ length: CI_FIX_ROUND_BUCKETS }, () => 0);
}
