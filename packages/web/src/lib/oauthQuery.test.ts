// @vitest-environment jsdom
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedOAuthQuery } from './oauthQuery';

const SIGNED =
  'client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A3%2Fcb&scope=mcp%3Aread&exp=1999999999&sig=abc' +
  '&ba_param=client_id&ba_param=redirect_uri&ba_param=scope&ba_param=exp&ba_param=ba_param';

/** What the real better-auth client plugin attaches to a POST made from a page at `search`. */
async function pluginQuery(search: string): Promise<string | undefined> {
  const ctx = {
    body: '{}',
    headers: new Headers({ 'content-type': 'application/json' }),
    method: 'POST',
  };
  vi.stubGlobal('window', { location: { search } });
  await oauthProviderClient().fetchPlugins[0]?.hooks?.onRequest?.(ctx as never);
  return (JSON.parse(ctx.body) as { oauth_query?: string }).oauth_query;
}

afterEach(() => vi.unstubAllGlobals());

describe('signedOAuthQuery', () => {
  it('is undefined for a page that is not part of an authorization', () => {
    expect(signedOAuthQuery('')).toBeUndefined();
    expect(signedOAuthQuery('?redirect=%2F')).toBeUndefined();
    expect(signedOAuthQuery('?client_id=c1&scope=mcp%3Aread')).toBeUndefined();
  });

  it('keeps the signed parameters and the signature, and drops the page’s own', () => {
    const out = new URLSearchParams(signedOAuthQuery(`?${SIGNED}&redirect=%2Fx&bridge=1`));
    expect(out.get('client_id')).toBe('c1');
    expect(out.get('sig')).toBe('abc');
    expect(out.has('redirect')).toBe(false);
    expect(out.has('bridge')).toBe(false);
  });

  it('agrees with the better-auth client plugin', async () => {
    for (const search of [
      `?${SIGNED}`,
      `?${SIGNED}&redirect=%2Fx`,
      `?redirect=%2Fx&${SIGNED}&bridge=1`,
      '?redirect=%2Fx',
    ]) {
      expect(signedOAuthQuery(search), search).toBe(await pluginQuery(search));
    }
  });
});
