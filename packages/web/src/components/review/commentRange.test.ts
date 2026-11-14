import { describe, expect, it } from 'vitest';
import { parseFilePatch } from '@/components/approvals/diffParse';
import { anchorForClick, anchorLabel } from './commentRange';

const PATCH = [
  '@@ -1,4 +1,3 @@',
  ' one',
  '-two',
  '-three',
  ' four',
  '+five',
  '@@ -20,2 +19,3 @@',
  ' twenty',
  '+added',
  ' tail',
].join('\n');
const lines = parseFilePatch(PATCH).lines;

describe('anchorForClick', () => {
  it('makes a single line of a plain click', () => {
    expect(anchorForClick(lines, null, 'RIGHT', 3, false)).toEqual({
      line: 3,
      side: 'RIGHT',
      startLine: null,
    });
  });

  it('ignores Shift with no open editor', () => {
    expect(anchorForClick(lines, null, 'RIGHT', 3, true).startLine).toBeNull();
  });

  it('makes a range, in either direction, within one hunk', () => {
    const open = { line: 3, side: 'RIGHT' as const, startLine: null };
    expect(anchorForClick(lines, open, 'RIGHT', 1, true)).toEqual({
      line: 3,
      side: 'RIGHT',
      startLine: 1,
    });
    expect(
      anchorForClick(lines, { line: 1, side: 'RIGHT', startLine: null }, 'RIGHT', 3, true)
    ).toEqual({ line: 3, side: 'RIGHT', startLine: 1 });
  });

  it('keeps the first line of an open range as the origin', () => {
    const open = { line: 2, side: 'RIGHT' as const, startLine: 1 };
    expect(anchorForClick(lines, open, 'RIGHT', 3, true)).toEqual({
      line: 3,
      side: 'RIGHT',
      startLine: 1,
    });
  });

  it('makes a range of deleted lines by their old numbers', () => {
    const open = { line: 2, side: 'LEFT' as const, startLine: null };
    expect(anchorForClick(lines, open, 'LEFT', 3, true)).toEqual({
      line: 3,
      side: 'LEFT',
      startLine: 2,
    });
  });

  it('does not cross hunks', () => {
    const open = { line: 3, side: 'RIGHT' as const, startLine: null };
    expect(anchorForClick(lines, open, 'RIGHT', 20, true)).toEqual({
      line: 20,
      side: 'RIGHT',
      startLine: null,
    });
  });

  it('does not join two sides or the same line', () => {
    const open = { line: 3, side: 'RIGHT' as const, startLine: null };
    expect(anchorForClick(lines, open, 'LEFT', 2, true).startLine).toBeNull();
    expect(anchorForClick(lines, open, 'RIGHT', 3, true).startLine).toBeNull();
  });

  it('does not make a range to a line the patch lacks', () => {
    const open = { line: 3, side: 'RIGHT' as const, startLine: null };
    expect(anchorForClick(lines, open, 'RIGHT', 99, true).startLine).toBeNull();
  });
});

describe('anchorLabel', () => {
  it('words each anchor', () => {
    expect(anchorLabel({ line: 12, side: 'RIGHT', startLine: null })).toBe('line 12');
    expect(anchorLabel({ line: 14, side: 'RIGHT', startLine: 10 })).toBe('lines 10–14');
    expect(anchorLabel({ line: 8, side: 'LEFT', startLine: null })).toBe('deleted line 8');
    expect(anchorLabel({ line: 10, side: 'LEFT', startLine: 8 })).toBe('deleted lines 8–10');
  });
});
