import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './textDiff.js';

describe('unifiedDiff', () => {
  it('is empty for equal text', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('');
  });

  it('shows one changed line with context', () => {
    const old = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const next = ['1', '2', '3', 'four', '5', '6', '7', '8'].join('\n');
    expect(unifiedDiff(old, next, 1)).toBe(
      ['@@ -3,3 +3,3 @@', ' 3', '-4', '+four', ' 5'].join('\n')
    );
  });

  it('shows additions and removals, and splits distant changes into hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const next = [...lines];
    next[2] = 'changed';
    next.splice(27, 1);
    const diff = unifiedDiff(lines.join('\n'), next.join('\n'), 2);
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain('-l2\n+changed');
    expect(diff).toContain('-l27');
  });

  it('handles a trailing-newline difference and an empty side', () => {
    expect(unifiedDiff('a', 'a\n')).toContain('+');
    expect(unifiedDiff('', 'x')).toContain('+x');
  });

  it('falls back to a whole replacement past the size cap, still a valid diff', () => {
    const big = (p: string) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join('\n');
    const diff = unifiedDiff(`start\n${big('a')}\nend`, `start\n${big('b')}\nend`, 1);
    expect(diff).toContain('-a0');
    expect(diff).toContain('+b2499');
    expect(diff.startsWith('@@ -1,')).toBe(true);
  });
});
