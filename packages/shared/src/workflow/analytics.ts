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
  estimatedHumanTimeSaved?: number | null;
  outcomeType?: string | null;
  hadHumanStep?: boolean;
  wasAutonomous?: boolean;
  hasError?: boolean;
  workflowId?: string | null;
  workRequest?: {
    activeWorkflows: { costUsdAccrued: number; temporalWorkflowId?: string }[];
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
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  agentErrorRate: number | null;
  perStepFailureRates: Array<{
    nodeId: string;
    failed: number;
    total: number;
    failureRate: number;
  }>;
  perVersionCounts: Array<{ version: number; count: number }>;
  perOutcome: Array<{ outcomeType: string; runCount: number; totalCost: number }>;
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
const TERMINAL_STATUSES = new Set<string>(['SUCCESS', ...TERMINAL_FAILURE_STATUSES]);
const STEP_STATUSES_TO_SKIP = new Set(['SKIPPED', 'PENDING', 'RUNNING']);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
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
  const costs = runs.map((r) =>
    typeof r.costUsdAccrued === 'number' && r.costUsdAccrued > 0
      ? r.costUsdAccrued
      : (r.workRequest?.activeWorkflows ?? [])
          .filter((aw) => aw.temporalWorkflowId === r.workflowId)
          .reduce((s, aw) => s + aw.costUsdAccrued, 0)
  );
  const runCosts = costs.filter((c) => c > 0);
  const totalCost = runCosts.reduce((s, c) => s + c, 0);

  const perNode = new Map<string, { failed: number; total: number }>();
  for (const s of steps) {
    if (STEP_STATUSES_TO_SKIP.has(s.status)) {
      continue;
    }
    const entry = perNode.get(s.nodeId) ?? { failed: 0, total: 0 };
    entry.total += 1;
    if (s.status === 'FAILED') {
      entry.failed += 1;
    }
    perNode.set(s.nodeId, entry);
  }

  const versionCounts = new Map<number, number>();
  for (const r of runs) {
    versionCounts.set(r.templateVersion, (versionCounts.get(r.templateVersion) ?? 0) + 1);
  }

  const timeSaved = runs.map((r) => r.estimatedHumanTimeSaved ?? 0).filter((m) => m > 0);
  const estimatedHumanTimeSavedTotal =
    timeSaved.length > 0 ? timeSaved.reduce((s, m) => s + m, 0) : null;

  const finishedAutonomy = runs.filter((r) => r.status !== 'RUNNING' && r.wasAutonomous != null);
  const autonomyRate =
    finishedAutonomy.length > 0
      ? finishedAutonomy.filter((r) => r.wasAutonomous).length / finishedAutonomy.length
      : null;

  const finishedHuman = runs.filter((r) => r.status !== 'RUNNING' && r.hadHumanStep != null);
  const humanReviewRate =
    finishedHuman.length > 0
      ? finishedHuman.filter((r) => r.hadHumanStep).length / finishedHuman.length
      : null;

  const finishedError = finished.filter((r) => r.hasError != null);
  const agentErrorRate =
    finishedError.length > 0
      ? finishedError.filter((r) => r.hasError).length / finishedError.length
      : null;

  const byOutcome = new Map<string, { runCount: number; totalCost: number }>();
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!r) {
      continue;
    }
    const c = costs[i] ?? 0;
    const key = r.outcomeType ?? 'unknown';
    const cell = byOutcome.get(key) ?? { runCount: 0, totalCost: 0 };
    cell.runCount += 1;
    cell.totalCost += c;
    byOutcome.set(key, cell);
  }

  return {
    agentErrorRate,
    autonomyRate,
    avgCostPerRun: runCosts.length > 0 ? totalCost / runCosts.length : null,
    estimatedHumanTimeSavedTotal,
    failed,
    humanReviewRate,
    p50DurationMs: percentile(durationsMs, 0.5),
    p95DurationMs: percentile(durationsMs, 0.95),
    perOutcome: Array.from(byOutcome.entries())
      .map(([outcomeType, cell]) => ({ outcomeType, ...cell }))
      .sort((a, b) => b.runCount - a.runCount),
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
  if (finished.length === 0) {
    return null;
  }

  const byVersion = new Map<number, { total: number; succeeded: number }>();
  for (const r of finished) {
    const cell = byVersion.get(r.templateVersion) ?? { succeeded: 0, total: 0 };
    cell.total += 1;
    if (r.status === 'SUCCESS') {
      cell.succeeded += 1;
    }
    byVersion.set(r.templateVersion, cell);
  }
  // Most-trafficked two arms; tie-break by version number for determinism.
  const arms = Array.from(byVersion.entries())
    .map(([version, { total, succeeded }]) => ({ succeeded, total, version }))
    .sort((a, b) => b.total - a.total || a.version - b.version);
  if (arms.length < 2) {
    return null;
  }
  const a = arms[0];
  const b = arms[1];
  if (!a || !b) {
    return null;
  }
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
  estimatedHumanTimeSaved?: number | null;
  outcomeDomain?: string | null;
  outcomeType?: string | null;
  wasAutonomous?: boolean;
  hadHumanStep?: boolean;
  hasError?: boolean;
}

