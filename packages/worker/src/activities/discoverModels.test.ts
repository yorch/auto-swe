import { beforeEach, describe, expect, it, vi } from 'vitest';

const runModelDiscovery = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@auto-swe/shared/lib/modelSuggestions', () => ({
  runModelDiscovery: (...a: unknown[]) => runModelDiscovery(...a),
}));
const warn = vi.fn();
vi.mock('@temporalio/activity', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => warn(...a) },
}));

import { discoverModels } from './discoverModels.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('discoverModels', () => {
  it('runs the shared discovery and returns its summary', async () => {
    const summary = {
      providers: [{ newModels: 2, ok: true, provider: 'openai', retirementCandidates: 1 }],
    };
    runModelDiscovery.mockResolvedValue({ results: [], summary });
    expect(await discoverModels()).toEqual(summary);
    expect(runModelDiscovery).toHaveBeenCalledWith({ marker: 'prisma' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failed provider by name and still succeeds', async () => {
    const summary = {
      providers: [
        {
          error: 'HTTP 401',
          newModels: 0,
          ok: false,
          provider: 'anthropic',
          retirementCandidates: 0,
        },
        { newModels: 1, ok: true, provider: 'openai', retirementCandidates: 0 },
      ],
    };
    runModelDiscovery.mockResolvedValue({ results: [], summary });
    await expect(discoverModels()).resolves.toEqual(summary);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'HTTP 401', provider: 'anthropic' });
  });
});
