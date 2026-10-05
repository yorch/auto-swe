import { describe, expect, it } from 'vitest';
import { stepBand } from './runTimeline';

const RUN_START = Date.parse('2026-10-01T12:00:00Z');
const TOTAL = 10 * 60_000;
const at = (min: number) => new Date(RUN_START + min * 60_000).toISOString();

describe('stepBand', () => {
  it('is the plain proportion of the run for a step inside it', () => {
    expect(stepBand({ endedAt: at(4), startedAt: at(2) }, RUN_START, TOTAL)).toEqual({
      leftPct: 20,
      widthPct: 20,
    });
  });

  it('draws a running step five percent of the run long, and keeps it on the track near the end', () => {
    expect(stepBand({ endedAt: null, startedAt: at(2) }, RUN_START, TOTAL)).toEqual({
      leftPct: 20,
      widthPct: 5,
    });
    const late = stepBand({ endedAt: null, startedAt: at(9.9) }, RUN_START, TOTAL);
    expect(late.leftPct + late.widthPct).toBeLessThanOrEqual(100);
  });

  it('never lets a band leave the track, whatever the timestamps say', () => {
    const steps = [
      { endedAt: null, startedAt: at(10) },
      { endedAt: at(25), startedAt: at(9) },
      { endedAt: at(-1), startedAt: at(-5) },
      { endedAt: at(10.001), startedAt: at(10.0005) },
      { endedAt: null, startedAt: at(40) },
    ];
    for (const step of steps) {
      const { leftPct, widthPct } = stepBand(step, RUN_START, TOTAL);
      expect(leftPct).toBeGreaterThanOrEqual(0);
      expect(widthPct).toBeGreaterThanOrEqual(0);
      expect(leftPct + widthPct).toBeLessThanOrEqual(100);
    }
  });

  it('keeps the legacy, unclamped geometry when asked (desktop draws it, clipped by the viewport)', () => {
    expect(stepBand({ endedAt: null, startedAt: at(10.625) }, RUN_START, TOTAL, false)).toEqual({
      leftPct: 106.25,
      widthPct: 5,
    });
    const inside = { endedAt: at(4), startedAt: at(2) };
    expect(stepBand(inside, RUN_START, TOTAL, false)).toEqual(
      stepBand(inside, RUN_START, TOTAL, true)
    );
  });
});
