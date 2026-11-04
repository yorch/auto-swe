import { describe, expect, it } from 'vitest';
import { respondLabel, summarizeContext } from './contextSummary';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 keep
-old
+new
+newer
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1 +1 @@
-p
+q`;

describe('summarizeContext', () => {
  it('summarises a diff by files and changed lines', () => {
    expect(summarizeContext(DIFF)).toBe('3 files changed (+4 −3): src/a.ts, src/b.ts and 1 more');
  });

  it('shows the first lines of plain context, cut short', () => {
    expect(summarizeContext('Plan:\n\n  step one\nstep two')).toBe('Plan: · step one');
    expect(summarizeContext('x'.repeat(500))?.length).toBe(200);
  });

  it('returns null for empty context', () => {
    expect(summarizeContext('  \n ')).toBeNull();
  });
});

describe('respondLabel', () => {
  it('names the answer each kind takes', () => {
    expect(respondLabel('APPROVAL')).toBe('Review and decide');
    expect(respondLabel('DECISION')).toBe('Choose');
    expect(respondLabel('INPUT')).toBe('Fill in');
    expect(respondLabel('REVIEW')).toBe('Review');
    expect(respondLabel('OTHER')).toBe('Respond');
  });
});
