import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweepMarketplaceSources = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@auto-swe/shared/lib/marketplace', () => ({
  sweepMarketplaceSources: (...a: unknown[]) => sweepMarketplaceSources(...a),
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

import { syncMarketplaces } from './syncMarketplaces.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncMarketplaces', () => {
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
    sweepMarketplaceSources.mockResolvedValue(result);
    expect(await syncMarketplaces()).toEqual(result);
    expect(sweepMarketplaceSources).toHaveBeenCalledWith({ marker: 'prisma' });
    expect(info).toHaveBeenCalledWith('marketplace sync complete', {
      checked: 2,
      errors: 0,
      ok: 1,
      skipped: 0,
      updateAvailable: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the source id and the fixed error string, nothing else', async () => {
    sweepMarketplaceSources.mockResolvedValue({
      checked: 1,
      errors: 1,
      ok: 0,
      skipped: 0,
      sources: [{ error: 'request failed', id: 'bad', status: 'ERROR' }],
      updateAvailable: 0,
    });
    await syncMarketplaces();
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      error: 'request failed',
      sourceId: 'bad',
    });
  });
});
