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

import {
  type ApprovalLatencyStats,
  type ApprovalLatencySummary,
  isTerminalWorkflowRunStatus,
  WORKFLOW_RUN_FAILURE_STATUSES,
  type WorkflowRunStatus,
} from '../types/api.js';

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

export interface AnalyticsPullRequestRow {
  runId: string | null;
  templateVersion: number | null;
  status: string;
}

/**
 * A leading branch prefix: `<nodeId>[<index>]/`, as the interpreter builds when
 * it walks a `fanOut` branch's subgraph.
 */
const BRANCH_PREFIX_RE = /^[^/]*\[\d+\]\//;

/** Strip every leading branch prefix from a recorded node id. */
function stripBranchPrefix(recordingId: string): string {
  let out = recordingId;
  while (BRANCH_PREFIX_RE.test(out)) {
    out = out.replace(BRANCH_PREFIX_RE, '');
  }
  return out;
}

/**
 * The node a recorded step belongs to.
 *
 * Inside a `fanOut` the interpreter records `<branchNode>[<index>]/<nodeId>`, one
 * level per enclosing branch, so a single node's rows arrive under many ids
 * (`fan[0]/impl`, `fan[1]/impl`) and a per-node failure rate is split across
 * them. This maps them back to the node the spec declares.
 *
 * Recovering the node id from the text alone cannot be unambiguous: the branch
 * form *is* `<something>[<digits>]/`, and a node id is an arbitrary string that
 * could be written that way. So when the caller can supply `knownNodeIds` — the
 * ids the template versions in the window declare — the id itself wins, and
 * otherwise the longest `/`-bounded suffix that is a known id does. Without
 * them, a leading branch prefix is stripped, which is right for every id the
 * interpreter generates and wrong only for an author who names a node the way
 * the interpreter names a branch.
 */
export function normalizeRecordingNodeId(
  recordingId: string,
  knownNodeIds?: ReadonlySet<string>
): string {
  if (knownNodeIds?.has(recordingId)) {
    return recordingId;
  }
  if (knownNodeIds && knownNodeIds.size > 0) {
    // Earliest boundary first: the candidate is longest there, so a node whose
    // id itself contains a `/` is preferred over its own tail.
    for (let i = recordingId.indexOf('/'); i !== -1; i = recordingId.indexOf('/', i + 1)) {
      const candidate = recordingId.slice(i + 1);
      if (knownNodeIds.has(candidate)) {
        return candidate;
      }
    }
  }
  return stripBranchPrefix(recordingId);
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
  perVersion: Array<{
    version: number;
    runs: number;
    succeeded: number;
    successRate: number | null;
    successRateCi95: [number, number] | null;
    avgCostPerRun: number | null;
    p50DurationMs: number | null;
    prOpened: number;
    prOpen: number;
    prMerged: number;
    mergeRate: number | null;
    mergeRateCi95: [number, number] | null;
  }>;
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

const STEP_STATUSES_TO_SKIP = new Set(['SKIPPED', 'PENDING', 'RUNNING']);

/**
 * Terminal = finished: every status but RUNNING, SKIPPED included (see
 * `WORKFLOW_RUN_TERMINAL_STATUSES` in `types/api.ts`). Success rates are taken over the
 * *decided* runs only — SUCCESS plus the failure statuses — because a skipped
 * run neither succeeded nor failed and would otherwise read as a failure.
 */
function isTerminalStatus(status: string): boolean {
  return isTerminalWorkflowRunStatus(status);
}

function isFailureStatus(status: string): boolean {
  return WORKFLOW_RUN_FAILURE_STATUSES.has(status as WorkflowRunStatus);
}

function isDecidedStatus(status: string): boolean {
  return status === 'SUCCESS' || isFailureStatus(status);
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx] ?? null;
}

