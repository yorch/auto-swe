/**
 * Aggregate rollups for a single workflow template's recent runs.
 *
 * Pure function — accepts pre-fetched rows and returns plain JSON. The shape
 * matches the WorkflowTemplateAnalytics API type so the gateway route is a
 * thin wrapper over a Prisma query.
 *
 * Cost is summed across every `ActiveWorkflow` tied to a run's `WorkRequest`
 * because epic decompositions create multiple activeWorkflows under one
 * work-request — summing matches what the user actually paid.
 */

export interface AnalyticsRunRow {
  endedAt: Date | null;
  startedAt: Date;
  status: string;
  templateVersion: number;
  workRequest: {
    activeWorkflows: { costUsdAccrued: number }[];
  } | null;
}

export interface AnalyticsStepRow {
  nodeId: string;
  status: string;
}

export interface AnalyticsResult {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  totalCost: number;
  avgCostPerRun: number | null;
  perStepFailureRates: Array<{
    nodeId: string;
    failed: number;
    total: number;
    failureRate: number;
  }>;
  perVersionCounts: Array<{ version: number; count: number }>;
}

const TERMINAL_FAILURE_STATUSES = new Set(['FAILED', 'TIMED_OUT', 'CANCELLED']);
const STEP_STATUSES_TO_SKIP = new Set(['SKIPPED', 'PENDING']);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? null;
}

export function computeAnalytics(
  runs: AnalyticsRunRow[],
  steps: AnalyticsStepRow[],
  windowDays: number
): AnalyticsResult {
  const totalRuns = runs.length;
  const finished = runs.filter((r) => r.status !== 'RUNNING');
  const succeeded = finished.filter((r) => r.status === 'SUCCESS').length;
  const failed = finished.filter((r) => TERMINAL_FAILURE_STATUSES.has(r.status)).length;
  const successRate = finished.length > 0 ? succeeded / finished.length : null;

  const durationsMs = finished
    .filter((r) => r.endedAt)
    .map((r) => (r.endedAt as Date).getTime() - r.startedAt.getTime())
    .sort((a, b) => a - b);

  const runCosts = runs
    .map((r) => (r.workRequest?.activeWorkflows ?? []).reduce((s, aw) => s + aw.costUsdAccrued, 0))
    .filter((c) => c > 0);
  const totalCost = runCosts.reduce((s, c) => s + c, 0);

  const perNode = new Map<string, { failed: number; total: number }>();
  for (const s of steps) {
    if (STEP_STATUSES_TO_SKIP.has(s.status)) continue;
    const entry = perNode.get(s.nodeId) ?? { failed: 0, total: 0 };
    entry.total += 1;
    if (s.status === 'FAILED') entry.failed += 1;
    perNode.set(s.nodeId, entry);
  }

  const versionCounts = new Map<number, number>();
  for (const r of runs) {
    versionCounts.set(r.templateVersion, (versionCounts.get(r.templateVersion) ?? 0) + 1);
  }

  return {
    avgCostPerRun: runCosts.length > 0 ? totalCost / runCosts.length : null,
    failed,
    p50DurationMs: percentile(durationsMs, 0.5),
    p95DurationMs: percentile(durationsMs, 0.95),
    perStepFailureRates: Array.from(perNode.entries())
      .map(([nodeId, { failed: f, total }]) => ({
        failed: f,
        failureRate: total > 0 ? f / total : 0,
        nodeId,
        total,
      }))
      .sort((a, b) => b.failureRate - a.failureRate),
    perVersionCounts: Array.from(versionCounts.entries())
      .map(([version, count]) => ({ count, version }))
      .sort((a, b) => a.version - b.version),
    succeeded,
    successRate,
    totalCost,
    totalRuns,
    windowDays,
  };
}
