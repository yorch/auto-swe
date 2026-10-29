import { describe, expect, it, vi } from 'vitest';
import { AtlassianClient, AtlassianError } from '../atlassianClient.js';

function client(fetchImpl: typeof fetch) {
  return new AtlassianClient({
    allowPrivateNetwork: false,
    apiToken: 't',
    baseUrl: 'https://acme.atlassian.net',
    email: 'a@b.c',
    fetchImpl,
    maxRetries: 0,
  });
}

describe('AtlassianClient failures', () => {
  it('reports an aborted-by-timeout request as a timeout, not a generic network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .get('/x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlassianError);
    expect((err as AtlassianError).code).toBe('timeout');
  });

  it('keeps any other thrown failure a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .get('/x')
      .catch((e: unknown) => e);
    expect((err as AtlassianError).code).toBe('network');
  });
});
