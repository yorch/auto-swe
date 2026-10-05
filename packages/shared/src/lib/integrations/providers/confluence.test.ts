import { describe, expect, it, vi } from 'vitest';
import type { AtlassianClient } from '../atlassianClient.js';
import { AtlassianError } from '../atlassianClient.js';
import { ConfluenceProvider } from './confluence.js';

function providerWith(get: () => Promise<unknown>) {
  return new ConfluenceProvider(
    { baseUrl: 'https://acme.atlassian.net', get } as unknown as AtlassianClient,
    {}
  );
}

describe('ConfluenceProvider — testConnection', () => {
  it('resolves when the site answers', async () => {
    await expect(
      providerWith(vi.fn().mockResolvedValue({})).testConnection([])
    ).resolves.toBeUndefined();
  });

  it.each([
    [new AtlassianError(401, 'auth', 'Atlassian auth failed: 401'), 'credentials'],
    [new AtlassianError(404, 'not_found', 'nope'), 'not_found'],
    [new AtlassianError(0, 'network', 'getaddrinfo ENOTFOUND'), 'unreachable'],
    [new AtlassianError(502, 'server', 'bad gateway'), 'failed'],
  ])('maps %o to %s', async (error, kind) => {
    const err = await providerWith(vi.fn().mockRejectedValue(error))
      .testConnection([])
      .catch((e) => e);
    expect(err.kind).toBe(kind);
  });

  it('keeps searchPages degrading to an empty list on a failure', async () => {
    const provider = providerWith(vi.fn().mockRejectedValue(new AtlassianError(401, 'auth', 'x')));
    await expect(provider.searchPages('q', [])).resolves.toEqual([]);
  });
});
