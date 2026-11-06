import { describe, expect, it } from 'vitest';
import { mergeChunkVerdicts, reviewChunks } from './reviewChunks.js';

describe('review chunks', () => {
  it('keeps empty and small diffs intact', () => {
    expect(reviewChunks('')).toEqual(['']);
    expect(reviewChunks('small')).toEqual(['small']);
  });
  it('preserves whole files and splits oversized files by hunk without losing content', () => {
    const header = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n';
    const hunks = ['@@ -1 +1 @@\n-old\n+new\n', '@@ -5 +5 @@\n-a\n+b\n'];
    const diff = header + hunks.join('');
    const chunks = reviewChunks(diff, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    for (const hunk of hunks) {
      expect(chunks.some((chunk) => chunk.includes(hunk))).toBe(true);
    }
    expect(reviewChunks(header + 'x'.repeat(200), 60).every((c) => c.length <= 60)).toBe(true);
    expect(reviewChunks(header.repeat(3), 60).join('')).toBe(header.repeat(3));
  });
  it('refuses the hard cap rather than truncating', () => {
    expect(() => reviewChunks('x'.repeat(900_001))).toThrow(/hard cap/);
  });
  it('merges severity worst-of, never approves a rejection, and deduplicates findings', () => {
    const finding = { category: 'bug', description: 'bad', file: 'a', suggestedFix: 'fix' };
    expect(
      mergeChunkVerdicts([
        { approved: false, findings: [finding], reviewer: 'SECURITY', severity: 'CRITICAL' },
        { approved: true, findings: [finding], reviewer: 'SECURITY', severity: 'PASS' },
      ])
    ).toEqual([
      { approved: false, findings: [finding], reviewer: 'SECURITY', severity: 'CRITICAL' },
    ]);
    expect(mergeChunkVerdicts([])).toEqual([]);
  });
});
