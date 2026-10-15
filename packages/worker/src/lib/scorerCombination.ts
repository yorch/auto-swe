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
  /**
   * Set when the scorer could not produce a score at all (a judge whose rubric
   * is missing, whose call failed, or whose output carried no score). `value`
   * is then a neutral placeholder, not a measurement — so a blocking judge
   * fails closed on it rather than comparing the placeholder to a threshold.
   */
  error?: string;
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
   * fails, else the mean of the soft axes that scored (1 when none did). NOT
   * the system of record; the per-axis rows are (RFC §2).
   */
  aggregate: number;
  /**
   * Per-scorer value, kept decomposable (stacked, not summed). A scorer that
   * could not score is absent: its value is a placeholder, not a measurement.
   */
  perAxis: Record<string, number>;
  /** Scorers that could not score, mapped to the reason. Empty when all scored. */
  errors: Record<string, string>;
}

export function combineScores(scores: ScoreInput[]): CombinedScore {
  const floorPassed = evaluateFloor(scores);
  const perAxis: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const s of scores) {
    if (s.error !== undefined) {
      errors[s.scorer] = s.error;
    } else {
      perAxis[s.scorer] = s.value;
    }
  }
  if (!floorPassed) {
    return { aggregate: 0, errors, floorPassed: false, perAxis, shouldRunJudge: false };
  }
  // An errored scorer's placeholder would drag the mean toward 0.5, so a broken
  // judge would read as a mediocre candidate. It is reported in `errors` instead.
  const soft = scores.filter((s) => !isFloorKind(s.kind) && s.error === undefined);
  const aggregate = soft.length > 0 ? soft.reduce((sum, s) => sum + s.value, 0) / soft.length : 1;
  return { aggregate, errors, floorPassed: true, perAxis, shouldRunJudge: true };
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
 * the judge is explicitly promoted to blocking (calibrated) and either falls
 * below its threshold or could not score at all (fail closed).
 */
export function decideGate(scores: ScoreInput[], opts: GateDecisionOpts = {}): GateDecision {
  const failedFloor = scores.filter((s) => isFloorKind(s.kind)).find((s) => !scorerPassed(s));
  if (failedFloor) {
    return { blocked: true, reason: `floor failed: ${failedFloor.scorer}` };
  }
  const judgeAdvisory = opts.judgeAdvisory ?? true;
  if (!judgeAdvisory) {
    // A blocking judge that could not score must not pass on its placeholder
    // value: an unverified candidate would clear the gate exactly when the
    // judge is broken. An advisory judge's error stays advisory.
    const failedJudge = scores.find((s) => s.kind === 'judge' && s.error !== undefined);
    if (failedJudge) {
      return {
        blocked: true,
        reason: `judge could not score (${failedJudge.scorer}: ${failedJudge.error})`,
      };
    }
    const threshold = opts.judgeThreshold ?? 0.5;
    const judges = scores.filter((s) => s.kind === 'judge');
    const weakJudge = judges.find((s) => s.value < threshold);
    if (weakJudge) {
      return {
        blocked: true,
        reason: `judge below threshold (${weakJudge.scorer}=${weakJudge.value} < ${threshold})`,
      };
    }
    if (judges.length > 0) {
      return { blocked: false, reason: `floor passed; judge at or above threshold ${threshold}` };
    }
  }
  return { blocked: false, reason: 'floor passed; soft axes advisory' };
}
