import { describe, expect, it } from 'vitest';
import {
  autoEvidenceAssessment,
  type PrEvaluationEvidence,
  type PrEvaluationEvidenceDb,
  prEvaluationEvidence,
} from './prEvaluationEvidence.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const MIN_LINES = 10;

type Row = {
  badMerge: boolean;
  changedLines: number | null;
  connectionId: string;
  mergedAt: Date | null;
  requesterId: string | null;
  riskClass: string;
  trustedApprovers: number | null;
};

const good = (over: Partial<Row> = {}): Row => ({
  badMerge: false,
  changedLines: 30,
  connectionId: 'repo-a',
  mergedAt: new Date(NOW.getTime() - 5 * DAY),
  requesterId: 'u1',
  riskClass: 'LOW',
  trustedApprovers: 1,
  ...over,
});

type Where = {
  badMerge?: boolean;
  changedLines?: { gte: number };
  connectionId?: string;
  mergedAt?: { gte: Date };
  requesterId?: { not: null };
  riskClass?: string;
  trustedApprovers?: { gte: number };
};

function matches(row: Row, where: Where): boolean {
  const checks = [
    where.riskClass === undefined || row.riskClass === where.riskClass,
    where.connectionId === undefined || row.connectionId === where.connectionId,
    where.badMerge === undefined || row.badMerge === where.badMerge,
    !where.mergedAt || (row.mergedAt !== null && row.mergedAt >= where.mergedAt.gte),
    !where.requesterId || row.requesterId !== null,
    !where.changedLines ||
      (row.changedLines !== null && row.changedLines >= where.changedLines.gte),
    !where.trustedApprovers ||
      (row.trustedApprovers !== null && row.trustedApprovers >= where.trustedApprovers.gte),
  ];
  return checks.every(Boolean);
}

/** A stand-in that applies the where clause the way the database would. */
function fakeDb(rows: Row[]): PrEvaluationEvidenceDb {
  return {
    prEvaluation: {
      count: async ({ where }) => rows.filter((r) => matches(r, where)).length,
      groupBy: async ({ where }) => {
        const seen = new Set<string>();
        for (const r of rows.filter((x) => matches(x, where))) {
          if (r.requesterId) {
            seen.add(r.requesterId);
          }
        }
        return [...seen].map((requesterId) => ({ requesterId }));
      },
    },
  };
}

const evidenceOf = (rows: Row[], connectionId = 'repo-a', minLines = MIN_LINES) =>
  prEvaluationEvidence(fakeDb(rows), connectionId, NOW, minLines);

