import { percentile } from './analytics.js';

export const QUALITY_GATE_STEPS = [
  'runLint',
  'runTypecheck',
  'runTests',
  'runBuild',
  'runVulnScan',
  'runPerfBench',
] as const;

export const QUALITY_FIX_STEPS = [
  'executeGateFixImplementation',
  'executeReviewFixImplementation',
  'executeCIFixImplementation',
] as const;

export const REVIEWER_TYPES = ['SECURITY', 'DOMAIN_LOGIC', 'PERFORMANCE'] as const;
export const REVIEW_SEVERITIES = ['PASS', 'INFO', 'WARNING', 'CRITICAL'] as const;

export interface DeliveryPullRequest {
  ciStatus: string;
  mergedAt: Date | null;
}

export interface DeliveryRun {
  costUsdAccrued: number;
  ciFixRounds: number;
  id: string;
  pullRequests: DeliveryPullRequest[];
  repoId: string | null;
  repositoryName: string | null;
  startedAt: Date;
  status: string;
  teamId?: string | null;
  teamName?: string | null;
  templateId: string;
  templateName: string;
  workflowId: string;
}

export interface DeliveryMetrics {
  ciFixRounds: { avgPerRun: number | null; p95PerRun: number | null };
  costPerMergedPr: number | null;
  medianTimeToMergeMs: number | null;
  prsCiPassed: number;
  prsMerged: number;
  runsStarted: number;
  runsSucceeded: number;
  runsWithPr: number;
  spendUsd: number;
  successRate: number | null;
}

