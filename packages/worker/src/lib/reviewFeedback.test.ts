import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findUnique: db.read } } }));

import { readReviewFeedback } from './reviewFeedback.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const code = () => ({
  baseSha: 'b'.repeat(40),
  diff: 'stored diff',
  diffVerified: true,
  headSha: 'a'.repeat(40),
});
const fixture = () => ({
  reviewOfRun: {
    template: { origin: 'system:agent-run', teamId: null },
    workflowId: 'agent-source',
  },
  reviewOfRunId: SOURCE,
  status: 'SUCCESS',
  steps: [
    { outputs: code(), status: 'PASSED', stepName: 'loadChangeForReview' },
    {
      outputs: {
        approved: false,
        findings: [{ description: 'Stored database finding', severity: 'WARNING' }],
      },
      status: 'PASSED',
      stepName: 'publishReviewResult',
    },
  ],
  template: { kind: 'review' },
  workRequest: {
    payload: {
      connectionId: REPO,
      onBlocking: 'fix',
      reviewOf: { mode: 'stored' },
      sourceRunId: SOURCE,
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  db.read.mockResolvedValue(fixture());
});
describe('stored review feedback', () => {
  it('binds stored findings and exact verified change evidence without a PR', async () => {
    expect(await readReviewFeedback('review', REPO)).toMatchObject({
      origin: 'agent_run',
      sourceRunId: SOURCE,
      storedChange: { baseSha: 'b'.repeat(40), diff: 'stored diff' },
      texts: [expect.stringContaining('Stored database finding')],
    });
    expect(await readReviewFeedback('review', REPO, 7)).toBeNull();
  });
  it.each([{ diffVerified: false }, { baseSha: '' }, { headSha: '' }])(
    'rejects unverified or missing identities',
    async (override) => {
      const run = fixture();
      Object.assign(run.steps[0]?.outputs ?? {}, override);
      db.read.mockResolvedValue(run);
      expect(await readReviewFeedback('review', REPO)).toBeNull();
    }
  );
  it('returns no feedback for absent review evidence and propagates database errors', async () => {
    db.read.mockResolvedValueOnce(null);
    expect(await readReviewFeedback('review', REPO)).toBeNull();
    db.read.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(readReviewFeedback('review', REPO)).rejects.toThrow('database unavailable');
  });
});
