import { z } from 'zod';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { API_BASE, COOKIE_ACCESS_TOKEN, COOKIE_SESSION_MARKER } from '@/lib/config';
import { gatewayUnreachableMessage } from '@/lib/networkErrors';

/**
 * Providers driven through better-auth's social routes. `okta` is registered
 * by the gateway's generic-OAuth plugin rather than a built-in adapter, but the
 * plugin merges it into the same `socialProviders` list — so sign-in, callback
 * and account-link all use the identical endpoints and this union is the only
 * place the distinction would have shown up.
 */
export type SocialProviderId = 'github' | 'google' | 'okta';

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
  signInWithProvider: (provider: SocialProviderId) => Promise<void>;
  /** Link an additional OAuth provider to the signed-in account. Same
   *  fetch-then-navigate dance as signInWithProvider, against better-auth's
   *  `link-social`; the round-trip lands back on /settings with the new
   *  Account row attached. Throws on failure. */
  linkProvider: (provider: SocialProviderId) => Promise<void>;
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

const BetterAuthErrorSchema = z.object({
  message: z.string().optional(),
});

const BetterAuthSessionResponseSchema = z.object({
  session: z
    .object({
      expiresAt: z.string(),
      id: z.string(),
    })
    .optional(),
  user: z
    .object({
      email: z.string().optional(),
      id: z.string(),
      isActive: z.boolean().optional(),
      role: z.string().optional(),
      slackId: z.string().nullable().optional(),
    })
    .optional(),
});

const BetterAuthRedirectSchema = z.object({
  url: z.string().optional(),
});

/**
 * Wrapper around `fetch` for better-auth POST endpoints. Folds three layers of
 * error handling into one place: (1) gateway-unreachable network failures get
 * a friendly message naming the API_BASE, (2) non-2xx responses surface the
 * server's `message` field, (3) the caller's `fallback` is used otherwise.
 * Returns the parsed response body (null when it isn't JSON).
 */
async function betterAuthPost(path: string, body: unknown, fallback: string): Promise<unknown> {
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
    const errBody: unknown = await res.json().catch(() => null);
    const parsed = BetterAuthErrorSchema.safeParse(errBody);
    throw new Error(parsed.success && parsed.data.message ? parsed.data.message : fallback);
  }
  return res.json().catch(() => null);
}

/**
 * POST to a better-auth OAuth endpoint that answers `{ url, redirect: true }`
 * (the social sign-in / account-link shape) and navigate the browser to the
 * returned provider URL. better-auth responds with JSON, not a 302 — the
 * client is expected to perform the navigation itself. `callbackPath` is
 * where the OAuth round-trip lands back on this app.
 */
async function betterAuthRedirect(
  path: string,
  provider: SocialProviderId,
  callbackPath: string,
  fallback: string
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }
  const body = { callbackURL: `${window.location.origin}${callbackPath}`, provider };
  const raw = await betterAuthPost(path, body, fallback);
  const parsed = BetterAuthRedirectSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.url) {
    throw new Error(fallback);
  }
  window.location.href = parsed.data.url;
}

/**
 * Outcome of the session probe. `anonymous` is positive evidence that there is
 * no session (401/403, or a 2xx without a user) and is the only outcome that
 * may clear the local auth cookies. `unknown` means the gateway could not
 * answer — a network failure, a 429 or a 5xx — and says nothing about whether
 * the session cookie is still valid, so callers must leave the cookies alone.
 */
type SessionProbe =
  | { status: 'authenticated'; user: NonNullable<AuthState['user']> }
  | { status: 'anonymous' }
  | { status: 'unknown' };

async function fetchBetterAuthSession(): Promise<SessionProbe> {
  // Probe call — never throw. Without this swallow the unhandled rejection
  // bubbles to React's error boundary and shows the dev-overlay "Failed to
  // fetch" crash; the login page surfaces its own gateway-offline banner.
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/get-session`, { credentials: 'include' });
  } catch {
    return { status: 'unknown' };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'anonymous' };
  }
  if (!res.ok) {
    return { status: 'unknown' };
  }
  const raw: unknown = await res.json().catch(() => null);
  const parsed = BetterAuthSessionResponseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.user) {
    return { status: 'anonymous' };
  }
  const { user } = parsed.data;
  return {
    status: 'authenticated',
    user: {
      // Default to true so a stale cache / pre-better-auth user (where
      // isActive may be missing from the response) renders as active.
      isActive: user.isActive ?? true,
      role: user.role ?? 'ENGINEER',
      sub: user.id,
      ...(user.email ? { email: user.email } : {}),
      ...(user.slackId ? { slackId: user.slackId } : {}),
    },
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  checkAuth: async () => {
    // The in-memory access token never survives a page reload, so there's no
    // local JWT left to trust on load — clear any stale legacy cookie/
    // localStorage remnants and go straight to the session probe below.
    api.clearToken();

    // Probe the gateway for a better-auth session. credentials: 'include'
    // sends the cross-origin session cookie if one exists.
    const probe = await fetchBetterAuthSession();
    if (probe.status === 'authenticated') {
      setSessionMarkerCookie();
      // Ensure a middleware-readable bearer token is available for server-side
      // admin route guards, not only after the first /api/v1/* call.
      await api.refreshToken().catch(() => {});
      set({ isAuthenticated: true, user: probe.user });
      return;
    }

    // Only positive evidence of "no session" may drop the cookies. A transient
    // 429 or 5xx must not log the user out — the session cookie is still
    // valid and the next probe will pick it up again.
    if (probe.status === 'anonymous') {
      clearAllAuthCookies();
    }
    set({ isAuthenticated: false, user: null });
  },

  hydrateFromSession: async () => {
    const probe = await fetchBetterAuthSession();
    if (probe.status !== 'authenticated') {
      return false;
    }
    setSessionMarkerCookie();
    await api.refreshToken().catch(() => {});
    set({ isAuthenticated: true, user: probe.user });
    return true;
  },
  isAuthenticated: false,

  linkProvider: async (provider) =>
    betterAuthRedirect(
      '/api/auth/link-social',
      provider,
      '/settings',
      `Could not link ${provider} account`
    ),

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
      const raw: unknown = await res.json().catch(() => null);
      const parsed = BetterAuthErrorSchema.safeParse(raw);
      throw new Error(
        parsed.success && parsed.data.message ? parsed.data.message : 'Invalid email or password'
      );
    }
    const probe = await fetchBetterAuthSession();
    if (probe.status !== 'authenticated') {
      throw new Error('Sign-in succeeded but no session was established — try again.');
    }
    setSessionMarkerCookie();
    await api.refreshToken();
    set({ isAuthenticated: true, user: probe.user });
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

  signInWithProvider: async (provider) =>
    betterAuthRedirect(
      '/api/auth/sign-in/social',
      provider,
      '/login?bridge=1',
      `Could not start ${provider} sign-in`
    ),
  user: null,
}));
