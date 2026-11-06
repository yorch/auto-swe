import { selectReviewFindings } from '@auto-swe/shared/lib/prEvaluation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLinkedReviewOutputs, loadReviewedOutputsSafe } from './briefEvidence.js';

const mocks = vi.hoisted(() => ({ runs: vi.fn(), steps: vi.fn(), warn: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowRun: { findMany: mocks.runs }, workflowStep: { findMany: mocks.steps } },
}));
vi.mock('./activityLog.js', () => ({ logWarn: mocks.warn }));
const HEAD = 'a'.repeat(40);
const input = { connectionId: 'repo', headSha: HEAD, prNumber: 1, temporalWorkflowId: 'source-wf' };
const finding = { category: 'Security', description: 'Unsafe input', file: 'src/a.ts', line: 1 };
function linked(mode = 'pr', head = HEAD, diffVerified = true) {
  return {
    id: 'review',
    steps: [
      {
        outputs: { approved: false, findings: [finding], worstSeverity: 'CRITICAL' },
        stepName: 'publishReviewResult',
      },
      {
        outputs: {
          diffVerified,
          headSha: head,
          testResults: { failing: 0, passing: 100, total: 100 },
        },
        stepName: 'loadChangeForReview',
      },
      {
        outputs: {
          codeResult: { diffVerified, headSha: head },
          verdicts: [{ findings: [finding], severity: 'WARNING' }],
        },
        stepName: 'runReviewNetwork',
      },
    ],
    workRequest: { payload: { reviewOf: { mode } } },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs.mockResolvedValue([]);
  mocks.steps.mockResolvedValue([]);
});

describe('linked review evidence', () => {
  it('limits reads to successful source-linked runs', async () => {
    mocks.runs.mockResolvedValue([linked('branch', HEAD.toUpperCase())]);
    const result = await loadLinkedReviewOutputs('source-wf', HEAD);
    expect(result[0]?.verdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewRunId: 'review', severity: 'CRITICAL' }),
      ])
    );
    expect(mocks.runs).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        where: { reviewOfRun: { workflowId: 'source-wf' }, status: 'SUCCESS' },
      })
    );
  });
  it('reads every page so old blocking reviews cannot disappear behind newer clean reviews', async () => {
    const clean = {
      ...linked(),
      steps: [
        {
          outputs: {
            codeResult: { headSha: HEAD },
            verdicts: [{ findings: [], severity: 'PASS' }],
          },
          stepName: 'runReviewNetwork',
        },
      ],
    };
    mocks.runs
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, n) => ({ ...clean, id: `review-${n}` }))
      )
      .mockResolvedValueOnce([linked()]);
    const results = await loadLinkedReviewOutputs('source-wf', HEAD);
    expect(results).toHaveLength(51);
    expect(results.at(-1)?.verdicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'CRITICAL' })])
    );
    expect(mocks.runs.mock.calls[1]?.[0]).toMatchObject({ cursor: { id: 'review-49' }, skip: 1 });
  });
  it.each([
    ['stored', HEAD, true],
    ['pr', 'b'.repeat(40), true],
    ['branch', HEAD, false],
    ['unknown', HEAD, true],
  ] as const)('ignores mode %s with head %s and verification %s', async (mode, head, verified) => {
    mocks.runs.mockResolvedValue([linked(mode, head, verified)]);
    expect(await loadLinkedReviewOutputs('source-wf', HEAD)).toEqual([]);
  });
  it('binds human summaries to the loaded head, without needing a review network step', async () => {
    const run = linked();
    run.steps = run.steps.filter((step) => step.stepName !== 'runReviewNetwork');
    mocks.runs.mockResolvedValue([run]);
    expect((await loadLinkedReviewOutputs('source-wf', HEAD))[0]?.verdicts[0]?.severity).toBe(
      'CRITICAL'
    );
  });
  it('deduplicates findings worst-first and does not promote linked tests to source evidence', async () => {
    mocks.steps.mockResolvedValue([
      {
        outputs: {
          codeResult: { headSha: HEAD },
          verdicts: [{ findings: [finding], severity: 'WARNING' }],
        },
      },
    ]);
    mocks.runs.mockResolvedValue([linked()]);
    const outputs = await loadReviewedOutputsSafe(input);
    const findings = selectReviewFindings(
      outputs?.verdicts,
      [
        {
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n+x',
          path: 'src/a.ts',
          status: 'modified',
        },
      ],
      null
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      description: '[Review run review] Unsafe input',
      severity: 'CRITICAL',
    });
    expect(outputs?.codeResult).toEqual({ headSha: HEAD });
  });
  it('bounds merged brief findings using the existing selector', async () => {
    const many = Array.from({ length: 100 }, (_, n) => ({ ...finding, category: `category-${n}` }));
    const outputs = await loadReviewedOutputsSafe({
      ...input,
      linkedReviews: [{ runId: 'review', verdicts: [{ findings: many, severity: 'WARNING' }] }],
    });
    expect(
      selectReviewFindings(
        outputs?.verdicts,
        [
          {
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@\n+x',
            path: 'src/a.ts',
            status: 'modified',
          },
        ],
        null
      )
    ).toHaveLength(50);
  });
  it('keeps empty evidence null and degrades brief-only lookup failures to unknown', async () => {
    expect(await loadReviewedOutputsSafe(input)).toBeNull();
    mocks.steps.mockRejectedValueOnce(new Error('source unavailable'));
    mocks.runs.mockRejectedValueOnce(new Error('linked unavailable'));
    expect(await loadReviewedOutputsSafe(input)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });
});
