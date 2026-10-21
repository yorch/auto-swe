import { describe, expect, it } from 'vitest';
import { DIFF_WORK_BUDGET, DIFF_WORK_PER_SKILL, MAX_DIFF_EDITS, unifiedDiff } from './textDiff.js';

const lines = (n: number, p = 'l') => Array.from({ length: n }, (_, i) => `${p}${i}`);
const alternate = (l: string[]) => l.map((x, i) => (i % 2 ? `${x}!` : x));

describe('unifiedDiff', () => {
  it('is empty for equal text', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toEqual({ text: '', tooLarge: false, truncated: false });
  });

  it('shows one changed line with context', () => {
    const old = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const next = ['1', '2', '3', 'four', '5', '6', '7', '8'].join('\n');
    expect(unifiedDiff(old, next, { context: 1 }).text).toBe(
      ['@@ -3,3 +3,3 @@', ' 3', '-4', '+four', ' 5'].join('\n')
    );
  });

  it('shows additions and removals, and splits distant changes into hunks', () => {
    const l = lines(30);
    const next = [...l];
    next[2] = 'changed';
    next.splice(27, 1);
    const { text } = unifiedDiff(l.join('\n'), next.join('\n'), { context: 2 });
    expect(text.match(/^@@/gm)).toHaveLength(2);
    expect(text).toContain('-l2\n+changed');
    expect(text).toContain('-l27');
  });

  it('handles a trailing-newline difference and an empty side', () => {
    expect(unifiedDiff('a', 'a\n').text).toContain('+');
    expect(unifiedDiff('', 'x').text).toContain('+x');
  });

  it('interleaves removed and added lines in file order', () => {
    const x = lines(300);
    const { text } = unifiedDiff(x.join('\n'), alternate(x).join('\n'), {
      context: 0,
      maxChars: 1_000_000,
    });
    const marks = text.split('\n').filter((l) => l[0] === '-' || l[0] === '+');
    expect(marks.slice(0, 4)).toEqual(['-l1', '+l1!', '-l3', '+l3!']);
    // Applying the diff's + and context lines reproduces the new text.
    expect(marks.filter((l) => l[0] === '+')).toHaveLength(150);
  });

  it('reconstructs both sides exactly for random edits', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(25) }, () => `w${rnd(6)}`);
      const b = Array.from({ length: rnd(25) }, () => `w${rnd(6)}`);
      const { text } = unifiedDiff(a.join('\n'), b.join('\n'), { context: 1000 });
      if (a.join('\n') === b.join('\n')) {
        continue;
      }
      const body = text.split('\n').filter((l) => !l.startsWith('@@'));
      const left = body.filter((l) => l[0] !== '+').map((l) => l.slice(1));
      const right = body.filter((l) => l[0] !== '-').map((l) => l.slice(1));
      expect(left).toEqual(a.join('\n').split('\n'));
      expect(right).toEqual(b.join('\n').split('\n'));
    }
  });

  it('a rewrite within the cap is a complete diff showing both sides', () => {
    const { text, tooLarge, truncated } = unifiedDiff(
      lines(250, 'old').join('\n'),
      lines(250, 'new').join('\n'),
      { maxChars: 1_000_000 }
    );
    expect(tooLarge).toBe(false);
    expect(truncated).toBe(false);
    expect(text).toContain('-old249');
    expect(text).toContain('+new249');
  });

  it('truncation keeps the head of the diff and says so', () => {
    const a = lines(500);
    const result = unifiedDiff(a.join('\n'), alternate(a).join('\n'), {
      context: 0,
      maxChars: 500,
    });
    expect(result.truncated).toBe(true);
    expect(result.tooLarge).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.text.startsWith('@@')).toBe(true);
  });

  it('reports a rewrite beyond the edit cap as too large rather than a misleading partial diff', () => {
    const a = lines(MAX_DIFF_EDITS, 'old').join('\n');
    const b = lines(MAX_DIFF_EDITS, 'new').join('\n');
    expect(unifiedDiff(a, b)).toEqual({ text: '', tooLarge: true, truncated: false });
  });

  it('the work budget is shared: later diffs in a request fail once it is spent', () => {
    const budget = { left: 5_000 };
    const a = lines(400);
    expect(unifiedDiff(a.join('\n'), alternate(a).join('\n'), { budget }).tooLarge).toBe(true);
    expect(budget.left).toBeLessThan(0);
    expect(unifiedDiff('x\ny', 'x\nz', { budget }).tooLarge).toBe(true);
  });

  it('worst-case input is bounded by counted work, not by the clock', () => {
    // Long same-length lines, every line different: the quadratic worst case of the old LCS.
    const a = lines(1998, 'aaaaaaaaaaaaaaaaaaaaaaaaa').join('\n');
    const b = lines(1998, 'bbbbbbbbbbbbbbbbbbbbbbbbb').join('\n');
    const budget = { left: DIFF_WORK_BUDGET };
    const result = unifiedDiff(a, b, { budget });
    expect(result.tooLarge).toBe(true);
    // The edit cap stops the search within one skill's share of the request's work. The
    // work count is the bound this module guarantees; a wall-clock assertion on it only
    // measured how busy the machine was.
    expect(DIFF_WORK_BUDGET - budget.left).toBeLessThanOrEqual(DIFF_WORK_PER_SKILL);
  });

  it('a hundred 18 KB skills in one request cost a bounded total', () => {
    const budget = { left: DIFF_WORK_BUDGET };
    const base = lines(400, 'a-fairly-long-line-of-text');
    for (let i = 0; i < 100; i++) {
      unifiedDiff(
        base.join('\n'),
        alternate(base)
          .map((l) => `${l}${i}`)
          .join('\n'),
        { budget }
      );
    }
    // Counted work, not wall time: all hundred fit inside the request budget.
    expect(budget.left).toBeGreaterThanOrEqual(0);
    expect(budget.left).toBeLessThan(DIFF_WORK_BUDGET);
  });
});

describe('per-skill budget', () => {
  it('a skill diff is complete or not by its own texts alone, whatever was diffed before it', () => {
    const a = lines(500, 'a-fairly-long-line-of-text');
    const b = alternate(a);
    const alone = unifiedDiff(a.join('\n'), b.join('\n'));
    // Built once: rebuilding two 12000-line texts per round made the fixtures, not the diffs,
    // the cost of this test (about 1.4 s alone, several times that on a loaded runner).
    const bigOld = lines(12000, 'p').join('\n');
    const bigNew = alternate(lines(12000, 'q')).join('\n');
    // Each rewrite spends about 180,000 of work, so this many rounds spend more than the whole
    // request budget: if calls without a `budget` shared one pool, it would be empty by now and
    // the last diff below would come back `tooLarge`.
    const rounds = Math.ceil(DIFF_WORK_BUDGET / 180_000) + 1;
    for (let i = 0; i < rounds; i++) {
      unifiedDiff(bigOld, bigNew);
    }
    expect(unifiedDiff(a.join('\n'), b.join('\n'))).toEqual(alone);
    expect(alone.tooLarge).toBe(false);
  });

  it('a request of 100 skills cannot exceed the 20M total', () => {
    expect(DIFF_WORK_PER_SKILL * 100).toBeLessThanOrEqual(DIFF_WORK_BUDGET);
  });
});
