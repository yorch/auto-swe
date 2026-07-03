import { describe, expect, it, vi } from 'vitest';
import { type RevalCaseRow, type RevalidateDeps, revalidateDataset } from './evalRevalidate.js';

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

function deps(cases: RevalCaseRow[], passes: (c: RevalCaseRow) => boolean) {
  const setQuarantined = vi.fn(async () => {});
  return {
    deps: {
      loadCases: async () => cases,
      runReference: async (x: RevalCaseRow) => passes(x),
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

  it('leaves an already-quarantined still-failing case untouched', async () => {
    const { deps: d, setQuarantined } = deps([c({ id: 'a', quarantined: true })], () => false);
    const r = await revalidateDataset('d1', d);
    expect(r.quarantined).toBe(0);
    expect(r.restored).toBe(0);
    expect(setQuarantined).not.toHaveBeenCalled();
  });
});
