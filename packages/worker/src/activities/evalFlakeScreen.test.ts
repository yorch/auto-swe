import { describe, expect, it, vi } from 'vitest';
import { type FlakeScreenDeps, screenDatasetCases } from './evalFlakeScreen.js';
import type { EvalCaseRow } from './evalHarness.js';
import type { GateResult } from './qualityGates.js';

const c = (id: string): EvalCaseRow => ({
  baselineSha: 's',
  goldenTest: 'yarn test',
  id,
  input: null,
  repoUrl: 'r',
  tags: [],
});

const gate = (passed: boolean): GateResult => ({
  exitCode: passed ? 0 : 1,
  passed,
  summary: passed ? 'ok' : 'failed',
});

function deps(
  cases: EvalCaseRow[],
  runReference: FlakeScreenDeps['runReference'],
  recorded = true
) {
  const recordScreen = vi.fn(async () => recorded);
  const d: FlakeScreenDeps = {
    loadCases: async () => cases,
    recordScreen,
    runReference,
    runs: 3,
  };
  return { d, recordScreen };
}

describe('screenDatasetCases', () => {
  it('marks a case screened only when its reference passes every run', async () => {
    const runReference = vi.fn(async () => gate(true));
    const { d, recordScreen } = deps([c('a')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(runReference).toHaveBeenCalledTimes(3);
    expect(recordScreen).toHaveBeenCalledWith(c('a'), true, 3);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: [], passed: 1, screened: 1 });
  });

  it('records a failed screen when any run fails', async () => {
    const runReference = vi
      .fn<FlakeScreenDeps['runReference']>()
      .mockResolvedValueOnce(gate(true))
      .mockResolvedValueOnce(gate(false))
      .mockResolvedValueOnce(gate(true));
    const { d, recordScreen } = deps([c('a')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(recordScreen).toHaveBeenCalledWith(c('a'), false, 3);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: ['a'], passed: 0, screened: 1 });
  });

  it('leaves a case unscreened when a reference run hits an infrastructure error', async () => {
    const runReference = vi.fn(async (x: EvalCaseRow) => {
      if (x.id === 'a') {
        throw new Error('clone failed');
      }
      return gate(true);
    });
    const { d, recordScreen } = deps([c('a'), c('b')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(recordScreen).toHaveBeenCalledTimes(1);
    expect(recordScreen).toHaveBeenCalledWith(c('b'), true, 3);
    expect(r).toEqual({ erroredCaseIds: ['a'], failedCaseIds: [], passed: 1, screened: 1 });
  });

  it('does not count a case whose reference changed while it was screened', async () => {
    const { d } = deps([c('a')], async () => gate(false), false);
    const r = await screenDatasetCases('d1', d);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: [], passed: 0, screened: 0 });
  });
});
