import { describe, expect, it } from 'vitest';
import { anchorInDiff } from './diffAnchor.js';

// Old lines: 1 a, 2 b (deleted), 3 c, 4 d.  New lines: 1 a, 2 B (added), 3 c, 4 d.
const ONE_HUNK = ['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' c', ' d'].join('\n');
const TWO_HUNKS = [
  '@@ -1,2 +1,2 @@',
  ' a',
  '-b',
  '+B',
  '@@ -20,3 +20,3 @@',
  ' x',
  '-y',
  '+Y',
  ' z',
  '\\ No newline at end of file',
].join('\n');

describe('anchorInDiff', () => {
  it('anchors RIGHT on added and context rows only', () => {
    expect(anchorInDiff(ONE_HUNK, { line: 2, side: 'RIGHT' })).toBe(true);
    expect(anchorInDiff(ONE_HUNK, { line: 1, side: 'RIGHT' })).toBe(true);
    expect(anchorInDiff(ONE_HUNK, { line: 5, side: 'RIGHT' })).toBe(false);
  });

  it('anchors LEFT on a deleted line and refuses an added one', () => {
    expect(anchorInDiff(ONE_HUNK, { line: 2, side: 'LEFT' })).toBe(true);
    const added = ['@@ -1,1 +1,2 @@', ' a', '+new'].join('\n');
    expect(anchorInDiff(added, { line: 2, side: 'LEFT' })).toBe(false);
    expect(anchorInDiff(added, { line: 2, side: 'RIGHT' })).toBe(true);
  });

  it('numbers a context row by each side', () => {
    const patch = ['@@ -5,3 +7,3 @@', ' a', ' b', ' c'].join('\n');
    expect(anchorInDiff(patch, { line: 6, side: 'LEFT' })).toBe(true);
    expect(anchorInDiff(patch, { line: 6, side: 'RIGHT' })).toBe(false);
    expect(anchorInDiff(patch, { line: 8, side: 'RIGHT' })).toBe(true);
    expect(anchorInDiff(patch, { line: 8, side: 'LEFT' })).toBe(false);
  });

  it('accepts a range inside one hunk, including across a change', () => {
    expect(anchorInDiff(ONE_HUNK, { line: 4, side: 'RIGHT', startLine: 1 })).toBe(true);
    expect(anchorInDiff(ONE_HUNK, { line: 4, side: 'LEFT', startLine: 2 })).toBe(true);
  });

  it('refuses a range across hunks', () => {
    expect(anchorInDiff(TWO_HUNKS, { line: 20, side: 'RIGHT', startLine: 1 })).toBe(false);
    expect(anchorInDiff(TWO_HUNKS, { line: 21, side: 'LEFT', startLine: 1 })).toBe(false);
    expect(anchorInDiff(TWO_HUNKS, { line: 22, side: 'RIGHT', startLine: 20 })).toBe(true);
  });

  it('refuses a range whose endpoint is not on the side', () => {
    // new line 2 is added, so it is not a LEFT row where old line 2 is
    const patch = ['@@ -1,2 +1,3 @@', ' a', '+x', '+y', ' b'].join('\n');
    expect(anchorInDiff(patch, { line: 2, side: 'LEFT', startLine: 1 })).toBe(true);
    expect(anchorInDiff(patch, { line: 3, side: 'LEFT', startLine: 1 })).toBe(false);
    expect(anchorInDiff(ONE_HUNK, { line: 9, side: 'RIGHT', startLine: 2 })).toBe(false);
    expect(anchorInDiff(ONE_HUNK, { line: 4, side: 'RIGHT', startLine: 0 })).toBe(false);
  });

  it('refuses startLine at or after line', () => {
    expect(anchorInDiff(ONE_HUNK, { line: 3, side: 'RIGHT', startLine: 3 })).toBe(false);
    expect(anchorInDiff(ONE_HUNK, { line: 3, side: 'RIGHT', startLine: 4 })).toBe(false);
  });

  it('treats a null startLine as a single line', () => {
    expect(anchorInDiff(ONE_HUNK, { line: 3, side: 'RIGHT', startLine: null })).toBe(true);
  });

  it('does not count a no-newline marker as a line', () => {
    expect(anchorInDiff(TWO_HUNKS, { line: 23, side: 'RIGHT' })).toBe(false);
    expect(anchorInDiff(TWO_HUNKS, { line: 22, side: 'RIGHT' })).toBe(true);
  });

  it('refuses a missing patch and unusable numbers', () => {
    expect(anchorInDiff(undefined, { line: 1, side: 'RIGHT' })).toBe(false);
    expect(anchorInDiff('', { line: 1, side: 'RIGHT' })).toBe(false);
    for (const line of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 2 ** 60]) {
      expect(anchorInDiff(ONE_HUNK, { line, side: 'RIGHT' })).toBe(false);
    }
    expect(anchorInDiff(ONE_HUNK, { line: 3, side: 'RIGHT', startLine: Number.NaN })).toBe(false);
  });
});