describe('prEvaluationEvidence', () => {
  it('is all zero on an empty database', async () => {
    expect(await evidenceOf([])).toEqual({
      deployment: { badMerges: 0, distinctRequesters: 0, lowMerged: 0 },
      repository: { badMerges: 0, lowMerged: 0 },
      windowDays: 90,
    });
  });

  it('counts a qualifying row in both scopes', async () => {
    const e = await evidenceOf([good()]);
    expect(e.deployment).toEqual({ badMerges: 0, distinctRequesters: 1, lowMerged: 1 });
    expect(e.repository).toEqual({ badMerges: 0, lowMerged: 1 });
  });

  it.each([
    ['not LOW', { riskClass: 'STANDARD' }],
    ['merged outside the window', { mergedAt: new Date(NOW.getTime() - 91 * DAY) }],
    ['never merged', { mergedAt: null }],
    ['no requester', { requesterId: null }],
    ['too few lines', { changedLines: MIN_LINES - 1 }],
    ['unknown lines', { changedLines: null }],
    ['no trusted approver', { trustedApprovers: 0 }],
    ['unknown approvers', { trustedApprovers: null }],
  ])('does not count a row that is %s', async (_name, over) => {
    const e = await evidenceOf([good(over as Partial<Row>)]);
    expect(e.deployment.lowMerged).toBe(0);
    expect(e.repository.lowMerged).toBe(0);
    expect(e.deployment.distinctRequesters).toBe(0);
  });

  it('counts a row at exactly the line minimum', async () => {
    expect((await evidenceOf([good({ changedLines: MIN_LINES })])).deployment.lowMerged).toBe(1);
  });

  it('reports a bad merge, and a bad merge is not counted as a qualifying merge', async () => {
    const e = await evidenceOf([good(), good({ badMerge: true })]);
    expect(e.deployment).toEqual({ badMerges: 1, distinctRequesters: 1, lowMerged: 1 });
    expect(e.repository).toEqual({ badMerges: 1, lowMerged: 1 });
  });

  it('separates the repository from the deployment', async () => {
    const e = await evidenceOf([
      good({ connectionId: 'repo-a', requesterId: 'u1' }),
      good({ connectionId: 'repo-b', requesterId: 'u2' }),
      good({ badMerge: true, connectionId: 'repo-b', requesterId: 'u3' }),
    ]);
    expect(e.deployment).toEqual({ badMerges: 1, distinctRequesters: 2, lowMerged: 2 });
    expect(e.repository).toEqual({ badMerges: 0, lowMerged: 1 });
  });

  it('counts distinct requesters once each', async () => {
    const e = await evidenceOf([
      good({ requesterId: 'u1' }),
      good({ requesterId: 'u1' }),
      good({ requesterId: 'u2' }),
    ]);
    expect(e.deployment.distinctRequesters).toBe(2);
    expect(e.deployment.lowMerged).toBe(3);
  });
});

describe('autoEvidenceAssessment', () => {
  const evidence: PrEvaluationEvidence = {
    deployment: { badMerges: 0, distinctRequesters: 3, lowMerged: 150 },
    repository: { badMerges: 0, lowMerged: 20 },
    windowDays: 90,
  };
  const thresholds = { minDistinctRequesters: 3, minEvidence: 150, minRepoEvidence: 20 };
  const withDeployment = (
    deployment: Partial<PrEvaluationEvidence['deployment']>
  ): PrEvaluationEvidence => ({
    ...evidence,
    deployment: { ...evidence.deployment, ...deployment },
  });
  const withRepo = (repository: Partial<PrEvaluationEvidence['repository']>) => ({
    ...evidence,
    repository: { ...evidence.repository, ...repository },
  });

  it('is satisfied at exactly the thresholds', () => {
    expect(autoEvidenceAssessment(evidence, thresholds)).toEqual({ satisfied: true, unmet: [] });
  });

  it.each([
    ['deployment merges', withDeployment({ lowMerged: 149 })],
    ['requesters', withDeployment({ distinctRequesters: 2 })],
    ['deployment bad merge', withDeployment({ badMerges: 1 })],
    ['repo merges', withRepo({ lowMerged: 19 })],
    ['repo bad merge', withRepo({ badMerges: 1 })],
  ])('names exactly one unmet condition: %s', (_name, input) => {
    const result = autoEvidenceAssessment(input, thresholds);
    expect(result.satisfied).toBe(false);
    expect(result.unmet).toHaveLength(1);
  });

  it('lists every unmet condition, with no identifiers', () => {
    const result = autoEvidenceAssessment(
      {
        deployment: { badMerges: 2, distinctRequesters: 1, lowMerged: 10 },
        repository: { badMerges: 1, lowMerged: 0 },
        windowDays: 90,
      },
      thresholds
    );
    expect(result.unmet).toHaveLength(5);
    expect(result.unmet.join(' ')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('is satisfied with zero thresholds on an empty record', () => {
    expect(
      autoEvidenceAssessment(
        {
          deployment: { badMerges: 0, distinctRequesters: 0, lowMerged: 0 },
          repository: { badMerges: 0, lowMerged: 0 },
          windowDays: 90,
        },
        { minDistinctRequesters: 0, minEvidence: 0, minRepoEvidence: 0 }
      ).satisfied
    ).toBe(true);
  });
});
