import { describe, expect, it } from 'vitest';
import {
  combineScores,
  decideGate,
  evaluateFloor,
  isFloorKind,
  type ScoreInput,
} from './scorerCombination.js';

const gate = (value: number, passed?: boolean): ScoreInput => ({
  kind: 'gate',
  passed,
  scorer: 'gate:runTests',
  value,
});
const judge = (value: number): ScoreInput => ({
  kind: 'judge',
  scorer: 'judge:quality',
  value,
});
const trajectory = (value: number): ScoreInput => ({
  kind: 'trajectory',
  scorer: 'trajectory:steps',
  value,
});

describe('isFloorKind', () => {
  it('treats gate + assert as floor, trajectory + judge as soft', () => {
    expect(isFloorKind('gate')).toBe(true);
    expect(isFloorKind('assert')).toBe(true);
    expect(isFloorKind('trajectory')).toBe(false);
    expect(isFloorKind('judge')).toBe(false);
  });
});

describe('combineScores', () => {
  it('gates the aggregate to 0 and skips the judge when the floor fails', () => {
    const c = combineScores([gate(0, false), judge(0.9)]);
    expect(c.floorPassed).toBe(false);
    expect(c.aggregate).toBe(0);
    expect(c.shouldRunJudge).toBe(false);
    // per-axis is still decomposable
    expect(c.perAxis['judge:quality']).toBe(0.9);
  });

  it('averages the soft axes when the floor passes', () => {
    const c = combineScores([gate(1, true), judge(0.8), trajectory(0.6)]);
    expect(c.floorPassed).toBe(true);
    expect(c.shouldRunJudge).toBe(true);
    expect(c.aggregate).toBeCloseTo(0.7, 6);
  });

  it('aggregates to 1 when the floor passes and there are no soft axes', () => {
    expect(combineScores([gate(1, true)]).aggregate).toBe(1);
  });
});

describe('evaluateFloor', () => {
  it('is vacuously true with no floor scorers', () => {
    expect(evaluateFloor([judge(0.1)])).toBe(true);
  });
  it('falls back to value>=1 when passed is omitted', () => {
    expect(evaluateFloor([gate(1)])).toBe(true);
    expect(evaluateFloor([gate(0)])).toBe(false);
  });
});

describe('decideGate', () => {
  it('blocks on a failed floor', () => {
    expect(decideGate([gate(0, false), judge(1)]).blocked).toBe(true);
  });

  it('does NOT block on a weak judge by default (judge advisory)', () => {
    const d = decideGate([gate(1, true), judge(0.1)]);
    expect(d.blocked).toBe(false);
  });

  it('blocks on a weak judge once the judge is promoted to blocking', () => {
    const d = decideGate([gate(1, true), judge(0.1)], {
      judgeAdvisory: false,
      judgeThreshold: 0.5,
    });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('judge below threshold');
  });

  it('passes when floor passes and judge is calibrated + above threshold', () => {
    const d = decideGate([gate(1, true), judge(0.9)], { judgeAdvisory: false });
    expect(d.blocked).toBe(false);
  });
});
