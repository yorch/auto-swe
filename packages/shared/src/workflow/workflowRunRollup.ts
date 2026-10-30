import { parseReviewVerdict } from './reports.js';

export const WORKFLOW_RUN_DAY_MS = 24 * 60 * 60 * 1000;
export const WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS = 30;
export const WORKFLOW_RUN_ROLLUP_BUCKET_VERSION = 3;
export const CI_FIX_ROUND_BUCKETS = 21;
export const CI_FIX_ROUND_OVERFLOW = 20;

export const DURATION_BUCKET_BOUNDS_MS: readonly number[] = (() => {
  const bounds = [10, 25, 50, 100, 250, 500, 1000];
  while ((bounds.at(-1) ?? 1000) < 30 * WORKFLOW_RUN_DAY_MS) {
    bounds.push(Math.min(30 * WORKFLOW_RUN_DAY_MS, Math.round((bounds.at(-1) ?? 1000) * 1.1)));
  }
  return bounds;
})();

export interface WorkflowRunRollupRunInput {
  attributedOrgId: string | null;
  attributedTeamId: string | null;
  costUsdAccrued: number;
  endedAt: Date | null;
  estimatedHumanTimeSaved: number | null;
  hadHumanStep: boolean | null;
  id: string;
  launchedById?: string | null;
  legacyCostUsd?: number;
  outcomeDomain: string | null;
  outcomeType: string | null;
  repoId: string | null;
  startedAt: Date;
  status: string;
  templateId: string;
  templateVersion: number;
  wasAutonomous: boolean | null;
}

export function workflowRunRollupInputFromRun(run: {
  attributedOrgId: string | null;
  attributedTeamId: string | null;
  connectionId?: string | null;
  costUsdAccrued: number | { toNumber(): number };
  endedAt: Date | null;
  estimatedHumanTimeSaved: number | null;
  hadHumanStep: boolean | null;
  id: string;
  launchedById?: string | null;
  outcomeDomain: string | null;
  outcomeType: string | null;
  startedAt: Date;
  status: string;
  templateId: string;
  templateVersion: number;
  wasAutonomous: boolean | null;
  workflowId: string;
  workRequest?: {
    activeWorkflows: readonly {
      costUsdAccrued: number | { toNumber(): number };
      repoId: string | null;
      temporalWorkflowId: string;
    }[];
  } | null;
}): WorkflowRunRollupRunInput {
  const activeWorkflow = run.workRequest?.activeWorkflows.find(
    (workflow) => workflow.temporalWorkflowId === run.workflowId
  );
  const toNumber = (value: number | { toNumber(): number }) =>
    typeof value === 'number' ? value : value.toNumber();
  return {
    attributedOrgId: run.attributedOrgId,
    attributedTeamId: run.attributedTeamId,
    costUsdAccrued: toNumber(run.costUsdAccrued),
    endedAt: run.endedAt,
    estimatedHumanTimeSaved: run.estimatedHumanTimeSaved,
    hadHumanStep: run.hadHumanStep,
    id: run.id,
    launchedById: run.launchedById ?? null,
    legacyCostUsd: activeWorkflow ? toNumber(activeWorkflow.costUsdAccrued) : 0,
    outcomeDomain: run.outcomeDomain,
    outcomeType: run.outcomeType,
    repoId: activeWorkflow?.repoId ?? run.connectionId ?? null,
    startedAt: run.startedAt,
    status: run.status,
    templateId: run.templateId,
    templateVersion: run.templateVersion,
    wasAutonomous: run.wasAutonomous,
  };
}

export function workflowRunRepoIdFromRun(run: {
  connectionId?: string | null;
  workflowId: string;
  workRequest?: {
    activeWorkflows: readonly { repoId: string | null; temporalWorkflowId: string }[];
  } | null;
}): string | null {
  return (
    run.workRequest?.activeWorkflows.find(
      (workflow) => workflow.temporalWorkflowId === run.workflowId
    )?.repoId ??
    run.connectionId ??
    null
  );
}

export interface WorkflowRunRollupPullRequestInput {
  ciStatus: string;
  mergedAt: Date | null;
  runId: string;
  status: string;
}

export interface WorkflowRunRollupStepInput {
  runId: string;
  status: string;
  stepName: string | null;
}

export interface WorkflowRunRollupTraceInput {
  error: string | null;
  outputJson: unknown;
  runId: string | null;
}

