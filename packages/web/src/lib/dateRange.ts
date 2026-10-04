/**
 * The date range a govern data page filters on, as it round-trips through the
 * URL: a preset of N days ending now, or a custom span of UTC calendar days.
 * Every day here is a UTC day — the gateway buckets and reports in UTC, so the
 * control labels it rather than converting.
 */
export type DateRange =
  | { kind: 'preset'; days: number }
  | { kind: 'custom'; from: string; to: string };

export const DEFAULT_PRESETS = [7, 30, 90] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(value: string | null | undefined): value is string {
  if (!value || !DAY_RE.test(value)) {
    return false;
  }
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(value);
}

/** Reads `range`, `from` and `to` from the URL; anything unusable falls back to the default. */
export function parseDateRange(
  params: URLSearchParams | { get(name: string): string | null },
  opts: { defaultDays?: number; presets?: readonly number[] } = {}
): DateRange {
  const presets = opts.presets ?? DEFAULT_PRESETS;
  const fallback = opts.defaultDays ?? 30;
  const range = params.get('range');
  const from = params.get('from');
  const to = params.get('to');
  if (range === 'custom' && isIsoDay(from) && isIsoDay(to) && from <= to) {
    return { from, kind: 'custom', to };
  }
  const days = Number(range);
  if (presets.includes(days)) {
    return { days, kind: 'preset' };
  }
  return { days: fallback, kind: 'preset' };
}

/** The URL patch that selects `range`; the default is written as absent keys. */
export function dateRangePatch(range: DateRange, defaultDays = 30): Record<string, string | null> {
  if (range.kind === 'custom') {
    return { from: range.from, range: 'custom', to: range.to };
  }
  return { from: null, range: range.days === defaultDays ? null : String(range.days), to: null };
}

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive start and exclusive end instants of a range, as ISO strings. */
export function rangeBounds(range: DateRange, now = new Date()): { since: string; until: string } {
  if (range.kind === 'custom') {
    return {
      since: `${range.from}T00:00:00.000Z`,
      until: new Date(Date.parse(`${range.to}T00:00:00.000Z`) + DAY_MS).toISOString(),
    };
  }
  return {
    since: new Date(now.getTime() - range.days * DAY_MS).toISOString(),
    until: now.toISOString(),
  };
}

/** Short heading for a range: "Last 30 days" or "1 Sep – 14 Sep 2026 (UTC)". */
export function describeRange(range: DateRange): string {
  return range.kind === 'preset' ? `Last ${range.days} days` : `${range.from} to ${range.to} (UTC)`;
}

/**
 * Whole-UTC-day bounds of a range, as ISO instants (start inclusive, end exclusive).
 * A preset ends at the close of today, so the value is stable all day and a query
 * keyed on it is not refetched on every render.
 */
export function dayBounds(range: DateRange, now = new Date()): { since: string; until: string } {
  if (range.kind === 'custom') {
    return rangeBounds(range);
  }
  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const until = todayStart + DAY_MS;
  return {
    since: new Date(until - range.days * DAY_MS).toISOString(),
    until: new Date(until).toISOString(),
  };
}
