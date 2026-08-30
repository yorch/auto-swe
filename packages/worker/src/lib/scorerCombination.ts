/**
 * Scorer combination + gate decision — P2 of the evals feature
 * (docs/evals-p2.md, RFC §2 combination model + §9 decision rule).
 *
 * Pure logic, unit-tested. Implements the "floor → rank → per-axis" model:
 *   1. Floor scorers (execution + guardrail) are hard/binary; if any fails the
 *      aggregate is 0 and the judge does NOT run (short-circuit — saves cost).
 *   2. Soft scorers (trajectory + judge) rank passing candidates; they are
 *      reported per-axis and are advisory until calibrated.
 *
 * The gate decision (RFC §9 8a) is explicit so a gate always terminates in a
 * decision: execution + guardrail are blocking; trajectory + judge are
 * advisory-with-thresholds and may only block once the judge is calibrated.
 */

export type ScorerKind = 'gate' | 'assert' | 'trajectory' | 'judge' | 'policy' | 'pii';

export interface ScoreInput {
  kind: ScorerKind;
  /** Scorer identity, e.g. 'gate:runTests', 'judge:code-review-quality'. */
  scorer: string;
  /** Normalized score in [0,1]. */
  value: number;
  /** Explicit pass/fail for floor scorers (defaults to value >= 1). */
  passed?: boolean;
}

/** Floor = the hard, blocking axes (execution + programmatic guardrail). */
const FLOOR_KINDS: ReadonlySet<ScorerKind> = new Set<ScorerKind>([
  'gate',
  'assert',
  'policy',
  'pii',
]);

export function isFloorKind(kind: ScorerKind): boolean {
  return FLOOR_KINDS.has(kind);
}

function scorerPassed(s: ScoreInput): boolean {
  return s.passed ?? s.value >= 1;
}

/**
 * Evaluate only the floor, for the pre-judge short-circuit. True when every
 * floor scorer passed (vacuously true when there are no floor scorers).
 */
export function evaluateFloor(floorScores: ScoreInput[]): boolean {
  return floorScores.filter((s) => isFloorKind(s.kind)).every(scorerPassed);
}

export interface CombinedScore {
  /** Every floor scorer passed. */
  floorPassed: boolean;
  /** Whether the judge should run (only when the floor passes). */
  shouldRunJudge: boolean;
  /**
   * Convenience aggregate in [0,1] for `cond` branching — 0 when the floor
   * fails, else the mean of the soft axes (1 when there are none). NOT the
   * system of record; the per-axis rows are (RFC §2).
   */
  aggregate: number;
  /** Per-scorer value, kept decomposable (stacked, not summed). */
  perAxis: Record<string, number>;
}

export function combineScores(scores: ScoreInput[]): CombinedScore {
  const floorPassed = evaluateFloor(scores);
  const perAxis: Record<string, number> = {};
  for (const s of scores) {
    perAxis[s.scorer] = s.value;
  }
  if (!floorPassed) {
    return { aggregate: 0, floorPassed: false, perAxis, shouldRunJudge: false };
  }
  const soft = scores.filter((s) => !isFloorKind(s.kind));
  const aggregate = soft.length > 0 ? soft.reduce((sum, s) => sum + s.value, 0) / soft.length : 1;
  return { aggregate, floorPassed: true, perAxis, shouldRunJudge: true };
}

export interface GateDecisionOpts {
  /**
   * When true (default), the judge axis is advisory and never blocks — the gate
   * rests on execution + trajectory. Set false only once the judge's κ clears a
   * documented threshold (RFC §9).
   */
  judgeAdvisory?: boolean;
  /** Minimum judge value to pass when the judge is NOT advisory. */
  judgeThreshold?: number;
}

export interface GateDecision {
  blocked: boolean;
  reason: string;
}

/**
 * The decision rule (RFC §9 8a). A gate must terminate in a decision:
 * execution + guardrail are blocking; trajectory + judge are advisory unless
 * the judge is explicitly promoted to blocking (calibrated) and falls below
 * its threshold.
 */
export function decideGate(scores: ScoreInput[], opts: GateDecisionOpts = {}): GateDecision {
  const failedFloor = scores.filter((s) => isFloorKind(s.kind)).find((s) => !scorerPassed(s));
  if (failedFloor) {
    return { blocked: true, reason: `floor failed: ${failedFloor.scorer}` };
  }
  const judgeAdvisory = opts.judgeAdvisory ?? true;
  if (!judgeAdvisory) {
    const threshold = opts.judgeThreshold ?? 0.5;
    const weakJudge = scores.find((s) => s.kind === 'judge' && s.value < threshold);
    if (weakJudge) {
      return {
        blocked: true,
        reason: `judge below threshold (${weakJudge.scorer}=${weakJudge.value} < ${threshold})`,
      };
    }
  }
  return { blocked: false, reason: 'floor passed; soft axes advisory' };
}
