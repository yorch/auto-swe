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

  const erroredJudge: ScoreInput = {
    error: 'rubric not found',
    kind: 'judge',
    scorer: 'judge:quality',
    value: 0.5,
  };

  it('fails closed on a blocking judge that could not score, whatever the threshold', () => {
    // The placeholder 0.5 would clear a 0.5 threshold; the error must block anyway.
    const d = decideGate([gate(1, true), erroredJudge], {
      judgeAdvisory: false,
      judgeThreshold: 0.5,
    });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('judge could not score');
    expect(d.reason).toContain('rubric not found');
  });

  it('keeps an advisory judge that could not score advisory', () => {
    expect(decideGate([gate(1, true), erroredJudge]).blocked).toBe(false);
    expect(decideGate([gate(1, true), erroredJudge], { judgeAdvisory: true }).blocked).toBe(false);
  });

  it('says the judge cleared its threshold when a blocking judge passes', () => {
    const d = decideGate([gate(1, true), judge(0.9)], {
      judgeAdvisory: false,
      judgeThreshold: 0.6,
    });
    expect(d.reason).toBe('floor passed; judge at or above threshold 0.6');
    // With no judge to promote, the soft axes are still only advisory.
    expect(decideGate([gate(1, true)], { judgeAdvisory: false }).reason).toBe(
      'floor passed; soft axes advisory'
    );
  });

  it('leaves an errored scorer out of the aggregate and perAxis, and lists it', () => {
    const c = combineScores([gate(1, true), trajectory(0.8), erroredJudge]);
    // The mean is over the trajectory alone, not dragged toward the 0.5 placeholder.
    expect(c.aggregate).toBeCloseTo(0.8);
    expect(c.perAxis).toEqual({ 'gate:runTests': 1, 'trajectory:steps': 0.8 });
    expect(c.errors).toEqual({ 'judge:quality': 'rubric not found' });
  });

  it('aggregates to 1 when the only soft scorer errored, as with no soft axes', () => {
    expect(combineScores([gate(1, true), erroredJudge]).aggregate).toBe(1);
    expect(combineScores([gate(1, true), judge(0.4)]).errors).toEqual({});
  });

  it('reports a failed floor ahead of an errored blocking judge', () => {
    const d = decideGate([gate(0, false), erroredJudge], { judgeAdvisory: false });
    expect(d.reason).toContain('floor failed');
  });
});