export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) {
    return null;
  }
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function computeAnalytics(
  runs: AnalyticsRunRow[],
  steps: AnalyticsStepRow[],
  windowDays: number,
  /**
   * Node ids the template versions in the window declare, so a fan-out branch's
   * recorded ids fold back onto the node they came from (see
   * {@link normalizeRecordingNodeId}). Omit and a leading branch prefix is
   * stripped structurally.
   */
  knownNodeIds?: ReadonlySet<string>,
  pullRequests: AnalyticsPullRequestRow[] = []
): AnalyticsResult {
  const totalRuns = runs.length;
  const finished = runs.filter((r) => isTerminalStatus(r.status));
  const succeeded = finished.filter((r) => r.status === 'SUCCESS').length;
  const failed = finished.filter((r) => isFailureStatus(r.status)).length;
  const decided = succeeded + failed;
  const successRate = decided > 0 ? succeeded / decided : null;

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
    // One node, one row: a fan-out branch records under a prefixed id, and
    // counting those separately split the node's rate across its branches.
    const nodeId = normalizeRecordingNodeId(s.nodeId, knownNodeIds);
    const entry = perNode.get(nodeId) ?? { failed: 0, total: 0 };
    entry.total += 1;
    if (s.status === 'FAILED') {
      entry.failed += 1;
    }
    perNode.set(nodeId, entry);
  }

  const versionCounts = new Map<number, number>();
  const versionRuns = new Map<number, AnalyticsRunRow[]>();
  for (const r of runs) {
    versionCounts.set(r.templateVersion, (versionCounts.get(r.templateVersion) ?? 0) + 1);
    const grouped = versionRuns.get(r.templateVersion) ?? [];
    grouped.push(r);
    versionRuns.set(r.templateVersion, grouped);
  }
  const prsByVersion = new Map<
    number,
    { closedUnmerged: number; merged: number; opened: number; open: number }
  >();
  for (const pr of pullRequests) {
    if (!pr.runId || pr.templateVersion === null) {
      continue;
    }
    const grouped = prsByVersion.get(pr.templateVersion) ?? {
      closedUnmerged: 0,
      merged: 0,
      open: 0,
      opened: 0,
    };
    grouped.opened += 1;
    if (pr.status === 'MERGED') {
      grouped.merged += 1;
    } else if (pr.status === 'CLOSED') {
      grouped.closedUnmerged += 1;
    } else if (pr.status === 'OPEN') {
      grouped.open += 1;
    }
    prsByVersion.set(pr.templateVersion, grouped);
  }
  const perVersion = Array.from(versionRuns.entries())
    .map(([version, versionRows]) => {
      const decided = versionRows.filter((r) => isDecidedStatus(r.status));
      const succeeded = decided.filter((r) => r.status === 'SUCCESS').length;
      const versionCosts = versionRows.map((r) =>
        typeof r.costUsdAccrued === 'number' && r.costUsdAccrued > 0
          ? r.costUsdAccrued
          : (r.workRequest?.activeWorkflows ?? [])
              .filter((aw) => aw.temporalWorkflowId === r.workflowId)
              .reduce((sum, aw) => sum + aw.costUsdAccrued, 0)
      );
      const durations = versionRows
        .filter((r) => isTerminalStatus(r.status) && r.endedAt)
        .map((r) => (r.endedAt as Date).getTime() - r.startedAt.getTime())
        .sort((a, b) => a - b);
      const prs = prsByVersion.get(version) ?? {
        closedUnmerged: 0,
        merged: 0,
        open: 0,
        opened: 0,
      };
      const decidedPrs = prs.merged + prs.closedUnmerged;
      return {
        avgCostPerRun:
          versionRows.length > 0
            ? versionCosts.reduce((sum, cost) => sum + cost, 0) / versionRows.length
            : null,
        mergeRate: decidedPrs > 0 ? prs.merged / decidedPrs : null,
        mergeRateCi95: wilsonInterval(prs.merged, decidedPrs),
        p50DurationMs: percentile(durations, 0.5),
        prMerged: prs.merged,
        prOpen: prs.open,
        prOpened: prs.opened,
        runs: versionRows.length,
        succeeded,
        successRate: decided.length > 0 ? succeeded / decided.length : null,
        successRateCi95: wilsonInterval(succeeded, decided.length),
        version,
      };
    })
    .sort((a, b) => a.version - b.version);

  const timeSaved = runs
    .filter((r) => r.status === 'SUCCESS')
    .map((r) => r.estimatedHumanTimeSaved ?? 0)
    .filter((m) => m > 0);
  const estimatedHumanTimeSavedTotal =
    timeSaved.length > 0 ? timeSaved.reduce((s, m) => s + m, 0) : null;

  const finishedAutonomy = runs.filter(
    (r) => isTerminalStatus(r.status) && r.wasAutonomous != null
  );
  const autonomyRate =
    finishedAutonomy.length > 0
      ? finishedAutonomy.filter((r) => r.wasAutonomous).length / finishedAutonomy.length
      : null;

  const finishedHuman = runs.filter((r) => isTerminalStatus(r.status) && r.hadHumanStep != null);
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
    perVersion,
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
  const finished = runs.filter((r) => isDecidedStatus(r.status));
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

