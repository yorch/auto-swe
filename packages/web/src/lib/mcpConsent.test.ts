import { describe, expect, it } from 'vitest';
import { describeRedirect, grantedScopes, parseConsentRequest, resumeUrl } from './mcpConsent';

const SIGNED = (scope: string) =>
  `client_id=c1&redirect_uri=${encodeURIComponent('http://127.0.0.1:3/cb')}&scope=${encodeURIComponent(
    scope
  )}&exp=1999999999&sig=abc&ba_param=client_id&ba_param=redirect_uri&ba_param=scope&ba_param=exp&ba_param=ba_param`;

describe('parseConsentRequest', () => {
  it('reads the client, redirect and requested scopes from a signed query', () => {
    const parsed = parseConsentRequest(`?${SIGNED('mcp:read mcp:write offline_access')}`);
    expect(parsed).toMatchObject({
      clientId: 'c1',
      redirectUri: 'http://127.0.0.1:3/cb',
      scopes: ['mcp:read', 'mcp:write', 'offline_access'],
    });
    expect(new URLSearchParams(parsed?.oauthQuery).get('sig')).toBe('abc');
  });

  it('is null without a client, a redirect or a signature', () => {
    expect(parseConsentRequest('')).toBeNull();
    expect(parseConsentRequest('?client_id=c1&redirect_uri=http%3A%2F%2Fx')).toBeNull();
    expect(parseConsentRequest(`?${SIGNED('mcp:read').replace('client_id=c1&', '')}`)).toBeNull();
  });
});

describe('describeRedirect', () => {
  it('shows the host of a web redirect and does not call it local', () => {
    expect(describeRedirect('https://claude.ai/api/mcp/auth_callback?x=1')).toEqual({
      host: 'claude.ai',
      local: false,
    });
  });

  it('flags a loopback redirect, port included', () => {
    expect(describeRedirect('http://127.0.0.1:33333/cb')).toEqual({
      host: '127.0.0.1:33333',
      local: true,
    });
    expect(describeRedirect('http://localhost:8080/cb').local).toBe(true);
    expect(describeRedirect('http://[::1]:9/cb').local).toBe(true);
  });

  it('flags an app’s own URL scheme', () => {
    expect(describeRedirect('cursor://anysphere.cursor-mcp/oauth/callback')).toEqual({
      host: 'cursor://anysphere.cursor-mcp',
      local: true,
    });
  });

  it('does not mistake a lookalike host for loopback', () => {
    expect(describeRedirect('http://localhost.evil.test/cb').local).toBe(false);
    expect(describeRedirect('https://127.0.0.1.evil.test/cb').local).toBe(false);
  });

  it('shows an unparseable value as it is', () => {
    expect(describeRedirect('not a url')).toEqual({ host: 'not a url', local: false });
  });
});

describe('resumeUrl', () => {
  it('accepts web and app-scheme URLs and refuses ones that would run script', () => {
    expect(resumeUrl('http://localhost:3000/oauth/consent?x=1')).toBe(
      'http://localhost:3000/oauth/consent?x=1'
    );
    expect(resumeUrl('cursor://app/cb?code=1')).toBe('cursor://app/cb?code=1');
    expect(resumeUrl('javascript:alert(1)')).toBeNull();
    expect(resumeUrl('data:text/html,x')).toBeNull();
    expect(resumeUrl('/relative')).toBeNull();
    expect(resumeUrl(undefined)).toBeNull();
  });
});

describe('grantedScopes', () => {
  it('drops write unless allowed and keeps the rest', () => {
    const asked = ['mcp:read', 'mcp:write', 'offline_access'];
    expect(grantedScopes(asked, false)).toEqual(['mcp:read', 'offline_access']);
    expect(grantedScopes(asked, true)).toEqual(asked);
  });
});
