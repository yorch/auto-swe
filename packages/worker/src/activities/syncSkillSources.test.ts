import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweepSkillSources = vi.fn();
const sweepHarnessProfiles = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@auto-swe/shared/lib/skillSourceSync', () => ({
  sweepHarnessProfiles: (...a: unknown[]) => sweepHarnessProfiles(...a),
  sweepSkillSources: (...a: unknown[]) => sweepSkillSources(...a),
}));
const warn = vi.fn();
const info = vi.fn();
vi.mock('@temporalio/activity', () => ({
  log: {
    error: vi.fn(),
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
  },
}));

import { syncSkillSources } from './syncSkillSources.js';

const noProfiles = {
  checked: 0,
  errors: 0,
  ok: 0,
  profiles: [],
  skipped: 0,
  updateAvailable: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  sweepHarnessProfiles.mockResolvedValue(noProfiles);
});

describe('syncSkillSources', () => {
  it('returns the sweep result and logs only counts', async () => {
    const result = {
      checked: 2,
      errors: 0,
      ok: 1,
      skipped: 0,
      sources: [
        { error: null, id: 'a', status: 'OK' },
        { error: null, id: 'b', status: 'UPDATE_AVAILABLE' },
      ],
      updateAvailable: 1,
    };
    sweepSkillSources.mockResolvedValue(result);
    expect(await syncSkillSources()).toEqual(result);
    expect(sweepSkillSources).toHaveBeenCalledWith({ marker: 'prisma' });
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls[0]?.[1]).toEqual({
      checked: 2,
      errors: 0,
      ok: 1,
      skipped: 0,
      updateAvailable: 1,
    });
  });

  it('logs a failed source by id and fixed string only, and still succeeds', async () => {
    sweepSkillSources.mockResolvedValue({
      checked: 1,
      errors: 1,
      ok: 0,
      skipped: 0,
      sources: [{ error: 'timed out', id: 'src-1', status: 'ERROR' }],
      updateAvailable: 0,
    });
    await expect(syncSkillSources()).resolves.toMatchObject({ errors: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'timed out', sourceId: 'src-1' });
  });
  it('also sweeps harness profiles and logs a failed one by id and fixed string only', async () => {
    sweepSkillSources.mockResolvedValue({
      checked: 0,
      errors: 0,
      ok: 0,
      skipped: 0,
      sources: [],
      updateAvailable: 0,
    });
    sweepHarnessProfiles.mockResolvedValue({
      ...noProfiles,
      checked: 1,
      errors: 1,
      profiles: [{ error: 'timed out', id: 'prof-1', status: 'ERROR' }],
    });
    await syncSkillSources();
    expect(sweepHarnessProfiles).toHaveBeenCalledWith({ marker: 'prisma' });
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'timed out', profileId: 'prof-1' });
  });

  it('keeps the skill-source result when the profile sweep throws', async () => {
    const result = {
      checked: 0,
      errors: 0,
      ok: 0,
      skipped: 0,
      sources: [],
      updateAvailable: 0,
    };
    sweepSkillSources.mockResolvedValue(result);
    sweepHarnessProfiles.mockRejectedValue(new Error('db down: secret detail'));
    await expect(syncSkillSources()).resolves.toEqual(result);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
  });
});