export interface GlobalAnalyticsGroup {
  _count: { _all: number };
  _sum: { costUsdAccrued: number | null; estimatedHumanTimeSaved: number | null };
  hasError: boolean | null;
  hadHumanStep: boolean | null;
  outcomeDomain: string | null;
  outcomeType: string | null;
  status: string;
  templateId: string;
  wasAutonomous: boolean | null;
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
  /** Terminal/completed runs — every status but RUNNING, SKIPPED included. */
  completedRuns: number;
  /** Runs currently in RUNNING status. */
  runningRuns: number;
  succeeded: number;
  failed: number;
  /** Success rate over decided runs only (SUCCESS + FAILED/TIMED_OUT/CANCELLED). */
  successRate: number | null;
  totalCost: number;
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    /** Success rate over decided runs only (SUCCESS + FAILED/TIMED_OUT/CANCELLED). */
    successRate: number | null;
    succeeded: number;
    failed: number;
    totalCost: number;
    avgCostPerRun: number;
    autonomyRate: number | null;
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
  const failed = terminal.filter((r) => isFailureStatus(r.status)).length;
  const successRate = succeeded + failed > 0 ? succeeded / (succeeded + failed) : null;
  const totalCost = rows.reduce((s, r) => s + (r.costUsdAccrued || 0), 0);

  const timeSaved = rows
    .filter((r) => r.status === 'SUCCESS')
    .map((r) => r.estimatedHumanTimeSaved ?? 0)
    .filter((m) => m > 0);
  const estimatedHumanTimeSavedTotal =
    timeSaved.length > 0 ? timeSaved.reduce((s, m) => s + m, 0) : null;

