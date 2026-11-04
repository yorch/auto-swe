import { describe, expect, it } from 'vitest';
import { formatDelta } from './delta';

describe('formatDelta', () => {
  it('separates the direction of the move from whether it is good', () => {
    expect(formatDelta(120, 100, { higherIsBetter: false, noun: 'vs previous' })).toEqual({
      direction: 'up',
      tone: 'bad',
      value: '+20% vs previous',
    });
    expect(formatDelta(80, 100, { higherIsBetter: false, noun: 'vs previous' })).toMatchObject({
      direction: 'down',
      tone: 'good',
    });
  });

  it('keeps a neutral metric neutral whichever way it moves', () => {
    expect(formatDelta(60, 100, { higherIsBetter: null, noun: 'vs previous' })).toEqual({
      direction: 'down',
      tone: 'neutral',
      value: '−40% vs previous',
    });
    expect(formatDelta(140, 100, { higherIsBetter: null, noun: 'vs previous' })).toMatchObject({
      direction: 'up',
      tone: 'neutral',
    });
  });

  it('reports a rate change in points and stays quiet without a baseline', () => {
    expect(
      formatDelta(0.8, 0.9, { higherIsBetter: true, noun: 'vs previous', unit: 'pp' })
    ).toEqual({ direction: 'down', tone: 'bad', value: '−10.0 pts vs previous' });
    expect(formatDelta(5, 0, { higherIsBetter: true, noun: 'x' })).toBeNull();
    expect(formatDelta(null, 1, { higherIsBetter: true, noun: 'x' })).toBeNull();
  });
});
