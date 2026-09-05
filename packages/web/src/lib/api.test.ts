import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api';

describe('ApiClient request shaping', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function sentHeaders(): Record<string, string> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  it('does not label a body-less DELETE as JSON (Fastify rejects an empty JSON body)', async () => {
    const client = new ApiClient();
    client.setToken('jwt-1');
    await client.delete('/api/v1/auth/tokens/abc');
    expect(sentHeaders()['Content-Type']).toBeUndefined();
    expect(sentHeaders().Authorization).toBe('Bearer jwt-1');
  });

  it('labels POST bodies as JSON', async () => {
    const client = new ApiClient();
    await client.post('/api/v1/teams', { name: 'x' });
    expect(sentHeaders()['Content-Type']).toBe('application/json');
  });

  it('treats 204 No Content as an empty result', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ApiClient();
    await expect(client.delete('/api/v1/skills/abc')).resolves.toBeUndefined();
  });
});