  const finished = rows.filter((r) => isTerminalStatus(r.status));
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
      failed: number;
      totalCost: number;
      completed: number;
      timeSaved: number;
      autonomous: number;
      autonomyBase: number;
    }
  >();
  const byDomain = new Map<
    string,
    { totalRuns: number; totalCost: number; timeSaved: number; finished: number; withError: number }
  >();
  const byOutcome = new Map<string, { runCount: number; totalCost: number }>();
  for (const r of rows) {
    const tCell = byTemplate.get(r.templateId) ?? {
      autonomous: 0,
      autonomyBase: 0,
      completed: 0,
      failed: 0,
      succeeded: 0,
      templateName: r.templateName,
      timeSaved: 0,
      totalCost: 0,
      totalRuns: 0,
    };
    tCell.totalRuns += 1;
    tCell.totalCost += r.costUsdAccrued || 0;
    if (r.status === 'SUCCESS') {
      tCell.timeSaved += r.estimatedHumanTimeSaved ?? 0;
    }
    if (isDecidedStatus(r.status)) {
      tCell.completed += 1;
      if (r.status === 'SUCCESS') {
        tCell.succeeded += 1;
      } else if (isFailureStatus(r.status)) {
        tCell.failed += 1;
      }
    }
    if (isTerminalStatus(r.status) && r.wasAutonomous != null) {
      tCell.autonomyBase += 1;
      if (r.wasAutonomous) {
        tCell.autonomous += 1;
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
    if (r.status === 'SUCCESS') {
      dCell.timeSaved += r.estimatedHumanTimeSaved ?? 0;
    }
    if (isTerminalStatus(r.status)) {
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
        autonomyRate: cell.autonomyBase > 0 ? cell.autonomous / cell.autonomyBase : null,
        avgCostPerRun: cell.totalRuns > 0 ? cell.totalCost / cell.totalRuns : 0,
        estimatedHumanTimeSavedTotal: cell.timeSaved > 0 ? cell.timeSaved : null,
        failed: cell.failed,
        succeeded: cell.succeeded,
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

export function computeGlobalAnalyticsFromGroups(
  groups: GlobalAnalyticsGroup[],
  templateNames: ReadonlyMap<string, string>,
  windowDays: number,
  baselines?: HumanErrorBaselineShallow[]
): GlobalAnalyticsResult {
  const totals = {
    autonomous: 0,
    autonomyBase: 0,
    completed: 0,
    failed: 0,
    human: 0,
    humanBase: 0,
    running: 0,
    saved: 0,
    savedPositive: false,
    succeeded: 0,
    totalCost: 0,
    totalRuns: 0,
  };
  const templates = new Map<
    string,
    {
      autonomous: number;
      autonomyBase: number;
      completed: number;
      failed: number;
      human: number;
      humanBase: number;
      name: string;
      runs: number;
      saved: number;
      succeeded: number;
      totalCost: number;
    }
  >();
  const domains = new Map<
    string,
    {
      errors: number;
      finished: number;
      runs: number;
      saved: number;
      totalCost: number;
    }
  >();
  const outcomes = new Map<string, { runCount: number; totalCost: number }>();
  for (const group of groups) {
    const count = group._count._all;
    const cost = group._sum.costUsdAccrued ?? 0;
    const saved = group.status === 'SUCCESS' ? (group._sum.estimatedHumanTimeSaved ?? 0) : 0;
    const terminal = isTerminalStatus(group.status);
    const decided = isDecidedStatus(group.status);
    const success = group.status === 'SUCCESS' ? count : 0;
    const failure = isFailureStatus(group.status) ? count : 0;
    totals.totalRuns += count;
    totals.totalCost += cost;
    totals.running += terminal ? 0 : count;
    totals.completed += terminal ? count : 0;
    totals.succeeded += success;
    totals.failed += failure;
    if (saved > 0) {
      totals.saved += saved;
      totals.savedPositive = true;
    }
    if (terminal && group.wasAutonomous != null) {
      totals.autonomyBase += count;
      if (group.wasAutonomous) {
        totals.autonomous += count;
      }
    }
    if (terminal && group.hadHumanStep != null) {
      totals.humanBase += count;
      if (group.hadHumanStep) {
        totals.human += count;
      }
    }
    const template = templates.get(group.templateId) ?? {
      autonomous: 0,
      autonomyBase: 0,
      completed: 0,
      failed: 0,
      human: 0,
      humanBase: 0,
      name: templateNames.get(group.templateId) ?? 'Unknown template',
      runs: 0,
      saved: 0,
      succeeded: 0,
      totalCost: 0,
    };
    template.runs += count;
    template.totalCost += cost;
    template.saved += saved;
    template.completed += decided ? count : 0;
    template.succeeded += success;
    template.failed += failure;
    if (terminal && group.wasAutonomous != null) {
      template.autonomyBase += count;
      if (group.wasAutonomous) {
        template.autonomous += count;
      }
    }
    if (terminal && group.hadHumanStep != null) {
      template.humanBase += count;
      if (group.hadHumanStep) {
        template.human += count;
      }
    }
    templates.set(group.templateId, template);

    const domainKey = group.outcomeDomain ?? 'unknown';
    const domain = domains.get(domainKey) ?? {
      errors: 0,
      finished: 0,
      runs: 0,
      saved: 0,
      totalCost: 0,
    };
    domain.runs += count;
    domain.totalCost += cost;
    domain.saved += saved;
    if (terminal) {
      domain.finished += count;
      if (group.hasError) {
        domain.errors += count;
      }
    }
    domains.set(domainKey, domain);

    const outcomeKey = group.outcomeType ?? 'unknown';
    const outcome = outcomes.get(outcomeKey) ?? { runCount: 0, totalCost: 0 };
    outcome.runCount += count;
    outcome.totalCost += cost;
    outcomes.set(outcomeKey, outcome);
  }
  const baselineByDomain = new Map<string, { sampleSize: number; errorRate: number }>();
  for (const baseline of baselines ?? []) {
    const existing = baselineByDomain.get(baseline.domain);
    if (!existing || baseline.sampleSize > existing.sampleSize) {
      baselineByDomain.set(baseline.domain, {
        errorRate: baseline.errorRate,
        sampleSize: baseline.sampleSize,
      });
    }
  }
  return {
    autonomyRate: totals.autonomyBase > 0 ? totals.autonomous / totals.autonomyBase : null,
    completedRuns: totals.completed,
    estimatedHumanTimeSavedTotal: totals.savedPositive ? totals.saved : null,
    failed: totals.failed,
    humanReviewRate: totals.humanBase > 0 ? totals.human / totals.humanBase : null,
    perDomain: [...domains]
      .map(([domain, cell]) => {
        const baseline = baselineByDomain.get(domain);
        const agentErrorRate = cell.finished > 0 ? cell.errors / cell.finished : null;
        const humanErrorRate =
          baseline && baseline.sampleSize >= MIN_SAMPLES_FOR_SIGNIFICANCE
            ? baseline.errorRate
            : null;
        return {
          agentErrorRate,
          baselineSampleSize: baseline?.sampleSize ?? null,
          domain,
          errorRateVsHuman:
            agentErrorRate != null && humanErrorRate != null
              ? agentErrorRate - humanErrorRate
              : null,
          estimatedHumanTimeSavedTotal: cell.saved > 0 ? cell.saved : null,
          humanErrorRate,
          totalCost: cell.totalCost,
          totalRuns: cell.runs,
        };
      })
      .sort((a, b) => b.totalRuns - a.totalRuns),
    perOutcome: [...outcomes]
      .map(([outcomeType, cell]) => ({ outcomeType, ...cell }))
      .sort((a, b) => b.runCount - a.runCount),
    perTemplate: [...templates]
      .map(([templateId, cell]) => ({
        autonomyRate: cell.autonomyBase > 0 ? cell.autonomous / cell.autonomyBase : null,
        avgCostPerRun: cell.runs > 0 ? cell.totalCost / cell.runs : 0,
        estimatedHumanTimeSavedTotal: cell.saved > 0 ? cell.saved : null,
        failed: cell.failed,
        succeeded: cell.succeeded,
        successRate: cell.completed > 0 ? cell.succeeded / cell.completed : null,
        templateId,
        templateName: cell.name,
        totalCost: cell.totalCost,
        totalRuns: cell.runs,
      }))
      .sort((a, b) => b.totalRuns - a.totalRuns),
    runningRuns: totals.running,
    succeeded: totals.succeeded,
    successRate:
      totals.succeeded + totals.failed > 0
        ? totals.succeeded / (totals.succeeded + totals.failed)
        : null,
    totalCost: totals.totalCost,
    totalRuns: totals.totalRuns,
    windowDays,
  };
}

/** Runs started per UTC day in a window, split the way the over-time chart stacks them. */
export interface DailyRunCount {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  completed: number;
  failed: number;
  /** Everything that is not finished yet or ended some other way (running, waiting, skipped). */
  active: number;
}

/**
 * One row per UTC day from `windowStart`'s day through `windowEnd`'s, oldest first, so a
 * quiet day shows as zero rather than a gap. Rows outside the window are ignored.
 */
export function computeDailyRunSeries(
  rows: Pick<GlobalAnalyticsTemplateRow, 'startedAt' | 'status'>[],
  windowStart: Date,
  windowEnd: Date
): DailyRunCount[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const first = Math.floor(windowStart.getTime() / DAY_MS) * DAY_MS;
  const days = new Map<string, DailyRunCount>();
  for (let t = first; t <= windowEnd.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.set(date, { active: 0, completed: 0, date, failed: 0 });
  }
  for (const r of rows) {
    const cell = days.get(r.startedAt.toISOString().slice(0, 10));
    if (!cell) {
      continue;
    }
    if (r.status === 'SUCCESS') {
      cell.completed += 1;
    } else if (isFailureStatus(r.status)) {
      cell.failed += 1;
    } else {
      cell.active += 1;
    }
  }
  return [...days.values()];
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

/** A human step as the latency rollup reads it. */
export interface ApprovalLatencyRow {
  status: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  templateId: string;
  templateName: string;
}

/** Most templates the per-template breakdown lists. */
export const APPROVAL_LATENCY_TEMPLATE_LIMIT = 50;

function approvalStats(rows: ApprovalLatencyRow[]): ApprovalLatencyStats {
  // Only an answered step has a wait: a pending one is still running (right-censored), and a
  // timed-out or cancelled one was closed by the system, so its "wait" is the deadline, not a
  // person's response time.
  const waitsMs = rows
    .filter((r) => r.status === 'RESOLVED' && r.resolvedAt !== null)
    .map((r) => (r.resolvedAt as Date).getTime() - r.requestedAt.getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return {
    cancelled: count('CANCELLED'),
    pending: count('PENDING'),
    resolved: {
      count: waitsMs.length,
      p50Ms: percentile(waitsMs, 0.5),
      p95Ms: percentile(waitsMs, 0.95),
    },
    timedOut: count('TIMED_OUT'),
  };
}

/** Wait-time figures for the human steps requested in a window, overall and per template. */
export function computeApprovalLatency(
  rows: ApprovalLatencyRow[],
  isTruncated: boolean
): ApprovalLatencySummary {
  const byTemplate = new Map<string, { name: string; rows: ApprovalLatencyRow[] }>();
  for (const row of rows) {
    const group = byTemplate.get(row.templateId) ?? { name: row.templateName, rows: [] };
    group.rows.push(row);
    byTemplate.set(row.templateId, group);
  }
  const perTemplate = [...byTemplate.entries()]
    .sort(([, a], [, b]) => b.rows.length - a.rows.length || a.name.localeCompare(b.name))
    .slice(0, APPROVAL_LATENCY_TEMPLATE_LIMIT)
    .map(([templateId, group]) => ({
      ...approvalStats(group.rows),
      templateId,
      templateName: group.name,
    }));
  return { ...approvalStats(rows), isTruncated, perTemplate };
}
