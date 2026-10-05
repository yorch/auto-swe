import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest span a custom range may cover, in calendar days. */
export const MAX_CUSTOM_SPAN_DAYS = 366;

/** A real calendar day written `YYYY-MM-DD`. */
const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date written YYYY-MM-DD')
  .refine(
    (v) => {
      const t = Date.parse(`${v}T00:00:00.000Z`);
      return Number.isFinite(t) && new Date(t).toISOString().startsWith(v);
    },
    {
      message: 'must be a real calendar date',
    }
  );

/**
 * Query fields for a custom range beside `window`. Both are inclusive UTC calendar days; when
 * given they replace `window`. Add them to a query schema and pass it through
 * {@link refineCustomRange}.
 */
export const customRangeFields = {
  since: IsoDay.optional(),
  until: IsoDay.optional(),
};

/** Why a custom range is unusable, or null when it is absent or fine. */
function customRangeProblem(q: { since?: string; until?: string }, now: number): string | null {
  if (q.since === undefined && q.until === undefined) {
    return null;
  }
  if (q.since === undefined || q.until === undefined) {
    return 'pass since and until together';
  }
  if (q.until < q.since) {
    return 'until must be on or after since';
  }
  if (q.until > new Date(now).toISOString().slice(0, 10)) {
    return 'until cannot be in the future';
  }
  const days = (Date.parse(q.until) - Date.parse(q.since)) / DAY_MS + 1;
  return days > MAX_CUSTOM_SPAN_DAYS
    ? `the range may span at most ${MAX_CUSTOM_SPAN_DAYS} days`
    : null;
}

/** Adds the custom-range checks to a query schema that carries {@link customRangeFields}. */
export function refineCustomRange<S extends z.ZodType<{ since?: string; until?: string }>>(
  schema: S
) {
  return schema.superRefine((q, ctx) => {
    const problem = customRangeProblem(q, Date.now());
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem, path: ['since'] });
    }
  });
}

export interface ResolvedWindow {
  /** Whole UTC days: start inclusive, end exclusive. */
  start: Date;
  end: Date;
  days: number;
  /** The same number of days directly before `start`. */
  previousStart: Date;
}

/** The custom range as instants, or null when the query carries none. */
export function resolveCustomRange(q: { since?: string; until?: string }): ResolvedWindow | null {
  if (q.since === undefined || q.until === undefined) {
    return null;
  }
  const start = new Date(`${q.since}T00:00:00.000Z`);
  const end = new Date(Date.parse(`${q.until}T00:00:00.000Z`) + DAY_MS);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  return { days, end, previousStart: new Date(start.getTime() - days * DAY_MS), start };
}

/** Above this many days a chart series is bucketed by week, so a long range stays a bounded query count. */
export const WEEKLY_BUCKET_ABOVE_DAYS = 90;

export interface SeriesBucket {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms, clipped to the end of the window. */
  end: number;
}

/**
 * Splits `[since, since + windowDays)` into the buckets a time series reports: a day each up to
 * {@link WEEKLY_BUCKET_ABOVE_DAYS}, otherwise seven days each (the last may be shorter). A 366-day
 * range is at most 53 buckets, so it costs at most 53 aggregate queries.
 */
export function seriesBuckets(
  since: number,
  windowDays: number
): { bucketDays: 1 | 7; buckets: SeriesBucket[] } {
  const bucketDays = windowDays > WEEKLY_BUCKET_ABOVE_DAYS ? 7 : 1;
  const buckets: SeriesBucket[] = [];
  const end = since + windowDays * DAY_MS;
  for (let start = since; start < end; start += bucketDays * DAY_MS) {
    buckets.push({ end: Math.min(start + bucketDays * DAY_MS, end), start });
  }
  return { bucketDays, buckets };
}
