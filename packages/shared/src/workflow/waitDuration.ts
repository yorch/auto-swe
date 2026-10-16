/**
 * Wait durations for `signal` and HITL nodes, kept free of runtime
 * dependencies: the spec schema validates with these, and the Temporal
 * workflow isolate reads them through `signalSlots.ts`, where a zod import
 * would ride along into the workflow bundle.
 */

/**
 * The duration strings a signal or HITL wait accepts: the grammar Temporal's
 * `Duration` string goes through (the `ms` package — a number with an optional
 * unit, case-insensitive, optional space: `30m`, `24h`, `7d`, `2 hours`,
 * `1.5h`, `500`), restricted to positive values. Checked when the spec is
 * parsed, so a bad value fails the save or the run's setup instead of throwing
 * a `TypeError` at the wait node.
 */
const DURATION_RE =
  /^(?:\d+)?\.?\d+ *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/** True when `value` is a positive duration Temporal can parse (see {@link DURATION_RE}). */
export function isValidWaitDuration(value: string): boolean {
  // `ms` refuses anything over 100 characters.
  if (value.length > 100 || !DURATION_RE.test(value)) {
    return false;
  }
  return Number.parseFloat(value) > 0;
}

const DURATION_UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/**
 * Milliseconds in a wait duration, read the way Temporal reads it (no unit
 * means milliseconds). 0 when `value` is not a valid positive duration.
 */
export function waitDurationMs(value: string): number {
  if (!isValidWaitDuration(value)) {
    return 0;
  }
  const unit = (DURATION_RE.exec(value)?.[1] ?? 'ms').toLowerCase();
  const key = /^(ms|msecs?|milliseconds?)$/.test(unit) ? 'ms' : unit[0];
  return Number.parseFloat(value) * (DURATION_UNIT_MS[key] ?? 0);
}
