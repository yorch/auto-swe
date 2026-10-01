import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGhesUserInfo,
  resolveGithubApiUrl,
  resolveGithubSignIn,
} from './githubEnterpriseAuth.js';

const API = 'https://ghe.example.com/api/v3';
const HOST = 'ghe.example.com';

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

const profile = {
  avatar_url: 'https://ghe.example.com/avatars/42',
  email: 'public@example.com',
  id: 42,
  login: 'octocat',
  name: 'The Octocat',
};

/** Serves a profile and an email list, whatever order the code asks for them in. */
function serve(emails: unknown, user: Record<string, unknown> = profile) {
  return mockFetch((url) => (url.endsWith('/user/emails') ? json(emails) : json(user)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchGhesUserInfo', () => {
  it('asks the GHE API for the profile and the emails, authenticated as the user', async () => {
    const spy = serve([{ email: 'o@example.com', primary: true, verified: true }]);

    await fetchGhesUserInfo('tok-1', API, HOST);

    const urls = spy.mock.calls.map(([url]) => url);
    expect(urls).toContain(`${API}/user`);
    expect(urls).toContain(`${API}/user/emails`);
    for (const [, init] of spy.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-1');
    }
  });

  it('does not double the slash when the API URL ends in one', async () => {
    const spy = serve([{ email: 'o@example.com', primary: true, verified: true }]);

    await fetchGhesUserInfo('tok-1', `${API}/`, HOST);

    expect(spy.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([`${API}/user`, `${API}/user/emails`])
    );
  });

  it('uses the primary verified email, not a secondary one or the public profile email', async () => {
    serve([
      { email: 'second@example.com', primary: false, verified: true },
      { email: 'primary@example.com', primary: true, verified: true },
    ]);

    const info = await fetchGhesUserInfo('tok', API, HOST);

    expect(info).toMatchObject({ email: 'primary@example.com', emailVerified: true });
  });

  it('maps the display name and avatar, falling back to the login without a name', async () => {
    serve([{ email: 'o@example.com', primary: true, verified: true }]);
    expect(await fetchGhesUserInfo('tok', API, HOST)).toMatchObject({
      image: 'https://ghe.example.com/avatars/42',
      name: 'The Octocat',
    });

    serve([{ email: 'o@example.com', primary: true, verified: true }], { ...profile, name: null });
    expect(await fetchGhesUserInfo('tok', API, HOST)).toMatchObject({ name: 'octocat' });
  });

  it('namespaces the account id with the host so it cannot collide with another server', async () => {
    serve([{ email: 'o@example.com', primary: true, verified: true }]);

    const info = await fetchGhesUserInfo('tok', API, HOST);

    expect(info?.id).toBe('ghe.example.com:42');
  });

  it.each([
    [
      'the primary email is unverified',
      [{ email: 'a@example.com', primary: true, verified: false }],
    ],
    [
      'the verified email is not primary',
      [{ email: 'a@example.com', primary: false, verified: true }],
    ],
    ['there are no emails', []],
  ])('refuses the sign-in when %s', async (_name, emails) => {
    serve(emails);

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });

  it('refuses the sign-in when the profile request answers with an error status', async () => {
    mockFetch((url) =>
      url.endsWith('/user/emails')
        ? json([{ email: 'o@example.com', primary: true, verified: true }])
        : json(profile, 500)
    );

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });

  it('refuses the sign-in when the emails request answers with an error status', async () => {
    mockFetch((url) =>
      url.endsWith('/user/emails')
        ? json([{ email: 'o@example.com', primary: true, verified: true }], 500)
        : json(profile)
    );

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });

  it('never follows a redirect, so the bearer token cannot be sent anywhere else', async () => {
    const spy = serve([{ email: 'o@example.com', primary: true, verified: true }]);

    await fetchGhesUserInfo('tok', API, HOST);

    expect(spy.mock.calls).toHaveLength(2);
    for (const [, init] of spy.mock.calls) {
      expect(init?.redirect).toBe('error');
    }
  });

  it('lower-cases the host so differently-cased base URLs map to one account', async () => {
    serve([{ email: 'o@example.com', primary: true, verified: true }]);

    const info = await fetchGhesUserInfo('tok', API, 'GHE.Example.com');

    expect(info?.id).toBe('ghe.example.com:42');
  });

  it.each([
    ['a fractional number', 4.5],
    ['a string', '42'],
    ['missing', undefined],
  ])('refuses the sign-in when the profile id is %s', async (_name, id) => {
    serve([{ email: 'o@example.com', primary: true, verified: true }], { ...profile, id });

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });

  it('logs why a sign-in was refused without leaking the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    serve([{ email: 'a@example.com', primary: true, verified: false }]);

    await fetchGhesUserInfo('tok-secret-123', API, HOST);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('ghe.example.com');
    expect(line).toContain('primary');
    expect(line).not.toContain('tok-secret-123');
  });

  it('refuses the sign-in instead of throwing when the network fails', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });
});

