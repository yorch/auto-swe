import { describe, expect, it } from 'vitest';
import { resolveWindow, seriesBuckets, utcDayStart } from './dateWindow.js';

const DAY = 24 * 60 * 60 * 1000;

describe('seriesBuckets', () => {
  it('uses one bucket per day up to 90 days', () => {
    const { bucketDays, buckets } = seriesBuckets(0, 90);
    expect(bucketDays).toBe(1);
    expect(buckets).toHaveLength(90);
  });

  it('uses weekly buckets above 90 days, clipping the last to the window', () => {
    const { bucketDays, buckets } = seriesBuckets(0, 366);
    expect(bucketDays).toBe(7);
    expect(buckets).toHaveLength(53);
    expect(buckets[0]).toEqual({ end: 7 * DAY, start: 0 });
    expect(buckets.at(-1)?.end).toBe(366 * DAY);
    expect(buckets.at(-1)?.start).toBe(364 * DAY);
  });
});

describe('resolveWindow', () => {
  // 15:30 UTC on 10 Jan: a preset must not start mid-day.
  const now = Date.parse('2026-01-10T15:30:00.000Z');

  it('turns a preset into whole UTC days closed at the end of today', () => {
    const w = resolveWindow({}, 7, now);
    expect(w.days).toBe(7);
    expect(w.start.toISOString()).toBe('2026-01-04T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-01-11T00:00:00.000Z');
    expect(w.previousStart.toISOString()).toBe('2025-12-28T00:00:00.000Z');
  });

  it('matches the custom range spanning the same inclusive days', () => {
    const preset = resolveWindow({}, 7, now);
    const custom = resolveWindow({ since: '2026-01-04', until: '2026-01-10' }, 30, now);
    expect(custom).toEqual(preset);
  });

  it('prefers a custom range over the preset length', () => {
    expect(resolveWindow({ since: '2026-01-01', until: '2026-01-02' }, 90, now).days).toBe(2);
  });

  it('floors an instant to its UTC day', () => {
    expect(new Date(utcDayStart(now)).toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });
});
