import { describe, expect, it } from 'vitest';
import {
  customRangeIgnored,
  parseDateRange,
  rangeDays,
  rangeKey,
  rangePhrase,
  rangeQuery,
} from './dateRange';

describe('range helpers', () => {
  const custom = { from: '2026-09-01', kind: 'custom', to: '2026-09-14' } as const;

  it('parses a custom range unless the page opts out', () => {
    const params = new URLSearchParams('range=custom&from=2026-09-01&to=2026-09-14');
    expect(parseDateRange(params)).toEqual(custom);
    expect(parseDateRange(params, { allowCustom: false })).toEqual({ days: 30, kind: 'preset' });
  });

  it('falls back to the default when the span is too long or ends in the future', () => {
    const long = new URLSearchParams('range=custom&from=2024-01-01&to=2025-06-01');
    expect(parseDateRange(long)).toEqual({ days: 30, kind: 'preset' });
    expect(customRangeIgnored(long)).toBe(true);
    expect(parseDateRange(long, { maxSpanDays: 1000 }).kind).toBe('custom');
    const future = new URLSearchParams('range=custom&from=2026-09-01&to=2999-01-01');
    expect(parseDateRange(future)).toEqual({ days: 30, kind: 'preset' });
    const ok = new URLSearchParams('range=custom&from=2025-01-01&to=2025-12-31');
    expect(parseDateRange(ok).kind).toBe('custom');
    expect(customRangeIgnored(ok)).toBe(false);
  });

  it('maps a range to the gateway query', () => {
    expect(rangeQuery({ days: 7, kind: 'preset' })).toEqual({ window: '7' });
    expect(rangeQuery(custom)).toEqual({ since: '2026-09-01', until: '2026-09-14' });
  });

  it('counts a custom span inclusively and keys ranges apart', () => {
    expect(rangeDays(custom)).toBe(14);
    expect(rangeDays({ days: 90, kind: 'preset' })).toBe(90);
    expect(rangeKey(custom)).not.toBe(rangeKey({ days: 14, kind: 'preset' }));
    expect(rangePhrase({ days: 7, kind: 'preset' })).toBe('the last 7 days');
    expect(rangePhrase(custom)).toBe('2026-09-01 to 2026-09-14 (UTC)');
  });
});
