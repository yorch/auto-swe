import { describe, expect, it } from 'vitest';
import { describeCron, normalizeCron } from './cronPreview';

const text = (expr: string) => {
  const result = describeCron(expr);
  return result.ok ? result.text : `ERROR: ${result.error}`;
};

describe('describeCron', () => {
  it('reads a fixed time of day', () => {
    expect(text('0 9 * * *')).toBe('Every day at 09:00 UTC');
    expect(text('30 14 * * 1-5')).toBe('Weekdays at 14:30 UTC');
    expect(text('0 9 * * 1')).toBe('Mondays at 09:00 UTC');
    expect(text('0 9 * * 1,3')).toBe('Mon, Wed at 09:00 UTC');
    expect(text('0 9 * * 0,6')).toBe('Weekends at 09:00 UTC');
    expect(text('0 9 * * 7')).toBe('Sundays at 09:00 UTC');
  });

  it('reads both day fields as either-or, the way cron runs them', () => {
    expect(text('0 9 1 * 1')).toBe('On day 1 of the month or on mondays at 09:00 UTC');
  });

  it('normalises whitespace the way the server pattern expects', () => {
    expect(normalizeCron('  0   9\t* * 1 ')).toBe('0 9 * * 1');
    expect(normalizeCron('   ')).toBe('');
  });

  it('reads day-of-month and month restrictions', () => {
    expect(text('0 6 1,15 * *')).toBe('On days 1, 15 of the month at 06:00 UTC');
    expect(text('0 6 1 1,7 *')).toBe('On day 1 of the month in Jan, Jul at 06:00 UTC');
  });

  it('reads frequent cadences', () => {
    expect(text('*/5 * * * *')).toBe('Every 5 minutes (UTC)');
    expect(text('* * * * *')).toBe('Every minute (UTC)');
    expect(text('15 * * * *')).toBe('Every hour at minute 15 (UTC)');
    expect(text('*/10 * * * 1-5')).toBe('Every 10 minutes, weekdays only (UTC)');
  });

  it('rejects the wrong number of fields', () => {
    expect(text('0 9 * *')).toMatch(/five fields/);
    expect(text('')).toMatch(/five fields/);
  });

  it('rejects out-of-range and malformed fields', () => {
    expect(text('60 9 * * *')).toMatch(/minute must be between 0 and 59/);
    expect(text('0 24 * * *')).toMatch(/hour must be between 0 and 23/);
    expect(text('0 9 32 * *')).toMatch(/day of month/);
    expect(text('0 9 * 13 *')).toMatch(/month/);
    expect(text('0 9 * * 8')).toMatch(/day of week/);
    expect(text('5-1 9 * * *')).toMatch(/minute/);
    expect(text('a 9 * * *')).toMatch(/not valid/);
  });
});
