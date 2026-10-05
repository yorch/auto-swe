import { describe, expect, it } from 'vitest';
import { seriesBuckets } from './dateWindow.js';

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
