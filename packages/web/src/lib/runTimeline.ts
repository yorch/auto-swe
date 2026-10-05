/**
 * Where one step's band sits on the replay scrubber, as percentages of the run.
 *
 * `left` and `width` are clamped so the band never leaves the track: a running step has no end
 * (it is drawn five percent of the run long from its start), a very short step is widened to a
 * visible 1%, and a step that started near the end can be pushed past 100% by either. An
 * unclamped band overflowed its overlay, which the desktop layout's `overflow-hidden` hid and a
 * stacked page, which scrolls, turned into sideways page scroll. Inside the track the result is
 * exactly the unclamped geometry.
 */
export function stepBand(
  step: { startedAt: string; endedAt: string | null },
  runStartMs: number,
  totalMs: number
): { leftPct: number; widthPct: number } {
  const stepStart = new Date(step.startedAt).getTime() - runStartMs;
  const stepEnd = step.endedAt
    ? new Date(step.endedAt).getTime() - runStartMs
    : stepStart + totalMs * 0.05;
  const leftPct = Math.min(Math.max((stepStart / totalMs) * 100, 0), 100);
  const widthPct = Math.max(1, ((stepEnd - stepStart) / totalMs) * 100);
  return { leftPct, widthPct: Math.min(widthPct, 100 - leftPct) };
}
