import { describe, expect, it } from 'vitest';
import { formatDelta } from './delta';

describe('formatDelta', () => {
  it('colours by whether the direction is good', () => {
    expect(formatDelta(120, 100, { higherIsBetter: false, noun: 'vs previous' })).toEqual({
      positive: false,
      value: '+20% vs previous',
    });
    expect(formatDelta(80, 100, { higherIsBetter: false, noun: 'vs previous' })?.positive).toBe(
      true
    );
  });

  it('reports a rate change in points and stays quiet without a baseline', () => {
    expect(
      formatDelta(0.8, 0.9, { higherIsBetter: true, noun: 'vs previous', unit: 'pp' })
    ).toEqual({ positive: false, value: '−10.0 pts vs previous' });
    expect(formatDelta(5, 0, { higherIsBetter: true, noun: 'x' })).toBeNull();
    expect(formatDelta(null, 1, { higherIsBetter: true, noun: 'x' })).toBeNull();
  });
});
