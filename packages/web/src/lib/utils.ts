import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Locale-sensitive display helpers ────────────────────────────────────────
//
// Every formatter below passes `undefined` as the locale so the reader's own
// browser preference decides date order, decimal separators, and unit names.
// Pinning a locale here is what made a non-US reader see US-ordered dates from
// `formatDate` next to browser-ordered ones from the bare `toLocaleString()`
// calls elsewhere in the app.
//
// These are safe to resolve at render time: every caller is a client component
// whose data arrives from TanStack Query after mount, and the app does no SSR
// prefetch, so none of this runs on the server where the locale would differ.
//
// `Intl` objects are expensive to construct and these run once per row in long
// tables, so each is built lazily and reused.
function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= make();
    return value;
  };
}

const DATE_PARTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
};
const shortDate = lazy(() => new Intl.DateTimeFormat(undefined, DATE_PARTS));
const preciseDate = lazy(
  () => new Intl.DateTimeFormat(undefined, { ...DATE_PARTS, second: '2-digit', year: 'numeric' })
);

export function formatDate(date: string | Date, options?: { showSeconds?: boolean }): string {
  const formatter = options?.showSeconds ? preciseDate() : shortDate();
  return formatter.format(new Date(date));
}

// `numeric: 'auto'` yields "now" for the sub-minute case (and "yesterday" for a
// single day) instead of a bare "0s ago"; `narrow` keeps the en output at the
// same width as the hand-rolled "5m ago" it replaces.
const relativeTime = lazy(
  () => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' })
);

export function formatRelativeTime(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();

  if (diff < 60_000) {
    return relativeTime().format(0, 'second');
  }
  if (diff < 3600_000) {
    return relativeTime().format(-Math.floor(diff / 60_000), 'minute');
  }
  if (diff < 86400_000) {
    return relativeTime().format(-Math.floor(diff / 3600_000), 'hour');
  }
  return relativeTime().format(-Math.floor(diff / 86400_000), 'day');
}

// Costs are denominated in USD (MODEL_PRICES is USD per MTok), so the currency
// is fixed and only its presentation follows the locale.
const usd = lazy(() => new Intl.NumberFormat(undefined, { currency: 'USD', style: 'currency' }));

export function formatCost(usdAmount: number): string {
  if (usdAmount === 0) {
    return '—';
  }
  if (usdAmount < 0.01) {
    return `<${usd().format(0.01)}`;
  }
  return usd().format(usdAmount);
}

const compact = lazy(
  () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' })
);

export function formatTokens(n: number): string {
  return compact().format(n);
}

const durationUnit = (unit: 'second' | 'minute' | 'hour', maximumFractionDigits: number) =>
  lazy(
    () =>
      new Intl.NumberFormat(undefined, {
        maximumFractionDigits,
        style: 'unit',
        unit,
        unitDisplay: 'narrow',
      })
  );
const seconds = durationUnit('second', 0);
const minutes = durationUnit('minute', 1);
const hours = durationUnit('hour', 2);

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  if (ms < 60_000) {
    return seconds().format(ms / 1000);
  }
  if (ms < 3_600_000) {
    return minutes().format(ms / 60_000);
  }
  return hours().format(ms / 3_600_000);
}

// `style: 'percent'` scales by 100 itself, so the ratio is passed through as-is.
const percent = lazy(
  () =>
    new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
      style: 'percent',
    })
);

export function formatPercent(p: number | null): string {
  if (p === null) {
    return '—';
  }
  return percent().format(p);
}

// ── Status palette aligned with the Workshop Telemetry design system ────────
type StatusMeta = {
  /** Border + text colour combo for the pill */
  classes: string;
  /** Background colour for the leading status dot */
  dotClass: string;
  /** If true, dot pulses to indicate an in-flight workflow */
  live?: boolean;
};

const MOSS: StatusMeta = {
  classes: 'border-moss-600/50 bg-moss-600/10 text-moss-400',
  dotClass: 'bg-moss-400',
};
const EMBER_LIVE: StatusMeta = {
  classes: 'border-ember-600/50 bg-ember-600/10 text-ember-400',
  dotClass: 'bg-ember-400',
  live: true,
};
const DUST_LIVE: StatusMeta = {
  classes: 'border-dust-600/50 bg-dust-600/10 text-dust-400',
  dotClass: 'bg-dust-400',
  live: true,
};
const AMBER: StatusMeta = {
  classes: 'border-amber-600/50 bg-amber-600/10 text-amber-400',
  dotClass: 'bg-amber-400',
};
const BRICK: StatusMeta = {
  classes: 'border-brick-600/50 bg-brick-600/10 text-brick-400',
  dotClass: 'bg-brick-400',
};
const VIOLET: StatusMeta = {
  classes: 'border-violet-600/50 bg-violet-600/10 text-violet-400',
  dotClass: 'bg-violet-400',
};
const NEUTRAL: StatusMeta = {
  classes: 'border-ink-400/60 bg-ink-600/30 text-paper-500',
  dotClass: 'bg-paper-600',
};

export const STATUS_META: Record<string, StatusMeta> = {
  // ── WorkflowTemplateStatus ──
  ACTIVE: MOSS,
  ARCHIVED: NEUTRAL,
  // ── ActiveWorkflow.currentStatus ──
  AWAITING_CI: AMBER,
  AWAITING_HUMAN_MERGE: { ...AMBER, dotClass: 'bg-ember-400', live: true },
  // ── WorkflowRunStatus ──
  CANCELLED: NEUTRAL,
  COMPLETED: MOSS,
  DRAFT: AMBER,
  FAILED: BRICK,
  IMPLEMENTING: EMBER_LIVE,
  IN_REVIEW: VIOLET,
  // ── WorkflowStepRecordStatus ──
  PASSED: MOSS,
  PENDING: AMBER,
  RUNNING: DUST_LIVE,
  SKIPPED: NEUTRAL,
  SUCCESS: MOSS,
  TIMED_OUT: NEUTRAL,
  UNKNOWN: NEUTRAL,
  VALIDATING_CONTEXT: EMBER_LIVE,
};
