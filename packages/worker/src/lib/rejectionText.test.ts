import { describe, expect, it } from 'vitest';
import { rejectionText } from './rejectionText.js';

describe('rejectionText', () => {
  it('passes a review network summary through unchanged', () => {
    expect(rejectionText('[SECURITY/HIGH] missing auth')).toBe('[SECURITY/HIGH] missing auth');
    expect(rejectionText('')).toBe('');
  });

  it("joins a fan-out review's rejecting branches and skips the approving ones", () => {
    // The shape `consensus-review` stores at `context.lastRejectionSummary`.
    const results = [
      { exports: { 'context.branchRejectionSummary': 'approved, ignored' }, status: 'SUCCESS' },
      { exports: { 'context.branchRejectionSummary': 'needs tests' }, status: 'FAILED' },
      { exports: { 'context.branchRejectionSummary': 'unsafe query' }, status: 'FAILED' },
    ];
    expect(rejectionText(results)).toBe('needs tests\n\nunsafe query');
  });

  it('names a reviewer branch that crashed instead of rejecting', () => {
    expect(rejectionText([{ error: 'provider timeout', result: {}, status: 'FAILED' }])).toBe(
      'A reviewer failed: provider timeout'
    );
  });

  it('reads nothing else as text', () => {
    expect(rejectionText(undefined)).toBe('');
    expect(rejectionText(null)).toBe('');
    expect(rejectionText({ rejectionSummary: 'x' })).toBe('');
    expect(rejectionText([{ exports: { a: 3 }, status: 'FAILED' }, 7, null])).toBe('');
  });
});
