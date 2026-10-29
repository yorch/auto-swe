import { WORKFLOW_RUN_FAILURE_STATUSES, type WorkflowRunStatus } from '../types/api.js';
import { wilsonInterval } from './analytics.js';
import {
  type DeliveryMetrics,
  type DeliveryReport,
  type HitlReport,
  type QualityReport,
  REVIEW_SEVERITIES,
  REVIEWER_TYPES,
} from './reports.js';
import {
  CI_FIX_ROUND_BUCKETS,
  ciFixRoundsFromBuckets,
  combineWorkflowRunRollupRows,
  durationBucketForMs,
  durationPercentileFromBuckets,
  type HumanStepDailyRollupRow,
  type ReviewVerdictDailyRollupRow,
  type WorkflowRunRollupRow,
} from './workflowRunRollup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function humanStepMetricsFromRollups(
  rows: readonly HumanStepDailyRollupRow[],
  names: ReadonlyMap<string, string | null> = new Map()
): Pick<HitlReport, 'byApprover' | 'byKind' | 'byVia' | 'medianWaitMs' | 'p95WaitMs' | 'timedOut'> {
  const byKind: Record<string, Record<string, number>> = {};
  const byVia: Record<string, number> = {};
  const waitBuckets = Array.from({ length: rows[0]?.waitBuckets.length ?? 1 }, () => 0);
  const approvers = new Map<
    string,
    { automated: number; interactive: number; waitBuckets: number[] }
  >();
  let timedOut = 0;
  for (const row of rows) {
    byKind[row.kind] ??= {};
    byKind[row.kind][row.status] = (byKind[row.kind][row.status] ?? 0) + row.steps;
    timedOut += row.timedOut;
    let waits = 0;
    for (let index = 0; index < row.waitBuckets.length; index++) {
      const count = row.waitBuckets[index] ?? 0;
      waitBuckets[index] = (waitBuckets[index] ?? 0) + count;
      waits += count;
    }
    if (row.status !== 'RESOLVED' || waits === 0) {
      continue;
    }
    byVia[row.resolvedVia] = (byVia[row.resolvedVia] ?? 0) + waits;
    if (!row.resolvedBy) {
      continue;
    }
    const group = approvers.get(row.resolvedBy) ?? {
      automated: 0,
      interactive: 0,
      waitBuckets: Array.from({ length: waitBuckets.length }, () => 0),
    };
    for (let index = 0; index < row.waitBuckets.length; index++) {
      const count = row.waitBuckets[index] ?? 0;
      group.waitBuckets[index] = (group.waitBuckets[index] ?? 0) + count;
    }
    if (row.resolvedVia === 'web' || row.resolvedVia === 'slack') {
      group.interactive += waits;
    } else if (
      row.resolvedVia === 'api_token' ||
      row.resolvedVia === 'mcp' ||
      row.resolvedVia === 'assistant'
    ) {
      group.automated += waits;
    }
    approvers.set(row.resolvedBy, group);
  }
  const byApprover = [...approvers.entries()]
    .map(([resolvedBy, group]) => {
      const name = names.get(resolvedBy) ?? resolvedBy;
      const resolved = group.waitBuckets.reduce((sum, count) => sum + count, 0);
      return {
        automated: group.automated,
        interactive: group.interactive,
        medianWaitMs: durationPercentileFromBuckets(group.waitBuckets, 0.5),
        name,
        resolved,
      };
    })
    .sort((a, b) => b.resolved - a.resolved || a.name.localeCompare(b.name));
  return {
    byApprover,
    byKind,
    byVia,
    medianWaitMs: durationPercentileFromBuckets(waitBuckets, 0.5),
    p95WaitMs: durationPercentileFromBuckets(waitBuckets, 0.95),
    timedOut,
  };
}

export function qualityReviewFromRollups(
  rows: readonly Pick<
    ReviewVerdictDailyRollupRow,
    | 'approved'
    | 'categoryCounts'
    | 'findings'
    | 'nonVerdictRows'
    | 'reviewer'
    | 'severity'
    | 'verdicts'
  >[]
): QualityReport['review'] {
  const reviewers = new Map(
    REVIEWER_TYPES.map((reviewer) => [
      reviewer,
      {
        approved: 0,
        categories: new Map<string, number>(),
        findingsTotal: 0,
        severityCounts: Object.fromEntries(
          REVIEW_SEVERITIES.map((severity) => [severity, 0])
        ) as QualityReport['review']['byReviewer'][number]['severityCounts'],
        verdicts: 0,
      },
    ])
  );
  let nonVerdictRows = 0;
  for (const row of rows) {
    nonVerdictRows += row.nonVerdictRows;
    if (
      !row.reviewer ||
      !row.severity ||
      row.approved === null ||
      !REVIEWER_TYPES.includes(row.reviewer as (typeof REVIEWER_TYPES)[number]) ||
      !REVIEW_SEVERITIES.includes(row.severity as (typeof REVIEW_SEVERITIES)[number])
    ) {
      continue;
    }
    const group = reviewers.get(row.reviewer as (typeof REVIEWER_TYPES)[number]);
    if (!group) {
      continue;
    }
    group.verdicts += row.verdicts;
    group.approved += row.approved ? row.verdicts : 0;
    group.severityCounts[row.severity as (typeof REVIEW_SEVERITIES)[number]] += row.verdicts;
    group.findingsTotal += row.findings;
    for (const [category, count] of Object.entries(row.categoryCounts)) {
      group.categories.set(category, (group.categories.get(category) ?? 0) + count);
    }
  }
  return {
    byReviewer: REVIEWER_TYPES.map((reviewer) => {
      const group = reviewers.get(reviewer);
      const verdicts = group?.verdicts ?? 0;
      return {
        approvalRate: verdicts > 0 ? (group?.approved ?? 0) / verdicts : null,
        approved: group?.approved ?? 0,
        findingsTotal: group?.findingsTotal ?? 0,
        reviewer,
        severityCounts:
          group?.severityCounts ??
          (Object.fromEntries(
            REVIEW_SEVERITIES.map((severity) => [severity, 0])
          ) as QualityReport['review']['byReviewer'][number]['severityCounts']),
        topCategories: [...(group?.categories ?? new Map()).entries()]
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
          .slice(0, 5),
        verdicts,
      };
    }),
    nonVerdictRows,
  };
}

