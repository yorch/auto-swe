/**
 * Eval statistics — P1 of the evals feature (docs/evals-p1.md).
 *
 * Paired, error-barred comparison of a candidate vs. a baseline over a frozen
 * benchmark, plus stratified (per-tag) aggregation. The RFC (§2, §9) is
 * emphatic that a delta without error bars is meaningless and that the realistic
 * minimum detectable effect at small N is ~10–15pp, not 5–7pp — these helpers
 * make that honesty mechanical: every delta carries N + a 95% CI, and the
 * regression verdict is "the CI excludes 0 in the worse direction", never a bare
 * point estimate.
 *
 * Pure functions only — no I/O, no LLM. Unit-tested directly.
 */

/** One case scored under both arms (1 = floor passed, 0 = failed). */
export interface PairedOutcome {
  caseId: string;
  /** Stratification tags copied from the EvalCase (repo:/capability:/…). */
  tags?: string[];
  baseline: 0 | 1;
  candidate: 0 | 1;
}

export interface PairedDelta {
  /** Number of paired cases. */
  n: number;
  /** Candidate pass-rate − baseline pass-rate, in [-1, 1]. */
  delta: number;
  baselineRate: number;
  candidateRate: number;
  /** Standard error of the paired difference. */
  se: number;
  /** 95% CI of the delta: [low, high]. */
  ci95: [number, number];
}

const Z_95 = 1.959963984540054;

/** Sample mean and standard error of the mean for a list of values. */
function meanAndSe(values: number[]): { mean: number; se: number } {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, se: 0 };
  }
  const mean = values.reduce((s, v) => s + v, 0) / n;
  // Sample variance (n-1 denominator; guard n=1), then SE of the mean.
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, se: Math.sqrt(variance / n) };
}

/**
 * Paired difference in pass-rate with a McNemar-style standard error on the
 * per-case differences d_i = candidate_i − baseline_i. Pairing removes
 * case-difficulty variance; the SE is computed on the differences directly, so
 * correlated arms (the whole point of running the same cases) shrink it.
 */
export function pairedProportionDelta(pairs: PairedOutcome[]): PairedDelta {
  const n = pairs.length;
  if (n === 0) {
    return { baselineRate: 0, candidateRate: 0, ci95: [0, 0], delta: 0, n: 0, se: 0 };
  }
  const baselineRate = pairs.reduce((s, p) => s + p.baseline, 0) / n;
  const candidateRate = pairs.reduce((s, p) => s + p.candidate, 0) / n;
  const { mean: delta, se } = meanAndSe(pairs.map((p) => p.candidate - p.baseline));
  const half = Z_95 * se;
  return {
    baselineRate,
    candidateRate,
    ci95: [delta - half, delta + half],
    delta,
    n,
    se,
  };
}

/**
 * Clustered standard error when cases group by a cluster key (e.g. repo). The
 * RFC (§2) warns naive SEs can understate variance ~3× when cases cluster; this
 * computes the SE on per-cluster mean differences so the effective N is the
 * number of clusters, not cases.
 */
export function clusteredDelta(
  pairs: PairedOutcome[],
  clusterOf: (p: PairedOutcome) => string
): PairedDelta {
  const byCluster = new Map<string, PairedOutcome[]>();
  for (const p of pairs) {
    const k = clusterOf(p);
    const arr = byCluster.get(k);
    if (arr) {
      arr.push(p);
    } else {
      byCluster.set(k, [p]);
    }
  }
  // Treat each cluster's mean difference as the unit of analysis, so the
  // effective N is the cluster count and correlated within-cluster cases don't
  // inflate confidence.
  const clusterMeanDiffs = [...byCluster.values()].map(
    (group) => group.reduce((s, p) => s + (p.candidate - p.baseline), 0) / group.length
  );
  const { se } = meanAndSe(clusterMeanDiffs);
  // The point estimate stays the overall (case-weighted) delta; only the SE/CI
  // are clustered.
  const overall = pairedProportionDelta(pairs);
  const half = Z_95 * se;
  return {
    baselineRate: overall.baselineRate,
    candidateRate: overall.candidateRate,
    ci95: [overall.delta - half, overall.delta + half],
    delta: overall.delta,
    n: byCluster.size,
    se,
  };
}

/** Tag → its own paired delta. Only tags present on cases are reported. */
export function deltaByTag(pairs: PairedOutcome[]): Record<string, PairedDelta> {
  const byTag = new Map<string, PairedOutcome[]>();
  for (const p of pairs) {
    for (const tag of p.tags ?? []) {
      const arr = byTag.get(tag);
      if (arr) {
        arr.push(p);
      } else {
        byTag.set(tag, [p]);
      }
    }
  }
  const out: Record<string, PairedDelta> = {};
  for (const [tag, group] of byTag) {
    out[tag] = pairedProportionDelta(group);
  }
  return out;
}

export interface RegressionVerdict {
  regression: boolean;
  overall: PairedDelta;
  byTag: Record<string, PairedDelta>;
  /** Human-readable one-liner for the CLI/report. */
  summary: string;
}

/**
 * Decide regression from a paired comparison. A regression is declared only when
 * the 95% CI of the delta lies entirely below zero (candidate worse than
 * baseline with significance) — never on a bare point estimate (RFC §9).
 */
export function regressionVerdict(pairs: PairedOutcome[]): RegressionVerdict {
  const overall = pairedProportionDelta(pairs);
  const byTag = deltaByTag(pairs);
  const regression = overall.ci95[1] < 0;
  const pct = (x: number) => `${(x * 100).toFixed(1)}pp`;
  const summary = `pass-rate ${(overall.baselineRate * 100).toFixed(0)}% → ${(overall.candidateRate * 100).toFixed(0)}% (Δ ${pct(overall.delta)}, 95% CI [${pct(overall.ci95[0])}, ${pct(overall.ci95[1])}], n=${overall.n}) — ${regression ? 'REGRESSION' : 'no significant regression'}`;
  return { byTag, overall, regression, summary };
}
