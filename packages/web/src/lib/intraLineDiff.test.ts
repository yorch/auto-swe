import { describe, expect, it } from 'vitest';
import { intraLineDiff, MAX_INTRA_LINE_CHARS, type Segment } from './intraLineDiff';
import { commonSubsequence } from './sequenceDiff';

const joined = (segments: Segment[]) => segments.map((s) => s.text).join('');
const changedText = (segments: Segment[]) =>
  segments
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join('|');

describe('commonSubsequence', () => {
  it('matches what two sequences share, in order', () => {
    expect(commonSubsequence(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  it('matches nothing when nothing is shared, and nothing for empty input', () => {
    expect(commonSubsequence(['a'], ['b'])).toEqual([]);
    expect(commonSubsequence([], ['b'])).toEqual([]);
    expect(commonSubsequence(['a'], [])).toEqual([]);
  });

  it('finds the longest run, not the first match', () => {
    expect(commonSubsequence(['x', 'a', 'b', 'c'], ['a', 'b', 'c', 'x']).length).toBe(3);
  });
});

describe('intraLineDiff', () => {
  it('marks only the word that changed', () => {
    const diff = intraLineDiff('const total = price * count;', 'const total = price * quantity;');
    expect(diff).not.toBeNull();
    expect(changedText(diff?.removed ?? [])).toBe('count');
    expect(changedText(diff?.added ?? [])).toBe('quantity');
  });

  it('always joins back into the line it was given', () => {
    const removed = 'if (a.b(c)) { return `x` + $y + "q\\t"; }';
    const added = 'if (a.b(d)) { return `x` + $z + "q\\t"; }';
    const diff = intraLineDiff(removed, added);
    expect(joined(diff?.removed ?? [])).toBe(removed);
    expect(joined(diff?.added ?? [])).toBe(added);
  });

  it('marks an inserted word on the added side only', () => {
    const diff = intraLineDiff('return value;', 'return await value;');
    expect(changedText(diff?.removed ?? [])).toBe('');
    expect(changedText(diff?.added ?? [])).toBe('await ');
  });

  it('marks a change in whitespace', () => {
    const diff = intraLineDiff('foo(a, b)', 'foo(a,  b)');
    expect(changedText(diff?.added ?? [])).toContain(' ');
  });

  it('merges neighbouring changed tokens into one stretch', () => {
    const diff = intraLineDiff('call(alpha, beta);', 'call(gamma, delta);');
    const changed = (diff?.added ?? []).filter((s) => s.changed).map((s) => s.text);
    expect(changed).toEqual(['gamma', 'delta']);
  });

  it('keeps accented and non-Latin words whole, so a code point is never split', () => {
    const diff = intraLineDiff('const café = 1;', 'const crème = 1;');
    expect(changedText(diff?.removed ?? [])).toBe('café');
    expect(changedText(diff?.added ?? [])).toBe('crème');
    const astral = intraLineDiff('say("😀 hi")', 'say("😀 yo")');
    expect(joined(astral?.added ?? [])).toBe('say("😀 yo")');
  });

  it.each([
    ['identical lines', 'same line', 'same line'],
    ['a rewrite with little in common', 'return a;', 'throw new Error("nope");'],
    ['two empty lines', '', ''],
  ])('says there is nothing useful to mark for %s', (_name, before, after) => {
    expect(intraLineDiff(before, after)).toBeNull();
  });

  it('does not compare lines longer than the limit', () => {
    const long = `${'word '.repeat(MAX_INTRA_LINE_CHARS)}x`;
    expect(intraLineDiff(long, `${long}y`)).toBeNull();
    expect(intraLineDiff('short line here', long)).toBeNull();
  });

  it('does not build a table for a pair too large to compare', () => {
    const tokens = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${i % 7}`).join(' ');
    // About 200 tokens a side is 40,000 pairs: over the limit, though under the character limit.
    const a = tokens(110, 'a');
    const b = tokens(110, 'a').replace('a1', 'z1');
    expect(a.length).toBeLessThan(MAX_INTRA_LINE_CHARS);
    expect(intraLineDiff(a, b)).toBeNull();
  });
});
