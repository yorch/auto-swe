import { describe, expect, it, vi } from 'vitest';
import { type EvalCaseRow, type HarnessDeps, runEvalHarness } from './evalHarness.js';

const cases: EvalCaseRow[] = [
  { baselineSha: 's1', goldenTest: 'yarn test', id: 'c1', repoUrl: 'r1', tags: ['repo:a'] },
  { baselineSha: 's2', goldenTest: 'yarn test', id: 'c2', repoUrl: 'r2', tags: ['repo:a'] },
  { baselineSha: 's3', goldenTest: 'yarn test', id: 'c3', repoUrl: 'r3', tags: ['repo:b'] },
];

function deps(over: Partial<HarnessDeps> = {}): HarnessDeps & {
  records: unknown[];
  finals: { status: string; summary: unknown }[];
} {
  const records: unknown[] = [];
  const finals: { status: string; summary: unknown }[] = [];
  return {
    finalize: async (_id, status, summary) => {
      finals.push({ status, summary });
    },
    finals,
    loadCases: async () => cases,
    record: (async (r: unknown) => {
      records.push(r);
    }) as HarnessDeps['record'],
    records,
    runCase: async () => 1,
    ...over,
  };
}

const input = {
  baselineRef: 'main',
  candidateRef: 'cand',
  datasetId: 'd1',
  evalRunId: 'run-1',
};

describe('runEvalHarness', () => {
  it('records one gate row per case (candidate arm) and finalizes', async () => {
    const d = deps();
    await runEvalHarness(input, d);
    expect(d.records).toHaveLength(3);
    expect(d.finals).toHaveLength(1);
    expect(d.finals[0].status).toBe('SUCCESS');
  });

  it('marks REGRESSION when the candidate is consistently worse', async () => {
    // baseline passes everything, candidate fails everything
    const d = deps({
      runCase: vi.fn(async (_c, ref) => (ref === 'main' ? 1 : 0)) as HarnessDeps['runCase'],
    });
    const verdict = await runEvalHarness(input, d);
    expect(verdict.regression).toBe(true);
    expect(d.finals[0].status).toBe('REGRESSION');
  });

  it('does not flag REGRESSION when arms are equal', async () => {
    const d = deps({ runCase: async () => 1 });
    const verdict = await runEvalHarness(input, d);
    expect(verdict.regression).toBe(false);
    expect(verdict.overall.delta).toBe(0);
  });

  it('persists the candidate floor outcome (value 0 on failure)', async () => {
    const d = deps({
      runCase: async (_c, ref) => (ref === 'cand' ? 0 : 1),
    });
    await runEvalHarness(input, d);
    expect((d.records[0] as { value: number }).value).toBe(0);
    expect((d.records[0] as { passed: boolean }).passed).toBe(false);
  });
});
