import { describe, expect, it, vi } from 'vitest';
import { AssistantPathError, createAssistantGateway, gatewayUrl } from './assistantGateway.js';

describe('gatewayUrl', () => {
  it('builds a URL under the gateway API, with the query', () => {
    expect(gatewayUrl('http://gateway:8080', '/api/v1/workflow-runs', { limit: '5' }).href).toBe(
      'http://gateway:8080/api/v1/workflow-runs?limit=5'
    );
    expect(gatewayUrl('https://x.example/base/', '/api/v1/teams').href).toBe(
      'https://x.example/base/api/v1/teams'
    );
  });

  it.each([
    '/api/v1/../admin',
    '/api/v1/x/../../health',
    '/api/v1/%2e%2e/health',
    '/api/v1/a%2fb',
    '/api/v1/runs?x=1',
    '//evil.example/api/v1/runs',
    'https://evil.example/api/v1/runs',
    '/health',
    '/api/v1\\..\\x',
  ])('refuses %s', (path) => {
    expect(() => gatewayUrl('http://gateway:8080', path)).toThrow(AssistantPathError);
  });
});

describe('createAssistantGateway', () => {
  it('sends the token to the configured gateway only, refusing redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[1]}', { status: 200 }));
    const gw = createAssistantGateway('asst_token', {
      baseUrl: 'http://gateway:8080',
      fetchImpl: fetchImpl as never,
    });
    expect(await gw.get('/api/v1/workflow-runs')).toEqual({ body: { data: [1] }, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://gateway:8080/api/v1/workflow-runs');
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer asst_token');
  });

  it('returns a non-JSON body as text and cuts a huge one', async () => {
    const big = 'x'.repeat(300_000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('plain', { status: 502 }))
      .mockResolvedValueOnce(new Response(big, { status: 200 }));
    const gw = createAssistantGateway('asst_t', {
      baseUrl: 'http://g:1',
      fetchImpl: fetchImpl as never,
    });
    expect(await gw.get('/api/v1/a')).toEqual({ body: 'plain', status: 502 });
    const cut = await gw.get('/api/v1/a');
    expect(cut.truncated).toBe(true);
    expect((cut.body as string).length).toBe(200_000);
  });
});
