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
