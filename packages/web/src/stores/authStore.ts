import { create } from 'zustand';
import { api } from '@/lib/api';
import { API_BASE, COOKIE_ACCESS_TOKEN, COOKIE_SESSION_MARKER } from '@/lib/config';
import { gatewayUnreachableMessage } from '@/lib/networkErrors';

interface AuthState {
  user: {
    sub: string;
    role: string;
    email?: string;
    slackId?: string;
    /** Approval-queue flag. New social / magic-link sign-ups land with
     *  isActive=false and need an admin to flip them. Login page renders
     *  a pending screen instead of routing into the app. */
    isActive?: boolean;
  } | null;
  isAuthenticated: boolean;
  /** Email+password sign-in via better-auth (`/api/auth/sign-in/email`).
   *  Establishes the session cookie; subsequent API calls authenticate via
   *  `credentials: 'include'` exactly like the social / magic-link flows.
   *  (ARCH-4: the legacy hand-rolled /api/v1/auth/login was removed.) */
  login: (email: string, password: string) => Promise<void>;
  /** Resolve the active session from a better-auth cookie. Used after the
   *  social / magic-link callback lands back on /login?bridge=1 — no JWT
   *  is minted; instead the gateway authenticates every subsequent API
   *  call by reading the session cookie via credentials: 'include'. */
  hydrateFromSession: () => Promise<boolean>;
  /** Kick off the OAuth dance for the given provider. better-auth's
   *  `sign-in/social` returns `{ url, redirect: true }` — we navigate the
   *  browser to that provider auth URL; the round-trip lands back on
   *  /login?bridge=1 → hydrateFromSession. Throws on failure so the login
   *  page can surface the error. */
  signInWithProvider: (provider: 'github' | 'google') => Promise<void>;
  /** Request a magic link be emailed to `email`. In dev (and on transport
   *  failures) the link is logged to gateway stdout. */
  requestMagicLink: (email: string) => Promise<void>;
  /** Request a password-reset email. Same multi-transport delivery as
   *  magic links. The link in the email lands at `/reset-password?token=…`. */
  requestPasswordReset: (email: string) => Promise<void>;
  /** Finish the password-reset flow: submit a new password + the token from
   *  the email URL. Logs the user in afterwards via auto-sign-in. */
  resetPassword: (token: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Reconcile UI auth state with the local credential picture: prefer a
   *  valid JWT in localStorage; failing that, ask the gateway whether the
   *  caller has an active better-auth session. */
  checkAuth: () => Promise<void>;
}

/** Lifetime of the proxy-visible marker cookie. Just long enough to span
 *  a typical session — actual auth always re-verifies against the gateway. */
const MARKER_TTL_SECONDS = 60 * 60 * 24 * 7;

function setSessionMarkerCookie(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: presence-only marker for the Next.js proxy; the real session cookie lives on the gateway origin.
  document.cookie = `${COOKIE_SESSION_MARKER}=1; path=/; max-age=${MARKER_TTL_SECONDS}; SameSite=Lax${isSecure}`;
}

function clearAllAuthCookies(): void {
  if (typeof window === 'undefined') {
    return;
  }
  // biome-ignore lint/suspicious/noDocumentCookie: clearing the same cookies set above.
  document.cookie = `${COOKIE_ACCESS_TOKEN}=; path=/; max-age=0`;
  // biome-ignore lint/suspicious/noDocumentCookie: clearing the same cookies set above.
  document.cookie = `${COOKIE_SESSION_MARKER}=; path=/; max-age=0`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT: expected 3 segments');
  }
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
    isActive?: boolean;
  };
}

/**
 * Wrapper around `fetch` for better-auth POST endpoints. Folds three layers of
 * error handling into one place: (1) gateway-unreachable network failures get
 * a friendly message naming the API_BASE, (2) non-2xx responses surface the
 * server's `message` field, (3) the caller's `fallback` is used otherwise.
 */
async function betterAuthPost(path: string, body: unknown, fallback: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      body: JSON.stringify(body),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch (err) {
    const friendly = gatewayUnreachableMessage(err, API_BASE);
    throw new Error(friendly ?? fallback);
  }
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errBody?.message ?? fallback);
  }
}

async function fetchBetterAuthSession(): Promise<AuthState['user']> {
  // Probe call — never throw. A network failure here just means "no session"
  // from the UI's perspective; the user lands on /login and the page itself
  // surfaces a friendly banner if the gateway is unreachable. Without this
  // swallow, the unhandled rejection bubbles to React's error boundary and
  // shows the dev-overlay "Failed to fetch" crash.
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/get-session`, { credentials: 'include' });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const body = (await res.json().catch(() => null)) as BetterAuthSessionResponse | null;
  if (!body?.user) {
    return null;
  }
  return {
    // Default to true so a stale cache / pre-better-auth user (where
    // isActive may be missing from the response) renders as active.
    isActive: body.user.isActive ?? true,
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
    if (!user) {
      return false;
    }
    setSessionMarkerCookie();
    set({ isAuthenticated: true, user });
    return true;
  },
  isAuthenticated: false,

  login: async (email, password) => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
    } catch (err) {
      throw new Error(
        gatewayUnreachableMessage(err, API_BASE) ?? 'Sign-in failed — gateway unreachable.'
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? 'Invalid email or password');
    }
    const user = await fetchBetterAuthSession();
    if (!user) {
      throw new Error('Sign-in succeeded but no session was established — try again.');
    }
    setSessionMarkerCookie();
    set({ isAuthenticated: true, user });
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
    await betterAuthPost(
      '/api/auth/sign-in/magic-link',
      {
        callbackURL: `${typeof window !== 'undefined' ? window.location.origin : ''}/login?bridge=1`,
        email,
      },
      'Failed to request magic link'
    );
  },

  requestPasswordReset: async (email) => {
    await betterAuthPost(
      '/api/auth/forget-password',
      {
        email,
        redirectTo: `${typeof window !== 'undefined' ? window.location.origin : ''}/reset-password`,
      },
      'Failed to request password reset'
    );
  },

  resetPassword: async (token, newPassword) => {
    await betterAuthPost(
      '/api/auth/reset-password',
      { newPassword, token },
      'Failed to reset password'
    );
  },

  signInWithProvider: async (provider) => {
    if (typeof window === 'undefined') {
      return;
    }
    // JSON fetch, not a form POST: the gateway only parses application/json
    // bodies on /api/auth/*, and better-auth answers with JSON rather than a
    // 302 — the client is expected to perform the navigation itself.
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/auth/sign-in/social`, {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/login?bridge=1`,
          provider,
        }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
    } catch (err) {
      throw new Error(
        gatewayUnreachableMessage(err, API_BASE) ?? `Could not start ${provider} sign-in`
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `Could not start ${provider} sign-in`);
    }
    const data = (await res.json().catch(() => null)) as { url?: string } | null;
    if (!data?.url) {
      throw new Error(`${provider} sign-in did not return a redirect URL`);
    }
    window.location.href = data.url;
  },
  user: null,
}));
