/**
 * Where one step's band sits on the replay scrubber, as percentages of the run.
 *
 * With `clamp` the `left` and `width` are held inside the track: a running step has no end (it
 * is drawn five percent of the run long from its start), a very short step is widened to a
 * visible 1%, and a step that started near the end can be pushed past 100% by either. An
 * overhanging band is harmless in the desktop layout, whose `overflow-hidden` clips it at the
 * viewport (and it has always been drawn there, a few pixels past the track), but in the
 * stacked page, which scrolls, it became sideways page scroll. So the stacked layout clamps and
 * desktop (`clamp` false) keeps the geometry it always had. Inside the track both are identical.
 */
export function stepBand(
  step: { startedAt: string; endedAt: string | null },
  runStartMs: number,
  totalMs: number,
  clamp = true
): { leftPct: number; widthPct: number } {
  const stepStart = new Date(step.startedAt).getTime() - runStartMs;
  const stepEnd = step.endedAt
    ? new Date(step.endedAt).getTime() - runStartMs
    : stepStart + totalMs * 0.05;
  const rawLeft = (stepStart / totalMs) * 100;
  const rawWidth = Math.max(1, ((stepEnd - stepStart) / totalMs) * 100);
  if (!clamp) {
    return { leftPct: rawLeft, widthPct: rawWidth };
  }
  const leftPct = Math.min(Math.max(rawLeft, 0), 100);
  return { leftPct, widthPct: Math.min(rawWidth, 100 - leftPct) };
}
