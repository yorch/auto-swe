import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { verifyOrchestrationToken } from '@auto-swe/shared/lib/orchestrationTokenKey';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGatewayInternalUrl: () => 'http://gateway.internal:8080',
}));

import {
  createOrchestrationGateway,
  MAX_RESPONSE_BYTES,
  redactOrchestrationTokens,
} from './orchestrationGateway.js';

const ORCH = '0b1c2d3e-0000-4000-8000-000000000001';

beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});

const bearerOf = (init: RequestInit) =>
  ((init.headers as Record<string, string>).Authorization as string).slice('Bearer '.length);

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
    const gw = createOrchestrationGateway(ORCH, { fetchImpl: impl });
    const res = await gw.post('/api/v1/orchestrations/o1/children', { a: 1 });
    expect(res).toEqual({ body: { childId: 'c1' }, status: 201 });
    const { init, url } = calls[0] ?? { init: {}, url: new URL('http://x') };
    expect(url.href).toBe('http://gateway.internal:8080/api/v1/orchestrations/o1/children');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(bearerOf(init)).toMatch(/^orch_/);
    expect(init.body).toBe('{"a":1}');
  });

  it('mints a fresh two-minute token for every call, bound to its orchestration', async () => {
    const { calls, impl } = fakeFetch(200, '{}');
    const gw = createOrchestrationGateway(ORCH, { fetchImpl: impl });
    await gw.post('/api/v1/a', {});
    await gw.post('/api/v1/b', {});
    const [first, second] = calls.map((c) => bearerOf(c.init));
    expect(first).not.toBe(second);
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.slice(5).split('.')[0] as string, 'base64url').toString());
    const [a, b] = [claims(first as string), claims(second as string)];
    expect(a.jti).not.toBe(b.jti);
    expect(a.exp - a.iat).toBe(120);
    expect(a.oid).toBe(ORCH);
    // Verifies as the gateway does, and names only the orchestration.
    expect(verifyOrchestrationToken(first as string)).toEqual({ ok: true, orchestrationId: ORCH });
    expect(Object.keys(a).sort()).toEqual(['exp', 'iat', 'jti', 'oid', 'v']);
  });

  it('keeps the token out of a transport error', async () => {
    let sent = '';
    const impl = (async (_url: URL, init: RequestInit) => {
      sent = bearerOf(init);
      throw new Error(`connect failed with Bearer ${sent}`);
    }) as unknown as typeof fetch;
    const gw = createOrchestrationGateway(ORCH, { fetchImpl: impl });
    const err = await gw.post('/api/v1/x', {}).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(sent);
    expect((err as Error).message).not.toContain('orch_');
  });

  it('masks orchestration tokens in free text', () => {
    expect(redactOrchestrationTokens('x orch_abc-_9.def-_1 y orch_zzz')).toBe('x *** y ***');
  });

  it('keeps a non-JSON body as text', async () => {
    const gw = createOrchestrationGateway(ORCH, { fetchImpl: fakeFetch(502, 'bad gateway').impl });
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
    const gw = createOrchestrationGateway(ORCH, { fetchImpl: impl });
    const res = await gw.post('/api/v1/x', {});
    expect((res.body as string).length).toBe(MAX_RESPONSE_BYTES);
    // An endless stream was cancelled after the cap, not read to the end.
    expect(pulled).toBeLessThan(10);
  });

  it.each(['/other/route', 'http://evil.test/api/v1/x', '/api/v1/../admin', '/api/v1/a?x=1'])(
    'never sends the token to %s',
    async (path) => {
      const { calls, impl } = fakeFetch(200, '{}');
      const gw = createOrchestrationGateway(ORCH, { fetchImpl: impl });
      await expect(gw.post(path, {})).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  );
});
