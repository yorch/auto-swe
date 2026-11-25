import { randomBytes } from 'node:crypto';
import { verifyCampaignToken } from '@auto-swe/shared/lib/campaignTokenKey';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGatewayInternalUrl: () => 'http://gateway.internal:8080',
}));

import {
  createCampaignGateway,
  MAX_RESPONSE_BYTES,
  redactCampaignTokens,
} from './campaignGateway.js';

const C = '33333333-3333-4333-8333-333333333333';
const T = '44444444-4444-4444-8444-444444444444';
const scope = { call: 'startAttempt' as const, campaignId: C, targetId: T };

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

describe('createCampaignGateway', () => {
  it('posts JSON to the operator’s gateway with a campaign token, refusing redirects', async () => {
    const { calls, impl } = fakeFetch(201, '{"attemptId":"a1"}');
    const gw = createCampaignGateway({ fetchImpl: impl });
    const res = await gw.post('/api/v1/campaigns/x/attempts', { a: 1 }, scope, { 'X-Extra': '1' });
    expect(res).toEqual({ body: { attemptId: 'a1' }, status: 201 });
    const { init, url } = calls[0] ?? { init: {}, url: new URL('http://x') };
    expect(url.href).toBe('http://gateway.internal:8080/api/v1/campaigns/x/attempts');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['X-Extra']).toBe('1');
    expect(init.body).toBe('{"a":1}');
    expect(bearerOf(init)).toMatch(/^camp_/);
  });

  it('mints a fresh two-minute token for every call, scoped to its campaign, target and call', async () => {
    const { calls, impl } = fakeFetch(200, '{}');
    const gw = createCampaignGateway({ fetchImpl: impl });
    await gw.post('/api/v1/a', {}, scope);
    await gw.post('/api/v1/b', {}, scope);
    const [first, second] = calls.map((c) => bearerOf(c.init));
    expect(first).not.toBe(second);
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.slice(5).split('.')[0] as string, 'base64url').toString());
    const a = claims(first as string);
    expect(a.exp - a.iat).toBe(120);
    expect(a).toMatchObject({ call: 'startAttempt', cid: C, tid: T });
    expect(verifyCampaignToken(first as string)).toMatchObject({ campaignId: C, ok: true });
  });

  it('refuses a path outside /api/v1/ before sending anything', async () => {
    const { calls, impl } = fakeFetch(200, '{}');
    const gw = createCampaignGateway({ fetchImpl: impl });
    await expect(gw.post('/admin/x', {}, scope)).rejects.toThrow(/\/api\/v1\//);
    await expect(gw.post('/api/v1/../admin', {}, scope)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('keeps the token out of a transport error', async () => {
    let seen = '';
    const impl = (async (_url: URL, init: RequestInit) => {
      seen = bearerOf(init);
      throw new Error(`connect refused for Bearer ${seen}`);
    }) as unknown as typeof fetch;
    const gw = createCampaignGateway({ fetchImpl: impl });
    const err = await gw.post('/api/v1/a', {}, scope).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(seen);
    expect((err as Error).message).toContain('***');
  });

  it('returns raw text for a body that is not JSON, and reads at most MAX_RESPONSE_BYTES', async () => {
    const gw = createCampaignGateway({
      fetchImpl: fakeFetch(502, '<html>bad gateway</html>').impl,
    });
    await expect(gw.post('/api/v1/a', {}, scope)).resolves.toEqual({
      body: '<html>bad gateway</html>',
      status: 502,
    });
    const big = createCampaignGateway({
      fetchImpl: fakeFetch(200, 'x'.repeat(MAX_RESPONSE_BYTES + 5000)).impl,
    });
    const res = await big.post('/api/v1/a', {}, scope);
    expect((res.body as string).length).toBe(MAX_RESPONSE_BYTES);
  });
});

describe('redactCampaignTokens', () => {
  it('masks a campaign token wherever it appears', () => {
    expect(redactCampaignTokens('bad camp_abc123.sig-xyz here')).toBe('bad *** here');
  });
});
