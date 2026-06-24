import { describe, expect, it } from 'vitest';
import { assertNoRubricLeak, buildJudgePrompt, findRubricLeak } from './judgePrompt.js';

describe('buildJudgePrompt', () => {
  it('builds a pairwise prompt when a baseline is present (the default)', () => {
    const p = buildJudgePrompt({ baseline: 'old diff', candidate: 'new diff', rubric: 'be good' });
    expect(p.pairwise).toBe(true);
    expect(p.system).toContain('Compare CANDIDATE against BASELINE');
    expect(p.system).toContain('be good');
    expect(p.user).toContain('BASELINE:');
    expect(p.user).toContain('CANDIDATE:');
  });

  it('builds a pointwise prompt (advisory) when there is no baseline', () => {
    const p = buildJudgePrompt({ candidate: 'new diff', rubric: 'be good' });
    expect(p.pairwise).toBe(false);
    expect(p.system).toContain('advisory');
    expect(p.user).not.toContain('BASELINE:');
  });
});

describe('findRubricLeak (the implementer/rubric wall)', () => {
  const rubric =
    'Grade the diff on: minimal scope, correctness of intent, and readability for a senior engineer.';
  const references = ['the golden patch adds a null check before dereferencing user.session.token'];

  it('passes clean implementer context', () => {
    const ctx = 'Implement the feature described in ticket JIRA-1. Write tests first.';
    expect(findRubricLeak(ctx, { references, rubric })).toEqual([]);
  });

  it('detects leaked rubric text', () => {
    const ctx = `Do the work. Grade the diff on: minimal scope, correctness of intent, and readability for a senior engineer.`;
    const v = findRubricLeak(ctx, { rubric });
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].kind).toBe('rubric');
  });

  it('detects a leaked golden reference', () => {
    const ctx = `Hint: the golden patch adds a null check before dereferencing user.session.token`;
    const v = findRubricLeak(ctx, { references });
    expect(v.some((x) => x.kind === 'reference')).toBe(true);
  });

  it('does not false-positive on short incidental token overlap', () => {
    const ctx = 'function getToken() { return user.token; } // minimal change';
    expect(findRubricLeak(ctx, { references, rubric })).toEqual([]);
  });

  it('assertNoRubricLeak throws on a breach', () => {
    expect(() => assertNoRubricLeak('… readability for a senior engineer …', { rubric })).toThrow(
      /wall breached/
    );
  });
});