export interface WorkflowRunRollupRow {
  builtAt: Date;
  bucketVersion: number;
  ciFixAttempts: number;
  ciFixRoundsBuckets: number[];
  costUsd: number;
  day: Date;
  dimensionKey: string;
  durationBuckets: number[];
  durationCount: number;
  durationMsSum: bigint;
  hadHumanStep: boolean | null;
  launchedById: string | null;
  mergeMsBuckets: number[];
  orgId: string | null;
  outcomeDomain: string | null;
  outcomeType: string | null;
  prsCiPassed: number;
  prsClosedUnmerged: number;
  prsMerged: number;
  prsOpened: number;
  repoId: string | null;
  runs: number;
  runsCiHealed: number;
  runsReviewRejected: number;
  runsReviewRejectedMerged: number;
  runsReviewRejectedWithPr: number;
  runsWithCiFix: number;
  runsWithPr: number;
  runsWithPrMerged: number;
  status: string;
  teamId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  timeSavedMinutes: number;
  wasAutonomous: boolean | null;
}

export interface BuildWorkflowRunRollupsInput {
  now?: Date;
  pullRequests: WorkflowRunRollupPullRequestInput[];
  runs: WorkflowRunRollupRunInput[];
  steps: WorkflowRunRollupStepInput[];
  traces: WorkflowRunRollupTraceInput[];
}

function bucketIndex(value: number): number {
  const index = DURATION_BUCKET_BOUNDS_MS.findIndex((bound) => value <= bound);
  return index === -1 ? DURATION_BUCKET_BOUNDS_MS.length : index;
}

function durationBuckets(): number[] {
  return Array.from({ length: DURATION_BUCKET_BOUNDS_MS.length + 1 }, () => 0);
}

export function durationBucketForMs(value: number): number {
  return bucketIndex(Math.max(0, value));
}

export function durationPercentileFromBuckets(
  buckets: readonly number[],
  q: number
): number | null {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return null;
  }
  const rank = Math.max(0, Math.min(total - 1, Math.ceil(total * q) - 1));
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    const count = buckets[i] ?? 0;
    if (rank < cumulative + count) {
      if (i >= DURATION_BUCKET_BOUNDS_MS.length) {
        return DURATION_BUCKET_BOUNDS_MS.at(-1) ?? 30 * WORKFLOW_RUN_DAY_MS;
      }
      const lower = i === 0 ? 0 : (DURATION_BUCKET_BOUNDS_MS[i - 1] ?? 0);
      const upper = DURATION_BUCKET_BOUNDS_MS[i] ?? 0;
      const position = count === 1 ? 0.5 : (rank - cumulative) / (count - 1);
      if (lower === 0) {
        return upper * position;
      }
      return Math.exp(Math.log(lower) + (Math.log(upper) - Math.log(lower)) * position);
    }
    cumulative += count;
  }
  return null;
}

export function ciFixRoundsFromBuckets(buckets: readonly number[]): {
  avgPerRun: number | null;
  p95PerRun: number | null;
} {
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < CI_FIX_ROUND_BUCKETS; i++) {
    const count = buckets[i] ?? 0;
    total += count;
    weighted += i * count;
  }
  if (total === 0) {
    return { avgPerRun: null, p95PerRun: null };
  }
  const rank = Math.ceil(total * 0.95) - 1;
  let cumulative = 0;
  let p95PerRun: number | null = null;
  for (let i = 0; i < CI_FIX_ROUND_BUCKETS; i++) {
    cumulative += buckets[i] ?? 0;
    if (cumulative > rank) {
      p95PerRun = i;
      break;
    }
  }
  return {
    avgPerRun: weighted / total,
    p95PerRun,
  };
}

const addBucket = (buckets: number[], index: number) => {
  buckets[index] = (buckets[index] ?? 0) + 1;
};

