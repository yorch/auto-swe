import { describe, expect, it } from 'vitest';
import { DIFF_WORK_BUDGET, MAX_DIFF_EDITS, unifiedDiff } from './textDiff.js';

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
      lines(400, 'old').join('\n'),
      lines(400, 'new').join('\n'),
      { maxChars: 1_000_000 }
    );
    expect(tooLarge).toBe(false);
    expect(truncated).toBe(false);
    expect(text).toContain('-old399');
    expect(text).toContain('+new399');
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

  it('worst-case input is bounded by work, with a generous wall-clock cap', () => {
    // Long same-length lines, every line different: the quadratic worst case of the old LCS.
    const a = lines(1998, 'aaaaaaaaaaaaaaaaaaaaaaaaa').join('\n');
    const b = lines(1998, 'bbbbbbbbbbbbbbbbbbbbbbbbb').join('\n');
    const budget = { left: DIFF_WORK_BUDGET };
    const t0 = performance.now();
    const result = unifiedDiff(a, b, { budget });
    const ms = performance.now() - t0;
    expect(result.tooLarge).toBe(true);
    // Deterministic bound: the edit cap stops it long before the budget is spent.
    expect(DIFF_WORK_BUDGET - budget.left).toBeLessThanOrEqual(DIFF_WORK_BUDGET);
    // The old code needed ~280 ms per skill and seconds per request; this is far inside
    // two seconds even on a slow CI box.
    expect(ms).toBeLessThan(2000);
  });

  it('a hundred 18 KB skills in one request cost a bounded total', () => {
    const budget = { left: DIFF_WORK_BUDGET };
    const base = lines(900, 'a-fairly-long-line-of-text');
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      unifiedDiff(
        base.join('\n'),
        alternate(base)
          .map((l) => `${l}${i}`)
          .join('\n'),
        { budget }
      );
    }
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(budget.left).toBeLessThan(DIFF_WORK_BUDGET);
  });
});
