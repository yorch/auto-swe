// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_SESSION_MARKER } from '@/lib/config';
import { useAuthStore } from './authStore';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

/** Route the two calls checkAuth() makes: the session probe and the JWT bridge. */
function stubFetch(sessionResponse: Response | Error) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/get-session')) {
      if (sessionResponse instanceof Error) {
        throw sessionResponse;
      }
      return sessionResponse;
    }
    if (url.endsWith('/api/v1/auth/session-token')) {
      return jsonResponse(200, { data: { accessToken: 'jwt-1' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function hasMarkerCookie(): boolean {
  return document.cookie.split('; ').includes(`${COOKIE_SESSION_MARKER}=1`);
}

describe('authStore.checkAuth', () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: seeding the marker the proxy reads
    document.cookie = `${COOKIE_SESSION_MARKER}=1; path=/`;
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'u1' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // biome-ignore lint/suspicious/noDocumentCookie: test teardown
    document.cookie = `${COOKIE_SESSION_MARKER}=; path=/; max-age=0`;
  });

  it('keeps the session cookies on a 429 — a rate limit is not a sign-out', async () => {
    stubFetch(jsonResponse(429, { message: 'Too many requests' }));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(hasMarkerCookie()).toBe(true);
  });

  it('keeps the session cookies when the gateway is unreachable', async () => {
    stubFetch(new TypeError('Failed to fetch'));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(hasMarkerCookie()).toBe(true);
  });

  it('keeps the session cookies on a 5xx', async () => {
    stubFetch(jsonResponse(503));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(hasMarkerCookie()).toBe(true);
  });

  it('clears the session cookies on a 401', async () => {
    stubFetch(jsonResponse(401));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(hasMarkerCookie()).toBe(false);
  });

  it('clears the session cookies on a 200 without a user', async () => {
    stubFetch(jsonResponse(200, null));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(hasMarkerCookie()).toBe(false);
  });

  it('authenticates on a 200 with a user', async () => {
    stubFetch(
      jsonResponse(200, {
        session: { expiresAt: '2099-01-01T00:00:00.000Z', id: 's1' },
        user: { email: 'a@b.c', id: 'u2', isActive: true, role: 'LEAD' },
      })
    );

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user).toMatchObject({ role: 'LEAD', sub: 'u2' });
    expect(hasMarkerCookie()).toBe(true);
  });
});

describe('authStore.login hand-off to an MCP authorization', () => {
  const SESSION = {
    session: { expiresAt: '2099-01-01T00:00:00.000Z', id: 's1' },
    user: { email: 'a@b.c', id: 'u2', isActive: true, role: 'ENGINEER' },
  };

  function stubSignIn(signInBody: unknown) {
    const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/sign-in/email')) {
        return jsonResponse(200, signInBody);
      }
      if (url.endsWith('/api/auth/get-session')) {
        return jsonResponse(200, SESSION);
      }
      if (url.endsWith('/api/v1/auth/session-token')) {
        return jsonResponse(200, { data: { accessToken: 'jwt-1' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const signInBody = (spy: ReturnType<typeof stubSignIn>) => {
    const call = spy.mock.calls.find(([u]) => String(u).endsWith('/sign-in/email'));
    return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    // biome-ignore lint/suspicious/noDocumentCookie: test teardown
    document.cookie = `${COOKIE_SESSION_MARKER}=; path=/; max-age=0`;
  });

  it('sends the signed query with the sign-in and returns where the authorization continues', async () => {
    const spy = stubSignIn({
      redirect: true,
      url: 'http://localhost:3000/oauth/consent?client_id=c1',
    });

    const next = await useAuthStore.getState().login('a@b.c', 'pw', 'client_id=c1&sig=abc');

    expect(signInBody(spy)).toEqual({
      email: 'a@b.c',
      oauth_query: 'client_id=c1&sig=abc',
      password: 'pw',
    });
    expect(next).toBe('http://localhost:3000/oauth/consent?client_id=c1');
    // The dashboard session is still established before leaving.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(hasMarkerCookie()).toBe(true);
  });

  it('sends nothing extra, and returns null, for an ordinary sign-in', async () => {
    const spy = stubSignIn({ redirect: false, url: 'http://localhost:3000/ignored' });

    const next = await useAuthStore.getState().login('a@b.c', 'pw');

    expect(signInBody(spy)).toEqual({ email: 'a@b.c', password: 'pw' });
    expect(next).toBeNull();
  });

  it('never navigates to a URL that would run script', async () => {
    stubSignIn({ redirect: true, url: 'javascript:alert(1)' });
    expect(await useAuthStore.getState().login('a@b.c', 'pw', 'client_id=c1&sig=abc')).toBeNull();
  });
});

describe('authStore.signInWithProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Captures the body the sign-in request sends, and answers with a provider URL. */
  function captureSocialSignIn() {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/auth/sign-in/social')) {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse(200, { redirect: true, url: 'https://ghe.example.com/authorize' });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      })
    );
    vi.stubGlobal('location', { href: '', origin: 'https://app.example.com' });
    return bodies;
  }

  it('sends failures back to the login page instead of the gateway root', async () => {
    const bodies = captureSocialSignIn();

    await useAuthStore.getState().signInWithProvider('github');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.callbackURL).toBe('https://app.example.com/login?bridge=1');
    expect(bodies[0]?.errorCallbackURL).toBe('https://app.example.com/login');
  });

  it('keeps the provider and still navigates to the provider URL', async () => {
    const bodies = captureSocialSignIn();

    await useAuthStore.getState().signInWithProvider('github');

    expect(bodies[0]?.provider).toBe('github');
    expect(window.location.href).toBe('https://ghe.example.com/authorize');
  });
});
