/**
 * Aggregate rollups for a single workflow template's recent runs.
 *
 * Pure function — accepts pre-fetched rows and returns plain JSON. The shape
 * matches the WorkflowTemplateAnalytics API type so the gateway route is a
 * thin wrapper over a Prisma query.
 *
 * Phase-8: cost is read from the denormalized `WorkflowRun.costUsdAccrued`
 * column populated by `finalizeWorkflowRun` (no more workRequest →
 * activeWorkflow join at read time). For backwards compat the optional
 * `workRequest.activeWorkflows` shape is still accepted and falls back to
 * summing across activeWorkflows when the denormalized field is unset (still
 * RUNNING, or pre-phase-8 rows in the same table).
 */

export interface AnalyticsRunRow {
  endedAt: Date | null;
  startedAt: Date;
  status: string;
  templateVersion: number;
  costUsdAccrued?: number;
  workRequest?: {
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
  /**
   * Phase-8 A/B significance hint. Populated only when at least two versions
   * have N ≥ {@link MIN_SAMPLES_FOR_SIGNIFICANCE} runs; otherwise `null` so
   * the UI can render "not enough data yet" without doing its own threshold
   * check. The hint uses a two-proportion z-test on success rate between the
   * two most-trafficked versions in the window — good enough to flag
   * "you have a clear winner" or "still noisy."
   */
  significanceHint: SignificanceHint | null;
}

export interface SignificanceHint {
  versionA: number;
  versionB: number;
  nA: number;
  nB: number;
  successRateA: number;
  successRateB: number;
  zScore: number;
  /** Two-tailed p-value (approximate; normal-distribution CDF). */
  pValue: number;
  /** Convenience flag: pValue < 0.05 AND both arms have ≥ MIN_SAMPLES runs. */
  isSignificant: boolean;
}

/** Minimum runs per arm before we report a significance hint at all. */
export const MIN_SAMPLES_FOR_SIGNIFICANCE = 30;

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

  // Phase-8: prefer the denormalized run-level cost column. Fall back to the
  // legacy workRequest → activeWorkflow sum if the column wasn't populated
  // (still RUNNING, or a row that pre-dates finalize-time write).
  const runCosts = runs
    .map((r) =>
      typeof r.costUsdAccrued === 'number' && r.costUsdAccrued > 0
        ? r.costUsdAccrued
        : (r.workRequest?.activeWorkflows ?? []).reduce((s, aw) => s + aw.costUsdAccrued, 0)
    )
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
    significanceHint: computeSignificanceHint(runs),
    succeeded,
    successRate,
    totalCost,
    totalRuns,
    windowDays,
  };
}

/**
 * Two-proportion z-test on success rate between the two most-trafficked
 * versions in the window. Returns null when fewer than two arms cross
 * {@link MIN_SAMPLES_FOR_SIGNIFICANCE}.
 *
 * This is a deliberately cheap, frequentist approximation — we surface it as
 * a hint, not a verdict. The web UI badges "significant" only when the
 * `isSignificant` field is true; otherwise it shows the raw counts and lets
 * the team make the call.
 */
function computeSignificanceHint(runs: AnalyticsRunRow[]): SignificanceHint | null {
  const finished = runs.filter((r) => r.status !== 'RUNNING');
  if (finished.length === 0) return null;

  // Bucket finished runs by version.
  const byVersion = new Map<number, { total: number; succeeded: number }>();
  for (const r of finished) {
    const cell = byVersion.get(r.templateVersion) ?? { succeeded: 0, total: 0 };
    cell.total += 1;
    if (r.status === 'SUCCESS') cell.succeeded += 1;
    byVersion.set(r.templateVersion, cell);
  }
  // Take the two arms with the most runs (most-trafficked → most reliable
  // comparison). Tie-break by version number for determinism.
  const arms = Array.from(byVersion.entries())
    .map(([version, { total, succeeded }]) => ({ succeeded, total, version }))
    .sort((a, b) => b.total - a.total || a.version - b.version);
  if (arms.length < 2) return null;
  const a = arms[0];
  const b = arms[1];
  if (!a || !b) return null;
  if (a.total < MIN_SAMPLES_FOR_SIGNIFICANCE || b.total < MIN_SAMPLES_FOR_SIGNIFICANCE) {
    return null;
  }
  const pA = a.succeeded / a.total;
  const pB = b.succeeded / b.total;
  const pPooled = (a.succeeded + b.succeeded) / (a.total + b.total);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / a.total + 1 / b.total));
  const zScore = se === 0 ? 0 : (pA - pB) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(zScore)));
  return {
    isSignificant: pValue < 0.05,
    nA: a.total,
    nB: b.total,
    pValue,
    successRateA: pA,
    successRateB: pB,
    versionA: a.version,
    versionB: b.version,
    zScore,
  };
}

/**
 * Phase-8 cross-template rollup. Used by `/api/v1/workflow-templates/analytics`
 * to surface platform-wide success / cost numbers without forcing the user to
 * click into every template.
 */
export interface GlobalAnalyticsTemplateRow {
  templateId: string;
  templateName: string;
  status: string;
  costUsdAccrued: number;
  endedAt: Date | null;
  startedAt: Date;
}

export interface GlobalAnalyticsResult {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalCost: number;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    successRate: number | null;
    totalCost: number;
  }>;
}

export function computeGlobalAnalytics(
  rows: GlobalAnalyticsTemplateRow[],
  windowDays: number
): GlobalAnalyticsResult {
  const totalRuns = rows.length;
  const finished = rows.filter((r) => r.status !== 'RUNNING');
  const succeeded = finished.filter((r) => r.status === 'SUCCESS').length;
  const failed = finished.filter((r) => TERMINAL_FAILURE_STATUSES.has(r.status)).length;
  const successRate = finished.length > 0 ? succeeded / finished.length : null;
  const totalCost = rows.reduce((s, r) => s + (r.costUsdAccrued || 0), 0);

  const byTemplate = new Map<
    string,
    {
      templateName: string;
      totalRuns: number;
      succeeded: number;
      totalCost: number;
      finished: number;
    }
  >();
  for (const r of rows) {
    const cell = byTemplate.get(r.templateId) ?? {
      finished: 0,
      succeeded: 0,
      templateName: r.templateName,
      totalCost: 0,
      totalRuns: 0,
    };
    cell.totalRuns += 1;
    cell.totalCost += r.costUsdAccrued || 0;
    if (r.status !== 'RUNNING') {
      cell.finished += 1;
      if (r.status === 'SUCCESS') cell.succeeded += 1;
    }
    byTemplate.set(r.templateId, cell);
  }
  return {
    failed,
    perTemplate: Array.from(byTemplate.entries())
      .map(([templateId, cell]) => ({
        successRate: cell.finished > 0 ? cell.succeeded / cell.finished : null,
        templateId,
        templateName: cell.templateName,
        totalCost: cell.totalCost,
        totalRuns: cell.totalRuns,
      }))
      .sort((a, b) => b.totalRuns - a.totalRuns),
    succeeded,
    successRate,
    totalCost,
    totalRuns,
    windowDays,
  };
}

/**
 * Approximation of the standard normal CDF (Abramowitz & Stegun 26.2.17).
 * Error < 7.5e-8 — well within what we need for a p-value display.
 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
