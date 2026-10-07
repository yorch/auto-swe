import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMock = vi.fn(async (..._args: unknown[]) => ({}) as CodeResult);
vi.mock('./implementerSession.js', () => ({
  runImplementerFixSession: (...args: unknown[]) => sessionMock(...args),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { CI_FAILURE_TRACE_CHARS, CI_FAILURE_TRACE_EVENT } from '../lib/attemptTrace.js';
import { executeCIFixImplementation, executeReviewFixImplementation } from './ciFixLoop.js';

const previous = {
  branch: 'auto/T-1',
  testResults: { duration_ms: 0, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
} as unknown as CodeResult;

type SessionInput = {
  lessonQuery: string;
  startEvent?: { name: string; outputJson: { logTail: string } };
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

describe('executeCIFixImplementation', () => {
  beforeEach(() => sessionMock.mockClear());

  it('records the end of the failure it was handed, for a lesson about the run', async () => {
    const logs = `${'noise\n'.repeat(2_000)}Error: expected 2 to be 3`;
    await executeCIFixImplementation(logs, previous);
    const event = sessionInput().startEvent;
    expect(event?.name).toBe(CI_FAILURE_TRACE_EVENT);
    expect(event?.outputJson.logTail).toHaveLength(CI_FAILURE_TRACE_CHARS);
    expect(event?.outputJson.logTail.endsWith('Error: expected 2 to be 3')).toBe(true);
  });
});
