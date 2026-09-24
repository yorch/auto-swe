import type { Role } from '@auto-swe/shared';
import { roleMeets } from '@auto-swe/shared/config/permissions';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  COOKIE_ACCESS_TOKEN,
  COOKIE_SESSION_MARKER,
  PATHNAME_HEADER,
  SEARCH_HEADER,
} from '@/lib/config';
import { apiInternalUrl } from '@/lib/env';

interface SessionUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
}

/**
 * What the server-side session check learned. The cases are kept apart because
 * they call for different responses: `no-token` / `unauthorized` mean the
 * short-lived bearer is missing or expired (the longer-lived better-auth
 * session may still be fine), while `unavailable` means the gateway could not
 * answer at all (down, 429, 5xx) and says nothing about who the caller is.
 */
export type SessionCheck =
  | { status: 'ok'; user: SessionUser }
  | { status: 'no-token' }
  | { status: 'unauthorized' }
  | { status: 'forbidden' }
  | { status: 'unavailable'; detail: string };

export async function checkSession(): Promise<SessionCheck> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_ACCESS_TOKEN)?.value;

  if (!token) {
    return { status: 'no-token' };
  }

  // Server-side: this runs inside the web container, where the browser-facing
  // API URL (often http://localhost:8080) points at the container's own
  // loopback. API_INTERNAL_URL names the gateway on the compose network.
  let res: Response;
  try {
    res = await fetch(`${apiInternalUrl()}/api/v1/auth/me`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { detail: 'The gateway is unreachable.', status: 'unavailable' };
  }

  if (res.status === 401) {
    return { status: 'unauthorized' };
  }
  if (res.status === 403) {
    return { status: 'forbidden' };
  }
  if (!res.ok) {
    return { detail: `The gateway answered HTTP ${res.status}.`, status: 'unavailable' };
  }

  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const user = json?.data as SessionUser | undefined;

  if (!user || typeof user.role !== 'string') {
    return { detail: 'The gateway returned an unexpected response.', status: 'unavailable' };
  }

  return { status: 'ok', user };
}

export async function getSession(): Promise<SessionUser | null> {
  const result = await checkSession();
  return result.status === 'ok' ? result.user : null;
}

/**
 * Where to send a request whose bearer is missing or expired. The access-token
 * cookie lives an hour; the better-auth session (signalled by the marker
 * cookie) lives a week. When the marker is present the session is probably
 * still good, so route through the login page's bridge, which re-mints the
 * bearer from the session and returns to `path` — instead of bouncing the user
 * to `/` as if they lacked the role.
 */
async function reauthUrl(): Promise<string> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  // The login page runs `redirect` through safeRedirectPath before using it.
  const path = `${headerStore.get(PATHNAME_HEADER) ?? '/'}${headerStore.get(SEARCH_HEADER) ?? ''}`;
  const params = new URLSearchParams({ redirect: path });
  if (cookieStore.get(COOKIE_SESSION_MARKER)?.value) {
    params.set('bridge', '1');
    params.set('reauth', '1');
  }
  return `/login?${params.toString()}`;
}

export type RoleCheck =
  | { status: 'ok'; user: SessionUser }
  | { status: 'unavailable'; detail: string };

/**
 * Gate a server-rendered subtree on a minimum role. Redirects to the login
 * bridge when the bearer is missing/expired, to `/` when the caller is signed
 * in but lacks the role (or is inactive), and returns `unavailable` — for the
 * caller to render as an error — when the gateway could not be asked, so an
 * outage is not dressed up as "you are not allowed here".
 */
export async function requireRole(allowed: Role[]): Promise<RoleCheck> {
  const result = await checkSession();

  if (result.status === 'no-token' || result.status === 'unauthorized') {
    redirect(await reauthUrl());
  }
  if (result.status === 'forbidden') {
    redirect('/');
  }
  if (result.status === 'unavailable') {
    return result;
  }
  if (!(result.user.isActive && allowed.some((r) => roleMeets(result.user.role, r)))) {
    redirect('/');
  }
  return result;
}
