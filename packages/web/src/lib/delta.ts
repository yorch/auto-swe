/** A change between two windows, shaped for `Stat`'s `delta` prop. */
export function formatDelta(
  current: number | null,
  previous: number | null,
  opts: { higherIsBetter: boolean | null; noun: string; unit?: 'pp' | '%' }
): { value: string; positive: boolean } | null {
  if (current === null || previous === null) {
    return null;
  }
  const diff = current - previous;
  let value: string;
  if (opts.unit === 'pp') {
    // Rates arrive as 0–1; the change between two rates is in percentage points.
    const pp = diff * 100;
    if (Math.abs(pp) < 0.05) {
      return null;
    }
    value = `${pp > 0 ? '+' : '−'}${Math.abs(pp).toFixed(1)} pts`;
  } else {
    if (previous === 0) {
      return null;
    }
    const pct = (diff / previous) * 100;
    if (Math.abs(pct) < 0.5) {
      return null;
    }
    value = `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%`;
  }
  const rising = diff > 0;
  // A neutral metric (run volume) is shown in the calm colour either way.
  const positive = opts.higherIsBetter === null ? true : rising === opts.higherIsBetter;
  return { positive, value: `${value} ${opts.noun}` };
}
