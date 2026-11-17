import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGatewayInternalUrl: () => 'http://gateway.internal:8080',
}));

import { createOrchestrationGateway, MAX_RESPONSE_BYTES } from './orchestrationGateway.js';

function fakeFetch(status: number, body: string) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ init, url });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('createOrchestrationGateway', () => {
  it('posts JSON with the token, refuses redirects, and parses the answer', async () => {
    const { calls, impl } = fakeFetch(201, '{"childId":"c1"}');
    const gw = createOrchestrationGateway('orch_tok', { fetchImpl: impl });
    const res = await gw.post('/api/v1/orchestrations/o1/children', { a: 1 });
    expect(res).toEqual({ body: { childId: 'c1' }, status: 201 });
    const { init, url } = calls[0] ?? { init: {}, url: new URL('http://x') };
    expect(url.href).toBe('http://gateway.internal:8080/api/v1/orchestrations/o1/children');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer orch_tok');
    expect(init.body).toBe('{"a":1}');
  });

  it('keeps a non-JSON body as text', async () => {
    const gw = createOrchestrationGateway('t', { fetchImpl: fakeFetch(502, 'bad gateway').impl });
    expect(await gw.post('/api/v1/x', {})).toEqual({ body: 'bad gateway', status: 502 });
  });

  it('stops reading an oversized body at the cap instead of buffering it', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(10_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const impl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const gw = createOrchestrationGateway('t', { fetchImpl: impl });
    const res = await gw.post('/api/v1/x', {});
    expect((res.body as string).length).toBe(MAX_RESPONSE_BYTES);
    // An endless stream was cancelled after the cap, not read to the end.
    expect(pulled).toBeLessThan(10);
  });

  it.each(['/other/route', 'http://evil.test/api/v1/x', '/api/v1/../admin', '/api/v1/a?x=1'])(
    'never sends the token to %s',
    async (path) => {
      const { calls, impl } = fakeFetch(200, '{}');
      const gw = createOrchestrationGateway('t', { fetchImpl: impl });
      await expect(gw.post(path, {})).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  );
});
