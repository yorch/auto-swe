import type { EvalScorerTrend } from '@auto-swe/shared/types/api';

/** The daily means that had any signal, oldest first. */
function observed(trend: EvalScorerTrend): number[] {
  return trend.daily.flatMap((d) => (d.mean === null ? [] : [d.mean]));
}

/**
 * How far a scorer moved across the window: its latest day's mean minus its first
 * day's. Scores are normalised so higher is better, which makes negative bad. Null
 * when fewer than two days carried signal, so there is no movement to speak of.
 */
export function scorerChange(trend: EvalScorerTrend): number | null {
  const means = observed(trend);
  if (means.length < 2) {
    return null;
  }
  return (means[means.length - 1] as number) - (means[0] as number);
}

/** The latest day's mean that had any signal. */
export function latestMean(trend: EvalScorerTrend): number | null {
  const means = observed(trend);
  return means.length ? (means[means.length - 1] as number) : null;
}

/**
 * The scorer most worth looking at first: the one that fell furthest. When nothing
 * fell, the one with the most signals, so the chart is never empty while there is data.
 */
export function worstMovingScorer(trends: EvalScorerTrend[]): string | null {
  let worst: { scorer: string; change: number } | null = null;
  for (const t of trends) {
    const change = scorerChange(t);
    if (change !== null && change < 0 && (!worst || change < worst.change)) {
      worst = { change, scorer: t.scorer };
    }
  }
  if (worst) {
    return worst.scorer;
  }
  const busiest = [...trends].sort((a, b) => b.n - a.n)[0];
  return busiest?.scorer ?? null;
}
