import { create } from 'zustand';
import { api } from '@/lib/api';

interface AuthState {
  user: { sub: string; role: string; email?: string; slackId?: string } | null;
  isAuthenticated: boolean;
  /** Legacy email+password sign-in via the hand-rolled /api/v1/auth/login.
   *  Kept for back-compat with pre-better-auth seeded users. Mints a JWT
   *  that lives in localStorage; subsequent API calls also send the
   *  better-auth session cookie automatically (credentials: 'include'),
   *  but the gateway prefers the bearer when both are present. */
  login: (email: string, password: string) => Promise<void>;
  /** Resolve the active session from a better-auth cookie. Used after the
   *  social / magic-link callback lands back on /login?bridge=1 — no JWT
   *  is minted; instead the gateway authenticates every subsequent API
   *  call by reading the session cookie via credentials: 'include'. */
  hydrateFromSession: () => Promise<boolean>;
  /** Kick off the OAuth dance for the given provider. The browser navigates
   *  away to the provider's auth screen and returns via the callback URL
   *  (which lands back on /login → hydrateFromSession). */
  signInWithProvider: (provider: 'github' | 'google') => void;
  /** Request a magic link be emailed to `email`. In dev (and on transport
   *  failures) the link is logged to gateway stdout. */
  requestMagicLink: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Reconcile UI auth state with the local credential picture: prefer a
   *  valid JWT in localStorage; failing that, ask the gateway whether the
   *  caller has an active better-auth session. */
  checkAuth: () => Promise<void>;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
/** Lifetime of the proxy-visible marker cookie. Just long enough to span
 *  a typical session — actual auth always re-verifies against the gateway. */
const MARKER_TTL_SECONDS = 60 * 60 * 24 * 7;
const MARKER_COOKIE = 'web-session-active';

function setLegacyTokenCookie(token: string): void {
  if (typeof window === 'undefined') return;
  const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: same-origin cookie read by the Next.js proxy to gate routes; gateway re-verifies the JWT.
  document.cookie = `accessToken=${token}; path=/; max-age=3600; SameSite=Lax${isSecure}`;
}

function setSessionMarkerCookie(): void {
  if (typeof window === 'undefined') return;
  const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: presence-only marker for the Next.js proxy; the real session cookie lives on the gateway origin.
  document.cookie = `${MARKER_COOKIE}=1; path=/; max-age=${MARKER_TTL_SECONDS}; SameSite=Lax${isSecure}`;
}

function clearAllAuthCookies(): void {
  if (typeof window === 'undefined') return;
  // biome-ignore lint/suspicious/noDocumentCookie: clearing the same cookies set above.
  document.cookie = 'accessToken=; path=/; max-age=0';
  // biome-ignore lint/suspicious/noDocumentCookie: clearing the same cookies set above.
  document.cookie = `${MARKER_COOKIE}=; path=/; max-age=0`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 segments');
  return JSON.parse(atob(parts[1]));
}

/** Shape of the relevant subset of better-auth's get-session response. */
interface BetterAuthSessionResponse {
  session?: { id: string; expiresAt: string };
  user?: {
    id: string;
    email?: string;
    role?: string;
    slackId?: string | null;
  };
}

async function fetchBetterAuthSession(): Promise<AuthState['user']> {
  const res = await fetch(`${API_BASE}/api/auth/get-session`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as BetterAuthSessionResponse | null;
  if (!body?.user) return null;
  return {
    role: body.user.role ?? 'ENGINEER',
    sub: body.user.id,
    ...(body.user.email ? { email: body.user.email } : {}),
    ...(body.user.slackId ? { slackId: body.user.slackId } : {}),
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  checkAuth: async () => {
    // Path 1: valid JWT in localStorage → trust it (matches legacy behaviour
    // and avoids a network round-trip on app load when the user just
    // refreshed mid-session).
    const token = api.getToken();
    if (token) {
      try {
        const payload = decodeJwtPayload(token);
        if ((payload.exp as number) * 1000 > Date.now()) {
          set({ isAuthenticated: true, user: payload as AuthState['user'] });
          return;
        }
      } catch {
        /* fall through to the session probe */
      }
      api.clearToken();
    }

    // Path 2: probe the gateway for a better-auth session. credentials:
    // 'include' sends the cross-origin session cookie if one exists.
    const user = await fetchBetterAuthSession();
    if (user) {
      setSessionMarkerCookie();
      set({ isAuthenticated: true, user });
      return;
    }

    clearAllAuthCookies();
    set({ isAuthenticated: false, user: null });
  },

  hydrateFromSession: async () => {
    const user = await fetchBetterAuthSession();
    if (!user) return false;
    setSessionMarkerCookie();
    set({ isAuthenticated: true, user });
    return true;
  },
  isAuthenticated: false,

  login: async (email, password) => {
    const { data } = await api.post<{ data: { accessToken: string } }>('/api/v1/auth/login', {
      email,
      password,
    });
    api.setToken(data.accessToken);
    setLegacyTokenCookie(data.accessToken);
    set({
      isAuthenticated: true,
      user: decodeJwtPayload(data.accessToken) as AuthState['user'],
    });
  },

  logout: async () => {
    // Clear the better-auth session on the gateway (best-effort — local
    // state is wiped regardless so the UI never gets stuck on a stale
    // identity).
    try {
      await fetch(`${API_BASE}/api/auth/sign-out`, { credentials: 'include', method: 'POST' });
    } catch {
      /* ignore */
    }
    api.clearToken();
    clearAllAuthCookies();
    set({ isAuthenticated: false, user: null });
  },

  requestMagicLink: async (email) => {
    const res = await fetch(`${API_BASE}/api/auth/sign-in/magic-link`, {
      body: JSON.stringify({
        callbackURL: `${typeof window !== 'undefined' ? window.location.origin : ''}/login?bridge=1`,
        email,
      }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(errBody?.message ?? 'Failed to request magic link');
    }
  },

  signInWithProvider: (provider) => {
    if (typeof window === 'undefined') return;
    const callbackURL = `${window.location.origin}/login?bridge=1`;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${API_BASE}/api/auth/sign-in/social`;
    const providerInput = document.createElement('input');
    providerInput.name = 'provider';
    providerInput.value = provider;
    form.appendChild(providerInput);
    const callbackInput = document.createElement('input');
    callbackInput.name = 'callbackURL';
    callbackInput.value = callbackURL;
    form.appendChild(callbackInput);
    document.body.appendChild(form);
    form.submit();
  },
  user: null,
}));
