import { describe, expect, it } from 'vitest';
import { previewCron } from './cronPreview';

const FROM = new Date('2026-11-04T10:30:00.000Z'); // a Wednesday

describe('previewCron', () => {
  it('summarises a weekly schedule and lists the next three fires in UTC', () => {
    const p = previewCron('0 3 * * 1', FROM);
    expect(p?.summary).toBe('Every Monday at 03:00 UTC');
    expect(p?.next.map((d) => d.toISOString())).toEqual([
      '2026-11-09T03:00:00.000Z',
      '2026-11-16T03:00:00.000Z',
      '2026-11-23T03:00:00.000Z',
    ]);
    expect(p?.subHourly).toBe(false);
  });

  it('flags a schedule that fires more often than hourly', () => {
    expect(previewCron('* * * * *', FROM)?.subHourly).toBe(true);
    expect(previewCron('*/15 * * * *', FROM)?.subHourly).toBe(true);
    expect(previewCron('0 * * * *', FROM)?.subHourly).toBe(false);
  });

  it('handles ranges, lists and steps', () => {
    expect(previewCron('0 9 * * 1-5', FROM)?.next[0]?.toISOString()).toBe(
      '2026-11-05T09:00:00.000Z'
    );
    expect(previewCron('30 6,18 * * *', FROM)?.next[0]?.toISOString()).toBe(
      '2026-11-04T18:30:00.000Z'
    );
  });

  it('does not read month or weekday names, which the server refuses', () => {
    expect(previewCron('0 9 * * mon', FROM)).toBeNull();
    expect(previewCron('0 9 * jan *', FROM)).toBeNull();
  });

  it('requires both day-of-month and day-of-week to match, like Temporal', () => {
    // First Monday of the month: days 1-7 that are also a Monday.
    const p = previewCron('0 9 1-7 * 1', FROM);
    expect(p?.next.map((d) => d.toISOString())).toEqual([
      '2026-12-07T09:00:00.000Z',
      '2027-01-04T09:00:00.000Z',
      '2027-02-01T09:00:00.000Z',
    ]);
  });

  it('rejects anything that is not a valid 5-field expression', () => {
    expect(previewCron('0 3 * *', FROM)).toBeNull();
    expect(previewCron('61 3 * * *', FROM)).toBeNull();
    expect(previewCron('0 3 * * 9', FROM)).toBeNull();
    expect(previewCron('a b c d e', FROM)).toBeNull();
  });
});
