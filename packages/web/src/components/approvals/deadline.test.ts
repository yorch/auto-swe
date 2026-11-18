import { describe, expect, it } from 'vitest';
import { formatTimeUntil } from './deadline';

const HOUR = 3_600_000;

describe('formatTimeUntil', () => {
  it('says 7 days for a 7 day timeout that has run a moment', () => {
    expect(formatTimeUntil(167.99 * HOUR)).toBe('in 7 days');
  });

  it('counts hours under two days and minutes under an hour', () => {
    expect(formatTimeUntil(36 * HOUR)).toBe('in 36 hours');
    expect(formatTimeUntil(HOUR)).toBe('in 1 hour');
    expect(formatTimeUntil(5 * 60_000)).toBe('in 5 minutes');
  });

  it('handles the edges: under a minute and exactly two days', () => {
    expect(formatTimeUntil(30_000)).toBe('in under a minute');
    expect(formatTimeUntil(0)).toBe('in under a minute');
    expect(formatTimeUntil(48 * HOUR)).toBe('in 2 days');
  });
});
