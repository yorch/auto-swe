import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDate,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTokens,
} from './utils.js';

// These formatters deliberately follow the runtime's default locale, so the
// assertions compare against reference `Intl` instances built the same way
// rather than against hardcoded en-US strings — pinning expected output here
// would just re-introduce the assumption the formatters were fixed to drop,
// and would fail on any machine whose default locale isn't en-US.
//
// Note the delegation checks only *prove* a locale isn't hardcoded when the
// runtime default differs from the one someone might hardcode; on an en-US
// machine they still pin the option set (fraction digits, unit display, which
// parts appear), which is what the rewrite could plausibly have broken.
const ref = {
  compact: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' }),
  hours: new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'narrow',
  }),
  minutes: new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'narrow',
  }),
  percent: new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    style: 'percent',
  }),
  relative: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' }),
  seconds: new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
  }),
  usd: new Intl.NumberFormat(undefined, { currency: 'USD', style: 'currency' }),
};

describe('formatDate', () => {
  const when = new Date('2026-06-03T14:05:09Z');

  it('follows the runtime locale rather than a pinned one', () => {
    expect(formatDate(when)).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
      }).format(when)
    );
  });

  it('adds seconds and year only when asked', () => {
    expect(formatDate(when, { showSeconds: true })).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        second: '2-digit',
        year: 'numeric',
      }).format(when)
    );
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(formatDate(when.toISOString())).toBe(formatDate(when));
  });
});

describe('formatRelativeTime', () => {
  const ago = (ms: number) => formatRelativeTime(new Date(Date.now() - ms));

  it('collapses anything under a minute to the "now" form', () => {
    expect(ago(5_000)).toBe(ref.relative.format(0, 'second'));
  });

  it.each([
    ['minutes', 5 * 60_000, -5, 'minute' as const],
    ['hours', 3 * 3600_000, -3, 'hour' as const],
    ['days', 4 * 86400_000, -4, 'day' as const],
  ])('reports %s below the next threshold', (_label, elapsed, value, unit) => {
    expect(ago(elapsed)).toBe(ref.relative.format(value, unit));
  });

  it('switches unit exactly at each boundary', () => {
    expect(ago(60_000)).toBe(ref.relative.format(-1, 'minute'));
    expect(ago(3600_000)).toBe(ref.relative.format(-1, 'hour'));
    expect(ago(86400_000)).toBe(ref.relative.format(-1, 'day'));
  });
});

describe('formatCost', () => {
  it('renders an em dash for exactly zero', () => {
    expect(formatCost(0)).toBe('—');
  });

  it('marks sub-cent amounts as less-than one cent', () => {
    expect(formatCost(0.004)).toBe(`<${ref.usd.format(0.01)}`);
  });

  it('formats representable amounts as USD', () => {
    expect(formatCost(1234.5)).toBe(ref.usd.format(1234.5));
  });
});

describe('formatTokens', () => {
  it.each([999, 1500, 15_000, 1_200_000])('compacts %i', (n) => {
    expect(formatTokens(n)).toBe(ref.compact.format(n));
  });
});

describe('formatDuration', () => {
  it('renders an em dash for a null duration', () => {
    expect(formatDuration(null)).toBe('—');
  });

  it('uses whole seconds below a minute', () => {
    expect(formatDuration(45_400)).toBe(ref.seconds.format(45.4));
  });

  it('uses minutes between a minute and an hour', () => {
    expect(formatDuration(90_000)).toBe(ref.minutes.format(1.5));
  });

  it('uses hours at and above an hour', () => {
    expect(formatDuration(8_100_000)).toBe(ref.hours.format(2.25));
  });
});

describe('formatPercent', () => {
  it('renders an em dash for a null ratio', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('scales the ratio to a percentage exactly once', () => {
    expect(formatPercent(0.5)).toBe(ref.percent.format(0.5));
    expect(formatPercent(0.876)).toBe(ref.percent.format(0.876));
  });
});