export interface DeliveryReport extends DeliveryMetrics {
  byRepo: Array<DeliveryMetrics & { repoId: string; repositoryName: string }>;
  byTeam: Array<DeliveryMetrics & { teamId: string | null; teamName: string }>;
  byTemplate: Array<DeliveryMetrics & { templateId: string; templateName: string }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function deliveryMetrics(runs: DeliveryRun[]): DeliveryMetrics {
  const mergedTimes: number[] = [];
  let runsSucceeded = 0;
  let runsWithPr = 0;
  let prsCiPassed = 0;
  let prsMerged = 0;
  let runCostUsd = 0;
  let spendUsd = 0;
  const ciFixRounds: number[] = [];

  for (const run of runs) {
    if (run.status === 'SUCCESS') {
      runsSucceeded++;
    }
    runCostUsd += run.costUsdAccrued;
    spendUsd += run.costUsdAccrued;
    if (run.pullRequests.length > 0) {
      runsWithPr++;
      ciFixRounds.push(run.ciFixRounds);
    }
    for (const pr of run.pullRequests) {
      if (pr.ciStatus === 'PASSED') {
        prsCiPassed++;
      }
      if (pr.mergedAt) {
        prsMerged++;
        mergedTimes.push(pr.mergedAt.getTime() - run.startedAt.getTime());
      }
    }
  }

  const sortedFixRounds = [...ciFixRounds].sort((a, b) => a - b);
  return {
    ciFixRounds: {
      avgPerRun:
        ciFixRounds.length > 0
          ? ciFixRounds.reduce((sum, rounds) => sum + rounds, 0) / ciFixRounds.length
          : null,
      p95PerRun: percentile(sortedFixRounds, 0.95),
    },
    costPerMergedPr: prsMerged > 0 ? runCostUsd / prsMerged : null,
    medianTimeToMergeMs: median(mergedTimes),
    prsCiPassed,
    prsMerged,
    runsStarted: runs.length,
    runsSucceeded,
    runsWithPr,
    spendUsd,
    successRate: runs.length > 0 ? runsSucceeded / runs.length : null,
  };
}

export function computeDeliveryReport(runs: DeliveryRun[]): DeliveryReport {
  const templates = new Map<string, DeliveryRun[]>();
  const repositories = new Map<string, DeliveryRun[]>();
  const teams = new Map<string | null, DeliveryRun[]>();
  for (const run of runs) {
    const templateRows = templates.get(run.templateId) ?? [];
    templateRows.push(run);
    templates.set(run.templateId, templateRows);
    if (run.repoId) {
      const repoRows = repositories.get(run.repoId) ?? [];
      repoRows.push(run);
      repositories.set(run.repoId, repoRows);
    }
    const teamRows = teams.get(run.teamId ?? null) ?? [];
    teamRows.push(run);
    teams.set(run.teamId ?? null, teamRows);
  }
  return {
    ...deliveryMetrics(runs),
    byRepo: [...repositories.entries()]
      .map(([repoId, rows]) => ({
        ...deliveryMetrics(rows),
        repoId,
        repositoryName: rows[0]?.repositoryName ?? repoId,
      }))
      .sort(
        (a, b) => b.runsStarted - a.runsStarted || a.repositoryName.localeCompare(b.repositoryName)
      ),
    byTeam: [...teams.entries()]
      .map(([teamId, rows]) => ({
        ...deliveryMetrics(rows),
        teamId,
        teamName: rows[0]?.teamName ?? (teamId ? teamId : 'Unattributed'),
      }))
      .sort((a, b) => b.runsStarted - a.runsStarted || a.teamName.localeCompare(b.teamName)),
    byTemplate: [...templates.entries()]
      .map(([templateId, rows]) => ({
        ...deliveryMetrics(rows),
        templateId,
        templateName: rows[0]?.templateName ?? templateId,
      }))
      .sort(
        (a, b) => b.runsStarted - a.runsStarted || a.templateName.localeCompare(b.templateName)
      ),
  };
}

export interface QualityRun {
  id: string;
}

export interface QualityStep {
  count?: number;
  runId: string;
  status: string;
  stepName: string | null;
}

export interface QualityPullRequest {
  ciStatus: string;
  mergedAt: Date | null;
  runId: string;
}

export interface ReviewTrace {
  error?: string | null;
  outputJson: unknown;
  runId: string | null;
}

export interface ParsedReviewVerdict {
  approved: boolean;
  findings: Array<{ category: string }>;
  reviewer: (typeof REVIEWER_TYPES)[number];
  severity: (typeof REVIEW_SEVERITIES)[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseReviewVerdict(value: unknown): ParsedReviewVerdict | null {
  if (!isRecord(value)) {
    return null;
  }
  const { approved, findings, reviewer, severity } = value;
  if (
    typeof approved !== 'boolean' ||
    !REVIEWER_TYPES.includes(reviewer as (typeof REVIEWER_TYPES)[number]) ||
    !REVIEW_SEVERITIES.includes(severity as (typeof REVIEW_SEVERITIES)[number]) ||
    !Array.isArray(findings)
  ) {
    return null;
  }
  const parsedFindings: Array<{ category: string }> = [];
  for (const finding of findings) {
    if (!isRecord(finding) || typeof finding.category !== 'string') {
      return null;
    }
    parsedFindings.push({ category: finding.category });
  }
  return {
    approved,
    findings: parsedFindings,
    reviewer: reviewer as ParsedReviewVerdict['reviewer'],
    severity: severity as ParsedReviewVerdict['severity'],
  };
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

export interface QualityReport {
  ciSelfHealRate: number | null;
  fixLoops: Array<{
    avgAttemptsPerRun: number | null;
    runsWithFix: number;
    stepName: (typeof QUALITY_FIX_STEPS)[number];
    totalAttempts: number;
  }>;
  gates: Array<{
    attempts: number;
    failed: number;
    finalPassRate: number | null;
    firstAttemptPassRate: number | null;
    passed: number;
    stepName: (typeof QUALITY_GATE_STEPS)[number];
  }>;
  mergeRateByReviewOutcome: {
    withRejectingVerdict: { mergeRate: number | null; mergedRuns: number; runsWithPr: number };
    withoutRejectingVerdict: { mergeRate: number | null; mergedRuns: number; runsWithPr: number };
  };
  review: {
    byReviewer: Array<{
      approvalRate: number | null;
      approved: number;
      findingsTotal: number;
      reviewer: (typeof REVIEWER_TYPES)[number];
      severityCounts: Record<(typeof REVIEW_SEVERITIES)[number], number>;
      topCategories: Array<{ category: string; count: number }>;
      verdicts: number;
    }>;
    nonVerdictRows: number;
  };
}

function mergeRate(runsWithPr: number, mergedRuns: number) {
  return { mergedRuns, mergeRate: runsWithPr > 0 ? mergedRuns / runsWithPr : null, runsWithPr };
}

export function computeQualityReport(input: {
  pullRequests: QualityPullRequest[];
  runs: QualityRun[];
  steps: QualityStep[];
  reviewTraces: ReviewTrace[];
}): QualityReport {
  const gatePairs = new Map<
    (typeof QUALITY_GATE_STEPS)[number],
    Map<string, { failed: number; passed: number }>
  >(QUALITY_GATE_STEPS.map((stepName) => [stepName, new Map()]));
  for (const step of input.steps) {
    const pairs = gatePairs.get(step.stepName as (typeof QUALITY_GATE_STEPS)[number]);
    if (pairs) {
      const stats = pairs.get(step.runId) ?? { failed: 0, passed: 0 };
      if (step.status === 'PASSED') {
        stats.passed += step.count ?? 1;
      } else if (step.status === 'FAILED') {
        stats.failed += step.count ?? 1;
      }
      pairs.set(step.runId, stats);
    }
  }
  const gates = QUALITY_GATE_STEPS.map((stepName) => {
    const pairs = [...(gatePairs.get(stepName)?.values() ?? [])];
    const failed = pairs.reduce((sum, pair) => sum + pair.failed, 0);
    const passed = pairs.reduce((sum, pair) => sum + pair.passed, 0);
    const attempts = failed + passed;
    const finalPassPairs = pairs.filter((pair) => pair.passed > 0).length;
    const firstAttemptPassPairs = pairs.filter(
      (pair) => pair.passed > 0 && pair.failed === 0
    ).length;
    return {
      attempts,
      failed,
      finalPassRate: pairs.length > 0 ? finalPassPairs / pairs.length : null,
      firstAttemptPassRate: pairs.length > 0 ? firstAttemptPassPairs / pairs.length : null,
      passed,
      stepName,
    };
  });

  const fixesByStep = new Map<(typeof QUALITY_FIX_STEPS)[number], Map<string, number>>(
    QUALITY_FIX_STEPS.map((stepName) => [stepName, new Map()])
  );
  const ciFixRunIds = new Set<string>();
  for (const step of input.steps) {
    if (step.stepName === 'executeCIFixImplementation') {
      ciFixRunIds.add(step.runId);
    }
    if (step.status !== 'PASSED' && step.status !== 'FAILED') {
      continue;
    }
    const byRun = fixesByStep.get(step.stepName as (typeof QUALITY_FIX_STEPS)[number]);
    if (byRun) {
      byRun.set(step.runId, (byRun.get(step.runId) ?? 0) + (step.count ?? 1));
    }
  }
  const fixLoops = QUALITY_FIX_STEPS.map((stepName) => {
    const byRun = fixesByStep.get(stepName) ?? new Map();
    const totalAttempts = [...byRun.values()].reduce((sum, attempts) => sum + attempts, 0);
    const runsWithFix = byRun.size;
    return {
      avgAttemptsPerRun: runsWithFix > 0 ? totalAttempts / runsWithFix : null,
      runsWithFix,
      stepName,
      totalAttempts,
    };
  });

  const healedRuns = new Set(
    input.pullRequests
      .filter((pr) => pr.ciStatus === 'PASSED' || pr.mergedAt !== null)
      .map((pr) => pr.runId)
  );

  const reviewers = new Map(
    REVIEWER_TYPES.map((reviewer) => [
      reviewer,
      {
        approved: 0,
        categories: new Map<string, number>(),
        findingsTotal: 0,
        severityCounts: Object.fromEntries(
          REVIEW_SEVERITIES.map((severity) => [severity, 0])
        ) as Record<(typeof REVIEW_SEVERITIES)[number], number>,
        verdicts: 0,
      },
    ])
  );
  let nonVerdictRows = 0;
  const rejectingRuns = new Set<string>();
  for (const trace of input.reviewTraces) {
    if (trace.error) {
      continue;
    }
    if (!isRecord(trace.outputJson) || !Object.hasOwn(trace.outputJson, 'approved')) {
      continue;
    }
    const verdict = parseReviewVerdict(trace.outputJson);
    if (!verdict) {
      nonVerdictRows++;
      continue;
    }
    const group = reviewers.get(verdict.reviewer);
    if (!group) {
      nonVerdictRows++;
      continue;
    }
    group.verdicts++;
    group.approved += verdict.approved ? 1 : 0;
    group.severityCounts[verdict.severity]++;
    group.findingsTotal += verdict.findings.length;
    for (const finding of verdict.findings) {
      group.categories.set(finding.category, (group.categories.get(finding.category) ?? 0) + 1);
    }
    if (!verdict.approved && trace.runId) {
      rejectingRuns.add(trace.runId);
    }
  }
  const byReviewer = REVIEWER_TYPES.map((reviewer) => {
    const group = reviewers.get(reviewer);
    const verdicts = group?.verdicts ?? 0;
    return {
      approvalRate: verdicts > 0 ? (group?.approved ?? 0) / verdicts : null,
      approved: group?.approved ?? 0,
      findingsTotal: group?.findingsTotal ?? 0,
      reviewer,
      severityCounts:
        group?.severityCounts ??
        (Object.fromEntries(REVIEW_SEVERITIES.map((severity) => [severity, 0])) as Record<
          (typeof REVIEW_SEVERITIES)[number],
          number
        >),
      topCategories: [...(group?.categories ?? new Map()).entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
        .slice(0, 5),
      verdicts,
    };
  });

  const prsByRun = new Map<string, QualityPullRequest[]>();
  for (const pr of input.pullRequests) {
    const prs = prsByRun.get(pr.runId) ?? [];
    prs.push(pr);
    prsByRun.set(pr.runId, prs);
  }
  const mergeGroups = {
    other: { mergedRuns: 0, runsWithPr: 0 },
    rejecting: { mergedRuns: 0, runsWithPr: 0 },
  };
  for (const run of input.runs) {
    const prs = prsByRun.get(run.id);
    if (!prs?.length) {
      continue;
    }
    const group = rejectingRuns.has(run.id) ? mergeGroups.rejecting : mergeGroups.other;
    group.runsWithPr++;
    if (prs.some((pr) => pr.mergedAt !== null)) {
      group.mergedRuns++;
    }
  }

  const ciRunCount = ciFixRunIds.size;
  return {
    ciSelfHealRate:
      ciRunCount > 0
        ? [...ciFixRunIds].filter((runId) => healedRuns.has(runId)).length / ciRunCount
        : null,
    fixLoops,
    gates,
    mergeRateByReviewOutcome: {
      withoutRejectingVerdict: mergeRate(
        mergeGroups.other.runsWithPr,
        mergeGroups.other.mergedRuns
      ),
      withRejectingVerdict: mergeRate(
        mergeGroups.rejecting.runsWithPr,
        mergeGroups.rejecting.mergedRuns
      ),
    },
    review: { byReviewer, nonVerdictRows },
  };
}

export interface AutomationFireInput {
  automationId: string | null;
  automationName: string | null;
  automationEnabled: boolean | null;
  createdAt: Date;
  outcome: string;
  reason: string | null;
  temporalWorkflowId: string | null;
}

export interface AutomationReportRow {
  automationEnabled: boolean | null;
  automationId: string | null;
  automationName: string;
  broken: boolean;
  failedToStart: number;
  fires: number;
  lastFiredAt: Date;
  noisy: boolean;
  outcomes: Record<string, number>;
  reasons: Record<string, number>;
  started: number;
  successfulProducedRuns: number;
  suppressed: {
    inFlight: number;
    other: number;
    ownOutput: number;
    sameSubject: number;
    cooldown: number;
    total: number;
    share: number;
  };
}

export function computeAutomationReport(
  fires: AutomationFireInput[],
  runStatuses: ReadonlyMap<string, string>
): AutomationReportRow[] {
  const groups = new Map<string, AutomationFireInput[]>();
  for (const fire of fires) {
    const key = fire.automationId ?? '';
    const rows = groups.get(key) ?? [];
    rows.push(fire);
    groups.set(key, rows);
  }
  return [...groups.values()]
    .map((rows) => {
      const outcomes = countBy(rows.map((fire) => fire.outcome));
      const reasons = countBy(rows.map((fire) => fire.reason ?? 'unspecified'));
      const started = outcomes.STARTED ?? 0;
      const failedToStart = outcomes.FAILED_TO_START ?? 0;
      const suppressed = {
        cooldown: outcomes.SUPPRESSED_COOLDOWN ?? 0,
        inFlight: outcomes.SUPPRESSED_IN_FLIGHT ?? 0,
        other: 0,
        ownOutput: outcomes.SUPPRESSED_OWN_OUTPUT ?? 0,
        sameSubject: outcomes.SUPPRESSED_SAME_SUBJECT ?? 0,
        share: 0,
        total: 0,
      };
      for (const [outcome, count] of Object.entries(outcomes)) {
        if (outcome.startsWith('SUPPRESSED_')) {
          suppressed.total += count;
          if (
            outcome !== 'SUPPRESSED_COOLDOWN' &&
            outcome !== 'SUPPRESSED_IN_FLIGHT' &&
            outcome !== 'SUPPRESSED_OWN_OUTPUT' &&
            outcome !== 'SUPPRESSED_SAME_SUBJECT'
          ) {
            suppressed.other += count;
          }
        }
      }
      suppressed.share = rows.length > 0 ? suppressed.total / rows.length : 0;
      const successfulProducedRuns = new Set(
        rows
          .filter(
            (fire) =>
              fire.outcome === 'STARTED' &&
              fire.temporalWorkflowId &&
              runStatuses.get(fire.temporalWorkflowId) === 'SUCCESS'
          )
          .map((fire) => fire.temporalWorkflowId)
      ).size;
      return {
        automationEnabled: rows[0]?.automationEnabled ?? null,
        automationId: rows[0]?.automationId ?? null,
        automationName: rows[0]?.automationName ?? 'Deleted automation',
        broken: failedToStart > 0 || (started >= 3 && successfulProducedRuns === 0),
        failedToStart,
        fires: rows.length,
        lastFiredAt: new Date(Math.max(...rows.map((fire) => fire.createdAt.getTime()))),
        noisy: rows.length >= 10 && suppressed.share > 0.5,
        outcomes,
        reasons,
        started,
        successfulProducedRuns,
        suppressed,
      };
    })
    .sort((a, b) => b.fires - a.fires || a.automationName.localeCompare(b.automationName));
}

export interface HumanStepInput {
  kind: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedVia?: string | null;
  status: string;
}

export interface AutonomyDecisionInput {
  event: string;
  riskClass: string | null;
}

export interface HitlReport {
  autonomy: {
    byEvent: Record<string, number>;
    byRiskClass: Record<string, number>;
  };
  byApprover: Array<{
    automated: number;
    interactive: number;
    medianWaitMs: number | null;
    name: string;
    resolved: number;
  }>;
  byKind: Record<string, Record<string, number>>;
  byVia: Record<string, number>;
  medianWaitMs: number | null;
  oldestPendingAgeMs: number | null;
  p95WaitMs: number | null;
  pendingNow: number;
  timedOut: number;
}

export function computeHitlReport(input: {
  autonomyDecisions: AutonomyDecisionInput[];
  now: Date;
  pendingSteps: HumanStepInput[];
  windowSteps: HumanStepInput[];
}): HitlReport {
  const byKind: Record<string, Record<string, number>> = {};
  const resolvedWaits: number[] = [];
  const approvers = new Map<
    string,
    { automated: number; interactive: number; name: string; waits: number[] }
  >();
  const byVia: Record<string, number> = {};
  let timedOut = 0;
  for (const step of input.windowSteps) {
    byKind[step.kind] ??= {};
    byKind[step.kind][step.status] = (byKind[step.kind][step.status] ?? 0) + 1;
    if (step.status === 'TIMED_OUT') {
      timedOut++;
    }
    if (step.status === 'RESOLVED' && step.resolvedAt) {
      const via =
        step.resolvedVia &&
        ['web', 'slack', 'api_token', 'mcp', 'assistant'].includes(step.resolvedVia)
          ? step.resolvedVia
          : 'unknown';
      byVia[via] = (byVia[via] ?? 0) + 1;
      const wait = step.resolvedAt.getTime() - step.requestedAt.getTime();
      resolvedWaits.push(wait);
      if (step.resolvedBy) {
        const group = approvers.get(step.resolvedBy) ?? {
          automated: 0,
          interactive: 0,
          name: step.resolvedByName ?? step.resolvedBy,
          waits: [],
        };
        group.waits.push(wait);
        if (via === 'web' || via === 'slack') {
          group.interactive++;
        } else if (via === 'api_token' || via === 'mcp' || via === 'assistant') {
          group.automated++;
        }
        approvers.set(step.resolvedBy, group);
      }
    }
  }
  const sortedWaits = [...resolvedWaits].sort((a, b) => a - b);
  const byEvent = countBy(input.autonomyDecisions.map((decision) => decision.event));
  const byRiskClass = countBy(
    input.autonomyDecisions.map((decision) => decision.riskClass ?? 'unclassified')
  );
  const oldestPending = input.pendingSteps.reduce<Date | null>(
    (oldest, step) => (oldest === null || step.requestedAt < oldest ? step.requestedAt : oldest),
    null
  );
  return {
    autonomy: { byEvent, byRiskClass },
    byApprover: [...approvers.values()]
      .map(({ automated, interactive, name, waits }) => ({
        automated,
        interactive,
        medianWaitMs: median(waits),
        name,
        resolved: waits.length,
      }))
      .sort((a, b) => b.resolved - a.resolved || a.name.localeCompare(b.name)),
    byKind,
    byVia,
    medianWaitMs: median(sortedWaits),
    oldestPendingAgeMs: oldestPending ? input.now.getTime() - oldestPending.getTime() : null,
    p95WaitMs: percentile(sortedWaits, 0.95),
    pendingNow: input.pendingSteps.length,
    timedOut,
  };
}
