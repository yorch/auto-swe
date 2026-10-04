import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweepSkillSources = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@auto-swe/shared/lib/skillSourceSync', () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
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
});
