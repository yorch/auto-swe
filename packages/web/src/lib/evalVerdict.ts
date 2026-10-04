/** One slice's paired comparison, as the harness stores it (`regressionVerdict` in the worker). */
export interface PairedDelta {
  n: number;
  delta: number;
  baselineRate: number;
  candidateRate: number;
  se: number;
  ci95: [number, number];
}

/** Percentage points, signed: "+4.2 pts". A real minus sign keeps a drop readable. */
export function formatPoints(x: number): string {
  const pts = (x * 100).toFixed(1);
  return x < 0 ? `−${pts.slice(1)} pts` : `+${pts} pts`;
}

/** Whether the whole 95% range sits on one side of zero. */
export function significance(d: PairedDelta): 'worse' | 'better' | 'none' {
  if (d.ci95[1] < 0) {
    return 'worse';
  }
  return d.ci95[0] > 0 ? 'better' : 'none';
}

/**
 * The verdict in one sentence for the top of a run: how far the candidate moved and
 * whether that is a real difference or inside the noise.
 */
export function verdictSentence(overall: PairedDelta): {
  text: string;
  tone: 'error' | 'success' | 'info';
} {
  const pts = Math.abs(overall.delta * 100).toFixed(1);
  switch (significance(overall)) {
    case 'worse':
      return {
        text: `Candidate is ${pts} points worse than the baseline, and the difference is significant.`,
        tone: 'error',
      };
    case 'better':
      return {
        text: `Candidate is ${pts} points better than the baseline, and the difference is significant.`,
        tone: 'success',
      };
    default:
      return {
        text:
          overall.delta === 0
            ? 'Candidate scored the same as the baseline.'
            : `Candidate is ${pts} points ${overall.delta < 0 ? 'worse' : 'better'} than the baseline, but the difference is within the margin of error.`,
        tone: 'info',
      };
  }
}