const CREDS = { clientId: 'cid', clientSecret: 'sec' };
const GITHUB_API = 'https://api.github.com';

function gheConfig(input: { baseUrl: string; apiUrl?: string }) {
  const resolved = resolveGithubSignIn({
    ...CREDS,
    apiUrl: input.apiUrl ?? GITHUB_API,
    baseUrl: input.baseUrl,
  });
  if (resolved.mode !== 'ghe') {
    throw new Error(`expected ghe mode, got ${resolved.mode}`);
  }
  return resolved.config;
}

describe('resolveGithubSignIn', () => {
  it.each([
    ['https://github.com'],
    ['https://github.com/'],
    ['https://GitHub.com'],
    ['https://github.com.'],
  ])('uses the built-in provider for %s', (baseUrl) => {
    expect(resolveGithubSignIn({ ...CREDS, apiUrl: GITHUB_API, baseUrl })).toEqual({
      clientId: 'cid',
      clientSecret: 'sec',
      mode: 'builtin',
    });
  });

  it.each([
    [null, 'sec'],
    ['cid', null],
    [null, null],
  ])('registers nothing without both credentials (%s, %s)', (clientId, clientSecret) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveGithubSignIn({
        apiUrl: GITHUB_API,
        baseUrl: 'https://ghe.example.com',
        clientId,
        clientSecret,
      })
    ).toEqual({ mode: 'none' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('points authorize and token at the GHE host under /login/oauth', () => {
    const config = gheConfig({ baseUrl: 'https://ghe.example.com' });

    expect(config).toMatchObject({
      authorizationUrl: 'https://ghe.example.com/login/oauth/authorize',
      clientId: 'cid',
      clientSecret: 'sec',
      pkce: false,
      providerId: 'github',
      scopes: ['read:user', 'user:email'],
      tokenUrl: 'https://ghe.example.com/login/oauth/access_token',
    });
  });

  it('never produces a double slash from a trailing-slash base URL', () => {
    const config = gheConfig({ baseUrl: 'https://ghe.example.com/' });

    expect(config.authorizationUrl).toBe('https://ghe.example.com/login/oauth/authorize');
    expect(config.tokenUrl).toBe('https://ghe.example.com/login/oauth/access_token');
  });

  it('drops credentials embedded in the base URL', () => {
    const config = gheConfig({ baseUrl: 'https://user:pw@ghe.example.com' });

    expect(config.authorizationUrl).toBe('https://ghe.example.com/login/oauth/authorize');
    expect(JSON.stringify(config)).not.toContain('pw@');
  });

  it('derives {base}/api/v3 for the profile when the API URL is still the github.com default', async () => {
    const spy = serve([{ email: 'o@example.com', primary: true, verified: true }]);
    const config = gheConfig({ baseUrl: 'https://ghe.example.com' });

    await config.getUserInfo?.({ accessToken: 'tok' });

    expect(spy.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        'https://ghe.example.com/api/v3/user',
        'https://ghe.example.com/api/v3/user/emails',
      ])
    );
  });

  it('exposes the API URL it resolved, so other callers use the same one', () => {
    const derived = resolveGithubSignIn({
      ...CREDS,
      apiUrl: GITHUB_API,
      baseUrl: 'https://ghe.example.com/',
    });
    const explicit = resolveGithubSignIn({
      ...CREDS,
      apiUrl: 'https://api.ghe.example.com/',
      baseUrl: 'https://ghe.example.com',
    });

    expect(derived).toMatchObject({ apiUrl: 'https://ghe.example.com/api/v3', mode: 'ghe' });
    expect(explicit).toMatchObject({ apiUrl: 'https://api.ghe.example.com', mode: 'ghe' });
  });

  it('keeps an explicit API URL and strips its trailing slash', async () => {
    const spy = serve([{ email: 'o@example.com', primary: true, verified: true }]);
    const config = gheConfig({
      apiUrl: 'https://api.ghe.example.com/',
      baseUrl: 'https://ghe.example.com',
    });

    await config.getUserInfo?.({ accessToken: 'tok' });

    expect(spy.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        'https://api.ghe.example.com/user',
        'https://api.ghe.example.com/user/emails',
      ])
    );
  });

  it('namespaces the account id with the lower-cased host and any non-default port', async () => {
    serve([{ email: 'o@example.com', primary: true, verified: true }]);
    const config = gheConfig({ baseUrl: 'https://GHE.Example.com:8443' });

    const info = await config.getUserInfo?.({ accessToken: 'tok' });

    expect(info?.id).toBe('ghe.example.com:8443:42');
  });

  it('refuses the sign-in when the token response carries no access token', async () => {
    const spy = serve([]);
    const config = gheConfig({ baseUrl: 'https://ghe.example.com' });

    expect(await config.getUserInfo?.({})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([['ftp://ghe.example.com'], ['not a url'], ['']])(
    'registers nothing and logs why for the invalid base URL %j',
    (baseUrl) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(resolveGithubSignIn({ ...CREDS, apiUrl: GITHUB_API, baseUrl })).toEqual({
        mode: 'none',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it('registers nothing and logs why for an invalid API URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      resolveGithubSignIn({
        ...CREDS,
        apiUrl: 'ftp://api.example.com',
        baseUrl: 'https://ghe.example.com',
      })
    ).toEqual({ mode: 'none' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveGithubSignIn URL handling', () => {
  it('keeps a path prefix on the base URL for every endpoint', () => {
    const config = gheConfig({ baseUrl: 'https://proxy.example.com/ghe' });

    expect(config.authorizationUrl).toBe('https://proxy.example.com/ghe/login/oauth/authorize');
    expect(config.tokenUrl).toBe('https://proxy.example.com/ghe/login/oauth/access_token');
  });

  it('drops a query string and fragment from the base URL', () => {
    const config = gheConfig({ baseUrl: 'https://ghe.example.com/?next=/x#frag' });

    expect(config.authorizationUrl).toBe('https://ghe.example.com/login/oauth/authorize');
    expect(config.tokenUrl).toBe('https://ghe.example.com/login/oauth/access_token');
  });

  it('warns, without failing, when a URL is plain http', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const config = gheConfig({ baseUrl: 'http://ghe.example.com' });

    expect(config.authorizationUrl).toBe('http://ghe.example.com/login/oauth/authorize');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('plain http');
  });

  it('does not warn when both URLs are https', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    gheConfig({ baseUrl: 'https://ghe.example.com' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('says in the log that GitHub sign-in is disabled when a URL is invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    resolveGithubSignIn({ ...CREDS, apiUrl: GITHUB_API, baseUrl: 'ftp://ghe.example.com' });

    expect(String(warn.mock.calls[0]?.[0])).toContain('GitHub sign-in disabled');
  });
});

describe('resolveGithubApiUrl', () => {
  it.each([
    [
      'derives {base}/api/v3 when the API URL is still the github.com default',
      'https://ghe.example.com',
      GITHUB_API,
      'https://ghe.example.com/api/v3',
    ],
    [
      'keeps an explicit API URL, without its trailing slash',
      'https://ghe.example.com',
      'https://api.ghe.example.com/',
      'https://api.ghe.example.com',
    ],
    [
      'keeps the saved API URL for github.com',
      'https://github.com',
      'https://api.github.com/',
      'https://api.github.com',
    ],
  ])('%s', (_name, baseUrl, apiUrl, expected) => {
    expect(resolveGithubApiUrl(baseUrl, apiUrl)).toBe(expected);
  });

  it.each([
    ['an invalid base URL', 'ftp://ghe.example.com', GITHUB_API],
    ['an invalid API URL', 'https://ghe.example.com', 'not a url'],
  ])('returns null for %s', (_name, baseUrl, apiUrl) => {
    expect(resolveGithubApiUrl(baseUrl, apiUrl)).toBeNull();
  });

  it('agrees with the API URL sign-in resolved, so no caller derives its own', () => {
    const resolved = resolveGithubSignIn({
      ...CREDS,
      apiUrl: GITHUB_API,
      baseUrl: 'https://ghe.example.com/',
    });

    expect(resolved).toMatchObject({
      apiUrl: resolveGithubApiUrl('https://ghe.example.com/', GITHUB_API),
      mode: 'ghe',
    });
  });
});

describe('GitHub sign-in through better-auth', () => {
  const GATEWAY = 'https://gw.example.com';

  function authorizeUrl(
    plugins: ReturnType<typeof genericOAuth>[],
    social?: Record<string, unknown>
  ) {
    const auth = betterAuth({
      baseURL: GATEWAY,
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      plugins,
      secret: 'a-test-secret-that-is-at-least-32-characters-long',
      socialProviders: social,
      trustedOrigins: ['https://web.example.com'],
    });
    return auth.api
      .signInSocial({ body: { callbackURL: 'https://web.example.com/', provider: 'github' } })
      .then((res) => new URL(String(res.url)));
  }

  it('sends the browser to the GHE host, with the callback registered today', async () => {
    const config = gheConfig({ baseUrl: 'https://ghe.example.com' });

    const url = await authorizeUrl([genericOAuth({ config: [config] })]);

    expect(url.origin).toBe('https://ghe.example.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(`${GATEWAY}/api/auth/callback/github`);
    expect(url.searchParams.get('scope')?.split(/[ ,]/)).toEqual(
      expect.arrayContaining(['read:user', 'user:email'])
    );
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('still sends the browser to github.com when the base URL is github.com', async () => {
    const resolved = resolveGithubSignIn({
      ...CREDS,
      apiUrl: GITHUB_API,
      baseUrl: 'https://github.com',
    });
    if (resolved.mode !== 'builtin') {
      throw new Error('expected builtin mode');
    }

    const url = await authorizeUrl([], {
      github: { clientId: resolved.clientId, clientSecret: resolved.clientSecret },
    });

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
  });
});
