import { describe, expect, it } from 'vitest';
import { isUnifiedDiff, parseUnifiedDiff } from './diffParse';

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ fn
 keep
-old
+new
+extra
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +5,2 @@
 same
-gone
+here
`;

describe('parseUnifiedDiff', () => {
  it('groups lines per file with +/- counts', () => {
    const files = parseUnifiedDiff(TWO_FILES);
    expect(files.map((f) => f.name)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0]).toMatchObject({ added: 2, removed: 1 });
    expect(files[1]).toMatchObject({ added: 1, removed: 1 });
  });

  it('numbers old and new lines from the hunk header', () => {
    const [a, b] = parseUnifiedDiff(TWO_FILES);
    const body = a.lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk');
    expect(body.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
    ]);
    const bBody = b.lines.filter((l) => l.kind === 'ctx' || l.kind === 'add' || l.kind === 'del');
    expect(bBody.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 5],
      [2, null],
      [null, 6],
    ]);
  });

  it('does not treat --- / +++ headers as removed or added lines', () => {
    const [a] = parseUnifiedDiff(TWO_FILES);
    expect(a.removed).toBe(1);
  });

  it('detects diffs', () => {
    expect(isUnifiedDiff(TWO_FILES)).toBe(true);
    expect(isUnifiedDiff('just a plan')).toBe(false);
  });
});

describe('parseUnifiedDiff without per-file diff headers', () => {
  const PLAIN = `--- a/one.txt\t2026-01-01
+++ b/one.txt\t2026-01-02
@@ -1,2 +1,2 @@
 keep
-old
+new
--- a/two.txt\t2026-01-01
+++ b/two.txt\t2026-01-02
@@ -1 +1,2 @@
 head
+tail
`;

  it('ends a hunk when its header counts are used up and starts the next file', () => {
    const files = parseUnifiedDiff(PLAIN);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ added: 1, name: 'one.txt', removed: 1 });
    expect(files[1]).toMatchObject({ added: 1, removed: 0 });
  });

  it('does not count a following file header as a removed line', () => {
    const [first] = parseUnifiedDiff(PLAIN);
    expect(first.lines.some((l) => l.text.startsWith('--- a/two'))).toBe(false);
  });
});
