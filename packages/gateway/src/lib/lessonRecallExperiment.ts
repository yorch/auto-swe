export type ExperimentArm = 'ON' | 'SHADOW' | 'OFF';

export interface ExperimentRun {
  lessonRecallArm: ExperimentArm | null;
  lessonRecallHeldOut: boolean;
  status: string;
  costUsdAccrued: number;
  steps: { nodeId: string; attempt: number }[];
  attributedPullRequests: { status: string }[];
  evalResults: { source: string; scorer: string; passed: boolean | null }[];
  traces: { toolName: string | null; outputJson: unknown }[];
}

function exposure(run: ExperimentRun): boolean {
  const event = run.lessonRecallArm === 'SHADOW' ? 'lessons.shadow_retrieved' : 'lessons.retrieved';
  return run.traces.some((trace) => {
    const output = trace.outputJson;
    return (
      trace.toolName === event &&
      output !== null &&
      typeof output === 'object' &&
      'lessons' in output &&
      Array.isArray(output.lessons) &&
      output.lessons.length > 0
    );
  });
}

function mergeOutcome(run: ExperimentRun): boolean | null {
  if (
    run.attributedPullRequests.some((pr) => pr.status === 'MERGED') ||
    run.evalResults.some((result) => result.source === 'MERGE' && result.passed === true)
  ) {
    return true;
  }
  return run.attributedPullRequests.length > 0 &&
    run.attributedPullRequests.every((pr) => pr.status === 'CLOSED')
    ? false
    : null;
}

function gateOutcome(run: ExperimentRun): boolean | null {
  const latest = new Map<string, boolean>();
  for (const result of run.evalResults) {
    if (result.source === 'GATE' && result.passed !== null) {
      latest.set(result.scorer, result.passed);
    }
  }
  return latest.size ? [...latest.values()].every(Boolean) : null;
}

export function summarizeArm(runs: ExperimentRun[]) {
  const successCount = runs.filter((run) => run.status === 'SUCCESS').length;
  const failureCount = runs.filter((run) => ['FAILED', 'TIMED_OUT'].includes(run.status)).length;
  const outcomeKnownCount = successCount + failureCount;
  const merges = runs.map(mergeOutcome).filter((outcome) => outcome !== null);
  const gates = runs.map(gateOutcome).filter((outcome) => outcome !== null);
  const mergedCount = merges.filter(Boolean).length;
  const gatePassedCount = gates.filter(Boolean).length;
  return {
    failureCount,
    failureRate: outcomeKnownCount ? failureCount / outcomeKnownCount : null,
    gateKnownCount: gates.length,
    gatePassedCount,
    gatePassRate: gates.length ? gatePassedCount / gates.length : null,
    heldOutCount: runs.filter((run) => run.lessonRecallHeldOut).length,
    meanCostUsd: runs.length
      ? runs.reduce((sum, run) => sum + run.costUsdAccrued, 0) / runs.length
      : null,
    meanFixLoopIterations: runs.length
      ? runs.reduce(
          (sum, run) =>
            sum + new Set(run.steps.map((step) => `${step.nodeId}:${step.attempt}`)).size,
          0
        ) / runs.length
      : null,
    mergedCount,
    mergeKnownCount: merges.length,
    mergeRate: merges.length ? mergedCount / merges.length : null,
    outcomeKnownCount,
    runCount: runs.length,
    successCount,
    successRate: outcomeKnownCount ? successCount / outcomeKnownCount : null,
  };
}

type Summary = ReturnType<typeof summarizeArm>;

function wilson(successes: number, n: number): [number, number] {
  const p = successes / n;
  const z2 = 1.96 ** 2;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Newcombe's independent-proportions interval with Wilson score bounds. */
export function rateDifference(aSuccesses: number, aN: number, bSuccesses: number, bN: number) {
  if (!aN || !bN) {
    return null;
  }
  const a = aSuccesses / aN;
  const b = bSuccesses / bN;
  const [aLow, aHigh] = wilson(aSuccesses, aN);
  const [bLow, bHigh] = wilson(bSuccesses, bN);
  return {
    difference: a - b,
    lower95: Math.max(-1, a - b - Math.hypot(a - aLow, bHigh - b)),
    upper95: Math.min(1, a - b + Math.hypot(aHigh - a, b - bLow)),
  };
}

function compare(on: Summary, shadow: Summary) {
  return {
    gatePassRateDifference: rateDifference(
      on.gatePassedCount,
      on.gateKnownCount,
      shadow.gatePassedCount,
      shadow.gateKnownCount
    ),
    mergeRateDifference: rateDifference(
      on.mergedCount,
      on.mergeKnownCount,
      shadow.mergedCount,
      shadow.mergeKnownCount
    ),
    smallSample: on.runCount < 30 || shadow.runCount < 30,
    successRateDifference: rateDifference(
      on.successCount,
      on.outcomeKnownCount,
      shadow.successCount,
      shadow.outcomeKnownCount
    ),
  };
}

export function lessonRecallExperiment(runs: ExperimentRun[]) {
  const arms = {
    OFF: summarizeArm(runs.filter((run) => run.lessonRecallArm === 'OFF')),
    ON: summarizeArm(runs.filter((run) => run.lessonRecallArm === 'ON')),
    SHADOW: summarizeArm(runs.filter((run) => run.lessonRecallArm === 'SHADOW')),
  };
  const matched = runs.filter(exposure);
  const likeForLike = {
    ON: summarizeArm(matched.filter((run) => run.lessonRecallArm === 'ON')),
    SHADOW: summarizeArm(matched.filter((run) => run.lessonRecallArm === 'SHADOW')),
  };
  return {
    arms,
    caveat:
      'Observational comparison, not a causal effect. Configuration, task mix and missing telemetry can differ between arms. Holdout randomizes only otherwise-on runs. Confidence intervals are unadjusted independent-proportion estimates; repeated tasks may be correlated.',
    comparison: compare(arms.ON, arms.SHADOW),
    likeForLike: { ...likeForLike, comparison: compare(likeForLike.ON, likeForLike.SHADOW) },
    smallSampleWarning:
      'Fewer than 30 runs in either ON or SHADOW is a small sample. Known outcome denominators may be smaller still.',
  };
}
