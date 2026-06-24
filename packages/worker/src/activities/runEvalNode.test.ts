import { describe, expect, it } from 'vitest';
import type { ScoreInput } from '../lib/scorerCombination.js';
import { assembleScores, evalAssert } from './runEvalNode.js';

describe('evalAssert', () => {
  it('evaluates numeric comparisons against a json path', () => {
    expect(evalAssert('$.linesChanged < 500', { linesChanged: 120 })).toBe(true);
    expect(evalAssert('$.linesChanged < 500', { linesChanged: 900 })).toBe(false);
    expect(evalAssert('$.score >= 0.8', { score: 0.8 })).toBe(true);
    expect(evalAssert('$.n == 3', { n: 3 })).toBe(true);
    expect(evalAssert('$.n != 3', { n: 3 })).toBe(false);
  });

  it('supports nested paths and bare truthiness', () => {
    expect(evalAssert('$.a.b > 1', { a: { b: 2 } })).toBe(true);
    expect(evalAssert('$.ok', { ok: true })).toBe(true);
    expect(evalAssert('$.ok', { ok: false })).toBe(false);
  });

  it('is false for a missing field or unparseable expr', () => {
    expect(evalAssert('$.missing < 1', {})).toBe(false);
    expect(evalAssert('garbage', {})).toBe(false);
  });
});

describe('assembleScores', () => {
  const gatePass: ScoreInput = { kind: 'gate', passed: true, scorer: 'gate:t', value: 1 };
  const gateFail: ScoreInput = { kind: 'gate', passed: false, scorer: 'gate:t', value: 0 };
  const judge: ScoreInput = { kind: 'judge', scorer: 'judge:q', value: 0.2 };

  it('gates to 0 and blocks on floor failure', () => {
    const r = assembleScores([gateFail, judge], true);
    expect(r.score).toBe(0);
    expect(r.floorPassed).toBe(false);
    expect(r.decision.blocked).toBe(true);
  });

  it('passes the floor and keeps the judge advisory by default', () => {
    const r = assembleScores([gatePass, judge], true);
    expect(r.floorPassed).toBe(true);
    expect(r.decision.blocked).toBe(false);
    expect(r.perAxis['judge:q']).toBe(0.2);
  });

  it('blocks on a weak judge when not advisory', () => {
    const r = assembleScores([gatePass, judge], false);
    expect(r.decision.blocked).toBe(true);
  });
});