export function buildWorkflowRunDailyRollups(
  input: BuildWorkflowRunRollupsInput
): WorkflowRunRollupRow[] {
  const now = input.now ?? new Date();
  const prsByRun = new Map<string, WorkflowRunRollupPullRequestInput[]>();
  for (const pr of input.pullRequests) {
    const prs = prsByRun.get(pr.runId) ?? [];
    prs.push(pr);
    prsByRun.set(pr.runId, prs);
  }
  const ciFixes = new Map<string, number>();
  for (const step of input.steps) {
    if (
      step.stepName === 'executeCIFixImplementation' &&
      (step.status === 'PASSED' || step.status === 'FAILED')
    ) {
      ciFixes.set(step.runId, (ciFixes.get(step.runId) ?? 0) + 1);
    }
  }
  const rejected = new Set<string>();
  for (const trace of input.traces) {
    if (!trace.runId || trace.error) {
      continue;
    }
    const verdict = parseReviewVerdict(trace.outputJson);
    if (verdict && !verdict.approved) {
      rejected.add(trace.runId);
    }
  }
  const rows = new Map<string, WorkflowRunRollupRow>();
  for (const run of input.runs) {
    const dayMs = Math.floor(run.startedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS;
    const prs = prsByRun.get(run.id) ?? [];
    const merged = prs.filter((pr) => pr.mergedAt !== null);
    const runCiFixes = ciFixes.get(run.id) ?? 0;
    const runRejected = rejected.has(run.id);
    const dimensionKey = JSON.stringify([
      run.attributedOrgId,
      run.attributedTeamId,
      run.templateId,
      run.templateVersion,
      run.repoId,
      run.status,
      run.outcomeDomain,
      run.outcomeType,
      run.wasAutonomous,
      run.hadHumanStep,
      run.launchedById ?? null,
    ]);
    const key = `${dayMs}:${dimensionKey}`;
    const row = rows.get(key) ?? {
      bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
      builtAt: now,
      ciFixAttempts: 0,
      ciFixRoundsBuckets: Array.from({ length: CI_FIX_ROUND_BUCKETS }, () => 0),
      costUsd: 0,
      day: new Date(dayMs),
      dimensionKey,
      durationBuckets: durationBuckets(),
      durationCount: 0,
      durationMsSum: 0n,
      hadHumanStep: run.hadHumanStep,
      launchedById: run.launchedById ?? null,
      mergeMsBuckets: durationBuckets(),
      orgId: run.attributedOrgId,
      outcomeDomain: run.outcomeDomain,
      outcomeType: run.outcomeType,
      prsCiPassed: 0,
      prsClosedUnmerged: 0,
      prsMerged: 0,
      prsOpened: 0,
      repoId: run.repoId,
      runs: 0,
      runsCiHealed: 0,
      runsReviewRejected: 0,
      runsReviewRejectedMerged: 0,
      runsReviewRejectedWithPr: 0,
      runsWithCiFix: 0,
      runsWithPr: 0,
      runsWithPrMerged: 0,
      status: run.status,
      teamId: run.attributedTeamId,
      templateId: run.templateId,
      templateVersion: run.templateVersion,
      timeSavedMinutes: 0,
      wasAutonomous: run.wasAutonomous,
    };
    row.runs++;
    row.costUsd += run.costUsdAccrued > 0 ? run.costUsdAccrued : (run.legacyCostUsd ?? 0);
    if (run.status === 'SUCCESS') {
      row.timeSavedMinutes += run.estimatedHumanTimeSaved ?? 0;
    }
    if (run.endedAt) {
      const duration = Math.max(0, run.endedAt.getTime() - run.startedAt.getTime());
      row.durationMsSum += BigInt(Math.trunc(duration));
      row.durationCount++;
      addBucket(row.durationBuckets, durationBucketForMs(duration));
    }
    row.prsOpened += prs.length;
    row.runsWithPr += prs.length > 0 ? 1 : 0;
    row.prsMerged += merged.length;
    row.prsClosedUnmerged += prs.filter((pr) => pr.status === 'CLOSED' && !pr.mergedAt).length;
    row.prsCiPassed += prs.filter((pr) => pr.ciStatus === 'PASSED').length;
    for (const pr of merged) {
      if (pr.mergedAt) {
        addBucket(
          row.mergeMsBuckets,
          durationBucketForMs(pr.mergedAt.getTime() - run.startedAt.getTime())
        );
      }
    }
    if (prs.length > 0) {
      addBucket(row.ciFixRoundsBuckets, Math.min(runCiFixes, CI_FIX_ROUND_OVERFLOW));
    }
    row.ciFixAttempts += runCiFixes;
    row.runsWithCiFix += runCiFixes > 0 ? 1 : 0;
    row.runsCiHealed +=
      runCiFixes > 0 && prs.some((pr) => pr.ciStatus === 'PASSED' || pr.mergedAt) ? 1 : 0;
    row.runsReviewRejected += runRejected ? 1 : 0;
    row.runsReviewRejectedWithPr += runRejected && prs.length > 0 ? 1 : 0;
    row.runsReviewRejectedMerged += runRejected && merged.length > 0 ? 1 : 0;
    row.runsWithPrMerged += merged.length > 0 ? 1 : 0;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export interface HumanStepDailyRollupInput {
  launchedById?: string | null;
  kind: string;
  orgId: string | null;
  repoId?: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedVia: string | null;
  status: string;
  teamId: string | null;
}

export interface HumanStepDailyRollupRow {
  bucketVersion: number;
  day: Date;
  dimensionKey: string;
  kind: string;
  launchedById: string | null;
  orgId: string | null;
  repoId: string | null;
  resolvedBy: string | null;
  resolvedVia: string;
  status: string;
  steps: number;
  teamId: string | null;
  timedOut: number;
  waitBuckets: number[];
  waitMsSum: bigint;
}

export function buildHumanStepDailyRollups(
  steps: readonly HumanStepDailyRollupInput[]
): HumanStepDailyRollupRow[] {
  const rows = new Map<string, HumanStepDailyRollupRow>();
  for (const step of steps) {
    const dayMs =
      Math.floor(step.requestedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS;
    const resolvedVia =
      step.resolvedVia &&
      ['web', 'slack', 'api_token', 'mcp', 'assistant'].includes(step.resolvedVia)
        ? step.resolvedVia
        : 'unknown';
    const dimensions = [
      step.orgId,
      step.teamId,
      step.repoId ?? null,
      step.launchedById ?? null,
      step.kind,
      step.status,
      resolvedVia,
      step.resolvedBy,
    ];
    const dimensionKey = JSON.stringify(dimensions);
    const key = `${dayMs}:${dimensionKey}`;
    const row = rows.get(key) ?? {
      bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
      day: new Date(dayMs),
      dimensionKey,
      kind: step.kind,
      launchedById: step.launchedById ?? null,
      orgId: step.orgId,
      repoId: step.repoId ?? null,
      resolvedBy: step.resolvedBy,
      resolvedVia,
      status: step.status,
      steps: 0,
      teamId: step.teamId,
      timedOut: 0,
      waitBuckets: durationBuckets(),
      waitMsSum: 0n,
    };
    row.steps++;
    if (step.status === 'TIMED_OUT') {
      row.timedOut++;
    }
    if (step.status === 'RESOLVED' && step.resolvedAt) {
      const waitMs = step.resolvedAt.getTime() - step.requestedAt.getTime();
      row.waitMsSum += BigInt(Math.trunc(waitMs));
      addBucket(row.waitBuckets, durationBucketForMs(waitMs));
    }
    rows.set(key, row);
  }
  return [...rows.values()];
}

export interface ReviewVerdictDailyRollupRunInput {
  attributedOrgId: string | null;
  attributedTeamId: string | null;
  id: string;
  launchedById?: string | null;
  repoId?: string | null;
  startedAt: Date;
}

export interface ReviewVerdictDailyRollupTraceInput {
  error: string | null;
  outputJson: unknown;
  runId: string | null;
}

export interface ReviewVerdictDailyRollupRow {
  approved: boolean | null;
  bucketVersion: number;
  categoryCounts: Record<string, number>;
  day: Date;
  dimensionKey: string;
  findings: number;
  launchedById: string | null;
  nonVerdictRows: number;
  orgId: string | null;
  repoId: string | null;
  reviewer: string | null;
  severity: string | null;
  teamId: string | null;
  verdicts: number;
}

export function buildReviewVerdictDailyRollups(input: {
  runs: readonly ReviewVerdictDailyRollupRunInput[];
  traces: readonly ReviewVerdictDailyRollupTraceInput[];
}): ReviewVerdictDailyRollupRow[] {
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const rows = new Map<string, ReviewVerdictDailyRollupRow>();
  for (const trace of input.traces) {
    if (
      trace.error ||
      !trace.runId ||
      !trace.outputJson ||
      typeof trace.outputJson !== 'object' ||
      Array.isArray(trace.outputJson) ||
      !Object.hasOwn(trace.outputJson, 'approved')
    ) {
      continue;
    }
    const run = runs.get(trace.runId);
    if (!run) {
      continue;
    }
    const verdict = parseReviewVerdict(trace.outputJson);
    const reviewer = verdict?.reviewer ?? null;
    const severity = verdict?.severity ?? null;
    const approved = verdict?.approved ?? null;
    const dayMs = Math.floor(run.startedAt.getTime() / WORKFLOW_RUN_DAY_MS) * WORKFLOW_RUN_DAY_MS;
    const dimensionKey = JSON.stringify([
      run.attributedOrgId,
      run.attributedTeamId,
      run.repoId ?? null,
      run.launchedById ?? null,
      reviewer,
      severity,
      approved,
    ]);
    const key = `${dayMs}:${dimensionKey}`;
    const row = rows.get(key) ?? {
      approved,
      bucketVersion: WORKFLOW_RUN_ROLLUP_BUCKET_VERSION,
      categoryCounts: Object.create(null) as Record<string, number>,
      day: new Date(dayMs),
      dimensionKey,
      findings: 0,
      launchedById: run.launchedById ?? null,
      nonVerdictRows: 0,
      orgId: run.attributedOrgId,
      repoId: run.repoId ?? null,
      reviewer,
      severity,
      teamId: run.attributedTeamId,
      verdicts: 0,
    };
    if (!verdict) {
      row.nonVerdictRows++;
    } else {
      row.verdicts++;
      row.findings += verdict.findings.length;
      for (const finding of verdict.findings) {
        row.categoryCounts[finding.category] =
          (Object.hasOwn(row.categoryCounts, finding.category)
            ? row.categoryCounts[finding.category]
            : 0) + 1;
      }
    }
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function combineWorkflowRunRollupRows(rows: readonly WorkflowRunRollupRow[]) {
  const combined = rows.reduce(
    (acc, row) => {
      acc.runs += row.runs;
      acc.costUsd += row.costUsd;
      acc.timeSavedMinutes += row.timeSavedMinutes;
      acc.durationMsSum += row.durationMsSum;
      acc.durationCount += row.durationCount;
      acc.prsOpened += row.prsOpened;
      acc.prsMerged += row.prsMerged;
      acc.prsClosedUnmerged += row.prsClosedUnmerged;
      acc.prsCiPassed += row.prsCiPassed;
      acc.runsWithPr += row.runsWithPr;
      acc.ciFixAttempts += row.ciFixAttempts;
      acc.runsWithCiFix += row.runsWithCiFix;
      acc.runsCiHealed += row.runsCiHealed;
      acc.runsReviewRejected += row.runsReviewRejected;
      acc.runsReviewRejectedWithPr += row.runsReviewRejectedWithPr;
      acc.runsReviewRejectedMerged += row.runsReviewRejectedMerged;
      acc.runsWithPrMerged += row.runsWithPrMerged;
      for (let i = 0; i < acc.durationBuckets.length; i++) {
        acc.durationBuckets[i] = (acc.durationBuckets[i] ?? 0) + (row.durationBuckets[i] ?? 0);
        acc.mergeMsBuckets[i] = (acc.mergeMsBuckets[i] ?? 0) + (row.mergeMsBuckets[i] ?? 0);
      }
      for (let i = 0; i < CI_FIX_ROUND_BUCKETS; i++) {
        acc.ciFixRoundsBuckets[i] =
          (acc.ciFixRoundsBuckets[i] ?? 0) + (row.ciFixRoundsBuckets[i] ?? 0);
      }
      return acc;
    },
    {
      ciFixAttempts: 0,
      ciFixRoundsBuckets: Array.from({ length: CI_FIX_ROUND_BUCKETS }, () => 0),
      costUsd: 0,
      durationBuckets: durationBuckets(),
      durationCount: 0,
      durationMsSum: 0n,
      mergeMsBuckets: durationBuckets(),
      prsCiPassed: 0,
      prsClosedUnmerged: 0,
      prsMerged: 0,
      prsOpened: 0,
      runs: 0,
      runsCiHealed: 0,
      runsReviewRejected: 0,
      runsReviewRejectedMerged: 0,
      runsReviewRejectedWithPr: 0,
      runsWithCiFix: 0,
      runsWithPr: 0,
      runsWithPrMerged: 0,
      timeSavedMinutes: 0,
    }
  );
  return {
    ...combined,
    averageDurationMs: combined.durationCount
      ? Number(combined.durationMsSum) / combined.durationCount
      : null,
    averageFixRounds: ciFixRoundsFromBuckets(combined.ciFixRoundsBuckets).avgPerRun,
    p50DurationMs: durationPercentileFromBuckets(combined.durationBuckets, 0.5),
    p50MergeMs: durationPercentileFromBuckets(combined.mergeMsBuckets, 0.5),
    p95DurationMs: durationPercentileFromBuckets(combined.durationBuckets, 0.95),
    p95FixRounds: ciFixRoundsFromBuckets(combined.ciFixRoundsBuckets).p95PerRun,
  };
}
