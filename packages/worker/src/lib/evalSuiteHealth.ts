/**
 * Suite health, cost policy, and dataset compression — P3 of the evals feature
 * (docs/evals-p3.md, RFC §9). Pure logic, unit-tested.
 *
 * Three §9 concerns, mechanized:
 *  - "The eval system needs evals": a stale/flaky/miscalibrated suite yields
 *    *false confidence* — worse than none. `assessSuiteHealth` fails the gate
 *    CLOSED when any health signal crosses a threshold.
 *  - "Cost is the new bottleneck": `withinCostCeiling` + the tiered-scoring rule
 *    (cheap floor on all; expensive judge only on a sampled anchor subset).
 *  - "Anchor-subset compression": `selectAnchorSubset` deterministically picks
 *    K representative cases so judge cost is bounded without losing ranking
 *    signal (a cost lever, not a significance lever).
 */

export interface SuiteHealthInput {
  /** Fraction of cases that flaked at the floor in the latest run, in [0,1]. */
  flakeRate: number;
  /** Fraction of golden cases currently quarantined as stale, in [0,1]. */
  staleRate: number;
  /** Judge–human agreement (Cohen's κ) from the calibration channel, in [-1,1]. */
  judgeKappa: number;
}

export interface SuiteHealthThresholds {
  maxFlakeRate: number;
  maxStaleRate: number;
  minJudgeKappa: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: SuiteHealthThresholds = {
  maxFlakeRate: 0.1,
  maxStaleRate: 0.1,
  minJudgeKappa: 0.4,
};

export interface SuiteHealthVerdict {
  healthy: boolean;
  /** Reasons the suite is unhealthy (empty when healthy). */
  failures: string[];
}

/**
 * Fail CLOSED: a degraded suite cannot pass a candidate. Note `judgeKappa` only
 * gates when the judge axis is in use (κ is finite); pass `Number.NaN` to skip
 * the κ check for execution-only suites.
 */
export function assessSuiteHealth(
  input: SuiteHealthInput,
  thresholds: SuiteHealthThresholds = DEFAULT_HEALTH_THRESHOLDS
): SuiteHealthVerdict {
  const failures: string[] = [];
  if (input.flakeRate > thresholds.maxFlakeRate) {
    failures.push(`flake rate ${pct(input.flakeRate)} > ${pct(thresholds.maxFlakeRate)}`);
  }
  if (input.staleRate > thresholds.maxStaleRate) {
    failures.push(`stale-case rate ${pct(input.staleRate)} > ${pct(thresholds.maxStaleRate)}`);
  }
  if (!Number.isNaN(input.judgeKappa) && input.judgeKappa < thresholds.minJudgeKappa) {
    failures.push(`judge κ ${input.judgeKappa.toFixed(2)} < ${thresholds.minJudgeKappa}`);
  }
  return { failures, healthy: failures.length === 0 };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

/** True while the accrued spend is at/under the per-suite ceiling. */
export function withinCostCeiling(spentUsd: number, ceilingUsd: number | null): boolean {
  if (ceilingUsd == null) {
    return true;
  }
  return spentUsd <= ceilingUsd;
}

/**
 * Tiered-scoring policy (hard, not advisory): the cheap floor runs on every
 * case; the expensive judge runs only on the anchor subset. Returns the case
 * ids the judge is allowed to score.
 */
export function judgeAllowedCaseIds(allCaseIds: string[], anchorK: number): Set<string> {
  return new Set(selectAnchorSubset(allCaseIds, anchorK));
}

/**
 * Deterministically select up to K anchor cases that approximate the full set.
 * Uses an even stride over the (stable) id ordering so the subset is spread
 * across the set and reproducible across runs (no RNG — important for cache and
 * replay). For real use the ids should be pre-sorted by a difficulty/coverage
 * signal; here we preserve caller order and sample evenly.
 */
export function selectAnchorSubset<T>(items: T[], k: number): T[] {
  if (k <= 0) {
    return [];
  }
  if (k >= items.length) {
    return [...items];
  }
  const stride = items.length / k;
  const out: T[] = [];
  for (let i = 0; i < k; i += 1) {
    out.push(items[Math.floor(i * stride)]);
  }
  return out;
}
