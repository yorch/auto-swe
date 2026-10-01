import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGhesUserInfo } from './githubEnterpriseAuth.js';

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
    warn.mockRestore();
  });

  it('refuses the sign-in instead of throwing when the network fails', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));

    expect(await fetchGhesUserInfo('tok', API, HOST)).toBeNull();
  });
});