export interface HumanErrorBaselineShallow {
  domain: string;
  outcomeType: string | null;
  sampleSize: number;
  errorRate: number;
}

export interface GlobalAnalyticsResult {
  windowDays: number;
  totalRuns: number;
  /** Terminal/completed runs (SUCCESS + FAILED/TIMED_OUT/CANCELLED). */
  completedRuns: number;
  /** Runs currently in RUNNING status. */
  runningRuns: number;
  succeeded: number;
  failed: number;
  /** Success rate computed over terminal/completed runs only. */
  successRate: number | null;
  totalCost: number;
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    /** Success rate computed over terminal/completed runs only. */
    successRate: number | null;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
  }>;
  perDomain: Array<{
    domain: string;
    totalRuns: number;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
    agentErrorRate: number | null;
    /** Human baseline error rate when the baseline sample size is ≥30; otherwise null. */
    humanErrorRate: number | null;
    /** Point difference between agent and human error rate when both are available. */
    errorRateVsHuman: number | null;
    /** Baseline sample size when a baseline exists; null otherwise. */
    baselineSampleSize: number | null;
  }>;
  perOutcome: Array<{ outcomeType: string; runCount: number; totalCost: number }>;
}

export function computeGlobalAnalytics(
  rows: GlobalAnalyticsTemplateRow[],
  windowDays: number,
  baselines?: HumanErrorBaselineShallow[]
): GlobalAnalyticsResult {
  const totalRuns = rows.length;
  const terminal = rows.filter((r) => isTerminalStatus(r.status));
  const completedRuns = terminal.length;
  const runningRuns = totalRuns - completedRuns;
  const succeeded = terminal.filter((r) => r.status === 'SUCCESS').length;
  const failed = terminal.filter((r) => TERMINAL_FAILURE_STATUSES.has(r.status)).length;
  const successRate = completedRuns > 0 ? succeeded / completedRuns : null;
  const totalCost = rows.reduce((s, r) => s + (r.costUsdAccrued || 0), 0);

  const timeSaved = rows.map((r) => r.estimatedHumanTimeSaved ?? 0).filter((m) => m > 0);
  const estimatedHumanTimeSavedTotal =
    timeSaved.length > 0 ? timeSaved.reduce((s, m) => s + m, 0) : null;

  const finished = rows.filter((r) => r.status !== 'RUNNING');
  const autonomyBase = finished.filter((r) => r.wasAutonomous != null);
  const autonomyRate =
    autonomyBase.length > 0
      ? autonomyBase.filter((r) => r.wasAutonomous).length / autonomyBase.length
      : null;

  const humanBase = finished.filter((r) => r.hadHumanStep != null);
  const humanReviewRate =
    humanBase.length > 0 ? humanBase.filter((r) => r.hadHumanStep).length / humanBase.length : null;

  const byTemplate = new Map<
    string,
    {
      templateName: string;
      totalRuns: number;
      succeeded: number;
      totalCost: number;
      completed: number;
      timeSaved: number;
    }
  >();
  const byDomain = new Map<
    string,
    { totalRuns: number; totalCost: number; timeSaved: number; finished: number; withError: number }
  >();
  const byOutcome = new Map<string, { runCount: number; totalCost: number }>();
  for (const r of rows) {
    const tCell = byTemplate.get(r.templateId) ?? {
      completed: 0,
      succeeded: 0,
      templateName: r.templateName,
      timeSaved: 0,
      totalCost: 0,
      totalRuns: 0,
    };
    tCell.totalRuns += 1;
    tCell.totalCost += r.costUsdAccrued || 0;
    tCell.timeSaved += r.estimatedHumanTimeSaved ?? 0;
    if (isTerminalStatus(r.status)) {
      tCell.completed += 1;
      if (r.status === 'SUCCESS') {
        tCell.succeeded += 1;
      }
    }
    byTemplate.set(r.templateId, tCell);

    const dKey = r.outcomeDomain ?? 'unknown';
    const dCell = byDomain.get(dKey) ?? {
      finished: 0,
      timeSaved: 0,
      totalCost: 0,
      totalRuns: 0,
      withError: 0,
    };
    dCell.totalRuns += 1;
    dCell.totalCost += r.costUsdAccrued || 0;
    dCell.timeSaved += r.estimatedHumanTimeSaved ?? 0;
    if (r.status !== 'RUNNING') {
      dCell.finished += 1;
      if (r.hasError) {
        dCell.withError += 1;
      }
    }
    byDomain.set(dKey, dCell);

    const oKey = r.outcomeType ?? 'unknown';
    const oCell = byOutcome.get(oKey) ?? { runCount: 0, totalCost: 0 };
    oCell.runCount += 1;
    oCell.totalCost += r.costUsdAccrued || 0;
    byOutcome.set(oKey, oCell);
  }

  const baselineByDomain = new Map<string, { sampleSize: number; errorRate: number }>();
  for (const b of baselines ?? []) {
    const existing = baselineByDomain.get(b.domain);
    if (!existing || b.sampleSize > existing.sampleSize) {
      baselineByDomain.set(b.domain, { errorRate: b.errorRate, sampleSize: b.sampleSize });
    }
  }
  return {
    autonomyRate,
    completedRuns,
    estimatedHumanTimeSavedTotal,
    failed,
    humanReviewRate,
    perDomain: Array.from(byDomain.entries())
      .map(([domain, cell]) => {
        const agentErrorRate = cell.finished > 0 ? cell.withError / cell.finished : null;
        const baseline = baselineByDomain.get(domain);
        const baselineSampleSize = baseline ? baseline.sampleSize : null;
        const humanErrorRate =
          baseline && baseline.sampleSize >= MIN_SAMPLES_FOR_SIGNIFICANCE
            ? baseline.errorRate
            : null;
        const errorRateVsHuman =
          agentErrorRate != null && humanErrorRate != null ? agentErrorRate - humanErrorRate : null;
        return {
          agentErrorRate,
          baselineSampleSize,
          domain,
          errorRateVsHuman,
          estimatedHumanTimeSavedTotal: cell.timeSaved > 0 ? cell.timeSaved : null,
          humanErrorRate,
          totalCost: cell.totalCost,
          totalRuns: cell.totalRuns,
        };
      })
      .sort((a, b) => b.totalRuns - a.totalRuns),
    perOutcome: Array.from(byOutcome.entries())
      .map(([outcomeType, cell]) => ({ outcomeType, ...cell }))
      .sort((a, b) => b.runCount - a.runCount),
    perTemplate: Array.from(byTemplate.entries())
      .map(([templateId, cell]) => ({
        estimatedHumanTimeSavedTotal: cell.timeSaved > 0 ? cell.timeSaved : null,
        successRate: cell.completed > 0 ? cell.succeeded / cell.completed : null,
        templateId,
        templateName: cell.templateName,
        totalCost: cell.totalCost,
        totalRuns: cell.totalRuns,
      }))
      .sort((a, b) => b.totalRuns - a.totalRuns),
    runningRuns,
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
