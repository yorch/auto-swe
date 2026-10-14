import { describe, expect, it, vi } from 'vitest';
import {
  FLAKE_SCREEN_MAX_INFRA_ERRORS,
  type FlakeScreenDeps,
  isInfrastructureFailure,
  type ScreenCaseRow,
  screenDatasetCases,
} from './evalFlakeScreen.js';
import type { GateResult } from './qualityGates.js';

const c = (id: string, infraErrors = 0): ScreenCaseRow => ({
  baselineSha: 's',
  goldenTest: 'yarn test',
  id,
  infraErrors,
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
  cases: ScreenCaseRow[],
  runReference: FlakeScreenDeps['runReference'],
  recorded = true
) {
  // Like the database: a recorded case is no longer loaded as unscreened.
  const done = new Set<string>();
  const recordScreen = vi.fn(async (x: ScreenCaseRow, _flakeScreened: boolean, _runs: number) => {
    if (recorded) {
      done.add(x.id);
    }
    return recorded;
  });
  // Like the database: the cap records a failed screen, so the case is no longer loaded.
  const recordInfraError = vi.fn(async (x: ScreenCaseRow, _runs: number) => {
    const capped = x.infraErrors + 1 >= FLAKE_SCREEN_MAX_INFRA_ERRORS;
    if (capped) {
      done.add(x.id);
    }
    return capped;
  });
  const d: FlakeScreenDeps = {
    loadCases: async () => cases.filter((x) => !done.has(x.id)),
    recordInfraError,
    recordScreen,
    runReference,
    runs: 3,
  };
  return { d, recordInfraError, recordScreen };
}

describe('isInfrastructureFailure', () => {
  it('reads a signal or a killed process as infrastructure, any other exit as the test', () => {
    expect(isInfrastructureFailure({ ...gate(false), exitCode: 124, signal: 'SIGTERM' })).toBe(
      true
    );
    expect(isInfrastructureFailure({ ...gate(false), exitCode: 137 })).toBe(true);
    expect(isInfrastructureFailure({ ...gate(false), exitCode: 143 })).toBe(true);
    // exit(-1) in the test itself is the test failing, not the infrastructure.
    expect(isInfrastructureFailure({ ...gate(false), exitCode: 255 })).toBe(false);
    expect(isInfrastructureFailure(gate(false))).toBe(false);
    expect(isInfrastructureFailure({ ...gate(false), exitCode: 2 })).toBe(false);
    expect(isInfrastructureFailure(gate(true))).toBe(false);
  });
});

describe('screenDatasetCases', () => {
  it('marks a case screened only when its reference passes every run', async () => {
    const runReference = vi.fn(async () => gate(true));
    const { d, recordScreen } = deps([c('a')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(runReference).toHaveBeenCalledTimes(3);
    expect(recordScreen).toHaveBeenCalledWith(c('a'), true, 3);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: [], passed: 1, screened: 1 });
  });

  it('records a failed screen at the first failing run, without the runs left', async () => {
    const runReference = vi
      .fn<FlakeScreenDeps['runReference']>()
      .mockResolvedValueOnce(gate(true))
      .mockResolvedValueOnce(gate(false))
      .mockResolvedValueOnce(gate(true));
    const { d, recordScreen } = deps([c('a')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(runReference).toHaveBeenCalledTimes(2);
    expect(recordScreen).toHaveBeenCalledWith(c('a'), false, 3);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: ['a'], passed: 0, screened: 1 });
  });

  it('leaves a case unscreened when a reference run hits an infrastructure error', async () => {
    const runReference = vi.fn(async (x: ScreenCaseRow) => {
      if (x.id === 'a') {
        throw new Error('clone failed');
      }
      return gate(true);
    });
    const { d, recordInfraError, recordScreen } = deps([c('a'), c('b')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(recordInfraError).toHaveBeenCalledWith(c('a'), 3);
    expect(recordScreen).toHaveBeenCalledTimes(1);
    expect(recordScreen).toHaveBeenCalledWith(c('b'), true, 3);
    expect(r).toEqual({ erroredCaseIds: ['a'], failedCaseIds: [], passed: 1, screened: 1 });
  });

  it('leaves out the cases it is told to skip', async () => {
    const { d, recordScreen } = deps([c('a'), c('b')], async () => gate(true));
    const r = await screenDatasetCases('d1', d, ['a']);
    expect(recordScreen.mock.calls.map(([x]) => x.id)).toEqual(['b']);
    expect(r.screened).toBe(1);
  });

  it('heartbeats after every reference run', async () => {
    const heartbeat = vi.fn();
    const { d } = deps([c('a'), c('b')], async () => gate(true));
    await screenDatasetCases('d1', { ...d, heartbeat });
    expect(heartbeat.mock.calls.map(([x]) => x)).toEqual([
      { caseId: 'a', run: 1 },
      { caseId: 'a', run: 2 },
      { caseId: 'a', run: 3 },
      { caseId: 'b', run: 1 },
      { caseId: 'b', run: 2 },
      { caseId: 'b', run: 3 },
    ]);
  });

  it('picks up a case that became unscreened while it ran', async () => {
    const cases = [c('a')];
    const runReference = vi.fn(async (x: ScreenCaseRow) => {
      if (x.id === 'a' && cases.length === 1) {
        cases.push(c('b'));
      }
      return gate(true);
    });
    const { d, recordScreen } = deps(cases, runReference);
    const r = await screenDatasetCases('d1', d);
    expect(recordScreen.mock.calls.map(([x]) => x.id)).toEqual(['a', 'b']);
    expect(r.screened).toBe(2);
  });

  const killedRuns: Array<[string, GateResult]> = [
    ['a timeout', { exitCode: 124, passed: false, signal: 'SIGTERM', summary: 'timed out' }],
    ['an out-of-memory kill', { exitCode: 137, passed: false, summary: 'exit 137' }],
    [
      'a runner that could not start',
      { exitCode: 127, passed: false, signal: 'SPAWN_ERROR', summary: 'x' },
    ],
  ];
  it.each(killedRuns)('leaves a case unscreened after %s, not flaky', async (_label, killed) => {
    const runReference = vi
      .fn<FlakeScreenDeps['runReference']>()
      .mockResolvedValueOnce(gate(true))
      .mockResolvedValueOnce(killed);
    const { d, recordInfraError, recordScreen } = deps([c('a')], runReference);
    const r = await screenDatasetCases('d1', d);
    expect(runReference).toHaveBeenCalledTimes(2);
    expect(recordScreen).not.toHaveBeenCalled();
    expect(recordInfraError).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ erroredCaseIds: ['a'], failedCaseIds: [], passed: 0, screened: 0 });
  });

  it('records a case as a failed screen once it reaches the infrastructure-error cap', async () => {
    const killed: GateResult = { exitCode: 137, passed: false, summary: 'exit 137' };
    const { d, recordInfraError, recordScreen } = deps(
      [c('a', FLAKE_SCREEN_MAX_INFRA_ERRORS - 1)],
      async () => killed
    );
    const r = await screenDatasetCases('d1', d);
    expect(recordInfraError).toHaveBeenCalledTimes(1);
    expect(recordScreen).not.toHaveBeenCalled();
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: ['a'], passed: 0, screened: 1 });
  });

  it('keeps screening the other cases when counting an infrastructure error fails', async () => {
    const runReference = vi.fn(async (x: ScreenCaseRow) => {
      if (x.id === 'a') {
        throw new Error('clone failed');
      }
      return gate(true);
    });
    const { d } = deps([c('a'), c('b')], runReference);
    const recordInfraError = vi.fn(async () => {
      throw new Error('db down');
    });
    const r = await screenDatasetCases('d1', { ...d, recordInfraError });
    expect(r).toEqual({ erroredCaseIds: ['a'], failedCaseIds: [], passed: 1, screened: 1 });
  });

  it('does not count a case whose reference changed while it was screened', async () => {
    const { d } = deps([c('a')], async () => gate(false), false);
    const r = await screenDatasetCases('d1', d);
    expect(r).toEqual({ erroredCaseIds: [], failedCaseIds: [], passed: 0, screened: 0 });
  });
});
