import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMock = vi.fn(async (..._args: unknown[]) => ({}) as CodeResult);
vi.mock('./implementerSession.js', () => ({
  runImplementerFixSession: (...args: unknown[]) => sessionMock(...args),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { executeReviewFixImplementation } from './ciFixLoop.js';

const previous = {
  branch: 'auto/T-1',
  testResults: { duration_ms: 0, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
} as unknown as CodeResult;

type SessionInput = {
  lessonQuery: string;
  notes: (t: { passed: boolean }) => string;
  userPayload: { reviewFindings: unknown };
};
const sessionInput = () => sessionMock.mock.calls[0]?.[0] as SessionInput;

describe('executeReviewFixImplementation', () => {
  beforeEach(() => sessionMock.mockClear());

  it("hands a consensus review's per-branch results to the fixer as text", async () => {
    // `consensus-review` binds the fix's rejection to the fan-out's results array.
    await executeReviewFixImplementation(
      [
        { status: 'SUCCESS' },
        { exports: { 'context.branchRejectionSummary': 'needs tests' }, status: 'FAILED' },
      ],
      previous
    );
    const input = sessionInput();
    expect(input.userPayload.reviewFindings).toBe('needs tests');
    expect(input.lessonQuery).toBe('needs tests');
    // Building the notes threw on the array, after the fix had already been pushed.
    expect(input.notes({ passed: true })).toContain('1 findings addressed');
  });

  it('passes a review network summary through unchanged', async () => {
    await executeReviewFixImplementation('a\nb', previous);
    expect(sessionInput().userPayload.reviewFindings).toBe('a\nb');
  });
});
