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

/**
 * Reads `range`, `from` and `to` from the URL; anything unusable falls back to the default.
 * A page that serves presets only passes `allowCustom: false`, so a shared `range=custom`
 * link falls back to the default preset (see `customRangeIgnored` for telling the reader).
 */
export function parseDateRange(
  params: URLSearchParams | { get(name: string): string | null },
  opts: { allowCustom?: boolean; defaultDays?: number; presets?: readonly number[] } = {}
): DateRange {
  const presets = opts.presets ?? DEFAULT_PRESETS;
  const fallback = opts.defaultDays ?? 30;
  const range = params.get('range');
  const from = params.get('from');
  const to = params.get('to');
  if (
    opts.allowCustom !== false &&
    range === 'custom' &&
    isIsoDay(from) &&
    isIsoDay(to) &&
    from <= to
  ) {
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

/** Short heading for a range: "Last 30 days" or "1 Sep – 14 Sep 2026 (UTC)". */
export function describeRange(range: DateRange): string {
  return range.kind === 'preset' ? `Last ${range.days} days` : `${range.from} to ${range.to} (UTC)`;
}

/** The range inside a sentence: "the last 30 days" or "2026-09-01 to 2026-09-14 (UTC)". */
export function rangePhrase(range: DateRange): string {
  return range.kind === 'preset' ? `the last ${range.days} days` : describeRange(range);
}

/**
 * The inclusive first and last UTC calendar day of a range. A preset of N days is the N whole
 * days ending with today, so "7 days" is seven calendar days wherever it is used.
 */
export function dayRange(range: DateRange, now = new Date()): { from: string; to: string } {
  if (range.kind === 'custom') {
    return { from: range.from, to: range.to };
  }
  const todayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  return { from: utcDay(new Date(todayStart - (range.days - 1) * DAY_MS)), to: utcDay(now) };
}

/**
 * Whole-UTC-day bounds of a range, as ISO instants (start inclusive, end exclusive).
 * A preset ends at the close of today, so the value is stable all day and a query
 * keyed on it is not refetched on every render.
 */
export function dayBounds(range: DateRange, now = new Date()): { since: string; until: string } {
  const { from, to } = dayRange(range, now);
  return {
    since: `${from}T00:00:00.000Z`,
    until: new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS).toISOString(),
  };
}

/** Calendar days a range covers: a preset's N, or a custom span counted inclusively. */
export function rangeDays(range: DateRange): number {
  if (range.kind === 'preset') {
    return range.days;
  }
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 1;
}

/**
 * The query string fields a gateway endpoint takes for a range: `window` for a preset,
 * `since` / `until` (inclusive UTC days) for a custom span.
 */
export function rangeQuery(range: DateRange): Record<string, string> {
  return range.kind === 'preset'
    ? { window: String(range.days) }
    : { since: range.from, until: range.to };
}

/** A stable cache-key part for a range. */
export function rangeKey(range: DateRange): string {
  return range.kind === 'preset' ? `${range.days}d` : `${range.from}..${range.to}`;
}

/** True when the URL asked for a custom range that a presets-only page cannot serve. */
export function customRangeIgnored(params: { get(name: string): string | null }): boolean {
  return params.get('range') === 'custom';
}