export interface WorkflowRunDurationStats {
  averageDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

function exactDurationPercentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
  return sorted[rank] ?? null;
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

export interface ExactLiveMergeDuration {
  durationMs: number;
  repoId: string | null;
  teamId: string | null;
  templateId: string | null;
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
  if (rows.length === 0) {
    const durations = liveRows.flatMap((row) =>
      row.endedAt ? [Math.max(0, row.endedAt.getTime() - row.startedAt.getTime())] : []
    );
    if (durations.length === 0) {
      return { averageDurationMs: null, p50DurationMs: null, p95DurationMs: null };
    }
    return {
      averageDurationMs: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
      p50DurationMs: exactDurationPercentile(durations, 0.5),
      p95DurationMs: exactDurationPercentile(durations, 0.95),
    };
  }
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
  rows: readonly WorkflowRunRollupRow[],
  exactLiveDurationsByVersion: ReadonlyMap<number, readonly number[]> = new Map()
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
        p50DurationMs: exactLiveDurationsByVersion.has(version)
          ? exactDurationPercentile(exactLiveDurationsByVersion.get(version) ?? [], 0.5)
          : totals.p50DurationMs,
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
  } = {},
  exactLiveMergeDurations?: readonly ExactLiveMergeDuration[]
): DeliveryReport {
  const metrics = (
    slice: readonly WorkflowRunRollupRow[],
    exactMerges?: readonly ExactLiveMergeDuration[]
  ): DeliveryMetrics => {
    const totals = combineWorkflowRunRollupRows(slice);
    const runsSucceeded = slice
      .filter((row) => row.status === 'SUCCESS')
      .reduce((sum, row) => sum + row.runs, 0);
    const fixRounds = ciFixRoundsFromBuckets(totals.ciFixRoundsBuckets);
    return {
      ciFixRounds: fixRounds,
      costPerMergedPr: totals.prsMerged > 0 ? totals.costUsd / totals.prsMerged : null,
      medianTimeToMergeMs: exactMerges
        ? exactDurationPercentile(
            exactMerges.map((merge) => merge.durationMs),
            0.5
          )
        : durationPercentileFromBuckets(totals.mergeMsBuckets, 0.5),
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
      ...metrics(
        grouped,
        exactLiveMergeDurations?.filter((merge) => merge.repoId === repoId)
      ),
      repoId: repoId as string,
      repositoryName: labels.repos?.get(repoId as string) ?? (repoId as string),
    }))
    .sort(
      (a, b) => b.runsStarted - a.runsStarted || a.repositoryName.localeCompare(b.repositoryName)
    );
  const byTemplate = [...group((row) => row.templateId, true).entries()]
    .map(([templateId, grouped]) => ({
      ...metrics(
        grouped,
        exactLiveMergeDurations?.filter((merge) => merge.templateId === templateId)
      ),
      templateId: templateId ?? 'unattributed',
      templateName: templateId ? (labels.templates?.get(templateId) ?? templateId) : 'Unattributed',
    }))
    .sort((a, b) => b.runsStarted - a.runsStarted || a.templateName.localeCompare(b.templateName));
  const byTeam = [...group((row) => row.teamId, true).entries()]
    .map(([teamId, grouped]) => ({
      ...metrics(
        grouped,
        exactLiveMergeDurations?.filter((merge) => merge.teamId === teamId)
      ),
      teamId,
      teamName: teamId ? (labels.teams?.get(teamId) ?? teamId) : 'Unattributed',
    }))
    .sort((a, b) => b.runsStarted - a.runsStarted || a.teamName.localeCompare(b.teamName));
  return { ...metrics(rows, exactLiveMergeDurations), byRepo, byTeam, byTemplate };
}

export function emptyCiFixRoundsBuckets(): number[] {
  return Array.from({ length: CI_FIX_ROUND_BUCKETS }, () => 0);
}
