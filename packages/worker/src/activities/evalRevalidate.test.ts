import { describe, expect, it, vi } from 'vitest';

const runGateStandalone = vi.fn(async (_input: unknown) => ({
  exitCode: 0,
  passed: true,
  summary: 'ok',
}));
vi.mock('./standaloneGateRunner.js', () => ({
  runGateStandalone: (input: unknown) => runGateStandalone(input),
}));
const evalCaseUpdate = vi.fn(async (_args: unknown) => ({}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { evalCase: { update: (args: unknown) => evalCaseUpdate(args) } },
}));

import {
  _defaults,
  type RevalCaseRow,
  type RevalidateDeps,
  revalidateDataset,
  runCaseReference,
} from './evalRevalidate.js';
import { EVAL_WORKSPACE_IMAGE, evalWorkspaceImageFor } from './evalWorkspaceImage.js';
import type { GateResult } from './qualityGates.js';

const c = (over: Partial<RevalCaseRow>): RevalCaseRow => ({
  baselineSha: 's',
  goldenTest: 'yarn test',
  id: 'c',
  input: null,
  quarantined: false,
  repoUrl: 'r',
  tags: [],
  ...over,
});

function deps(cases: RevalCaseRow[], passes: (c: RevalCaseRow) => boolean | GateResult) {
  const setQuarantined = vi.fn(async () => {});
  return {
    deps: {
      loadCases: async () => cases,
      runReference: async (x: RevalCaseRow): Promise<GateResult> => {
        const p = passes(x);
        return typeof p === 'boolean'
          ? { exitCode: p ? 0 : 1, passed: p, summary: p ? 'ok' : 'failed' }
          : p;
      },
      setQuarantined,
    } satisfies RevalidateDeps,
    setQuarantined,
  };
}

describe('revalidateDataset', () => {
  it('quarantines a case whose reference now fails', async () => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a' })], () => false);
    const r = await revalidateDataset('d1', d);
    expect(r).toEqual({ checked: 1, quarantined: 1, restored: 0 });
    expect(setQuarantined).toHaveBeenCalledWith('a', true);
  });

  it('restores a previously-quarantined case that passes again', async () => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a', quarantined: true })], () => true);
    const r = await revalidateDataset('d1', d);
    expect(r).toEqual({ checked: 1, quarantined: 0, restored: 1 });
    expect(setQuarantined).toHaveBeenCalledWith('a', false);
  });

  it('leaves a healthy passing case untouched', async () => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a' })], () => true);
    const r = await revalidateDataset('d1', d);
    expect(r).toEqual({ checked: 1, quarantined: 0, restored: 0 });
    expect(setQuarantined).not.toHaveBeenCalled();
  });

  const killedRuns: Array<[string, GateResult]> = [
    ['a timeout', { exitCode: 124, passed: false, signal: 'SIGTERM', summary: 'timed out' }],
    ['an out-of-memory kill', { exitCode: 137, passed: false, summary: 'exit 137' }],
  ];
  it.each(killedRuns)('does not quarantine a healthy case after %s', async (_label, killed) => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a' })], () => killed);
    const r = await revalidateDataset('d1', d);
    expect(r).toEqual({ checked: 1, quarantined: 0, restored: 0 });
    expect(setQuarantined).not.toHaveBeenCalled();
  });

  it('does not restore a quarantined case after a killed run', async () => {
    const killed: GateResult = { exitCode: 137, passed: false, summary: 'exit 137' };
    const { deps: d, setQuarantined } = deps([c({ id: 'a', quarantined: true })], () => killed);
    const r = await revalidateDataset('d1', d);
    expect(r.restored).toBe(0);
    expect(setQuarantined).not.toHaveBeenCalled();
  });

  it('leaves an already-quarantined still-failing case untouched', async () => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a', quarantined: true })], () => false);
    const r = await revalidateDataset('d1', d);
    expect(r.quarantined).toBe(0);
    expect(r.restored).toBe(0);
    expect(setQuarantined).not.toHaveBeenCalled();
  });
});

describe('defaultSetQuarantined', () => {
  it('quarantines without touching the screen state', async () => {
    evalCaseUpdate.mockClear();
    await _defaults.defaultSetQuarantined('a', true);
    expect(evalCaseUpdate).toHaveBeenCalledWith({
      data: { quarantined: true },
      where: { id: 'a' },
    });
  });

  it('sends a restored case back to unscreened, so a new screen must pass', async () => {
    evalCaseUpdate.mockClear();
    await _defaults.defaultSetQuarantined('a', false);
    expect(evalCaseUpdate).toHaveBeenCalledWith({
      data: { flakeRuns: 0, flakeScreened: false, flakeScreenInfraErrors: 0, quarantined: false },
      where: { id: 'a' },
    });
  });
});

describe('runCaseReference', () => {
  it('runs a case on the pinned image of the stack it names', async () => {
    await runCaseReference(c({ goldenTest: 'go test ./...', stack: 'go' }));
    expect(runGateStandalone).toHaveBeenCalledWith(
      expect.objectContaining({ image: evalWorkspaceImageFor('go') })
    );
    expect(evalWorkspaceImageFor('go')).toMatch(/^golang:.*@sha256:/);
  });

  it('runs the golden test at the pinned SHA in the image the harness scores in', async () => {
    await runCaseReference(c({ baselineSha: 'abc', goldenTest: 'yarn test x', repoUrl: 'r1' }));
    expect(runGateStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        authedRepoUrl: 'r1',
        checkoutSha: 'abc',
        command: 'yarn test x',
        image: EVAL_WORKSPACE_IMAGE,
      })
    );
  });
});
