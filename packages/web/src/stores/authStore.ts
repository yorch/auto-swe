import { create } from 'zustand';
import { api } from '@/lib/api';

interface AuthState {
  user: { sub: string; role: string; email?: string; slackId?: string } | null;
  isAuthenticated: boolean;
  /** Legacy email+password sign-in via the hand-rolled /api/v1/auth/login.
   *  Kept for back-compat with pre-better-auth seeded users. */
  login: (email: string, password: string) => Promise<void>;
  /** Exchange a better-auth session cookie for a JWT the rest of /api/v1/*
   *  understands. Call this once after a social or magic-link sign-in
   *  completes. Returns true if a session was found and exchanged. */
  hydrateFromBetterAuthSession: () => Promise<boolean>;
  /** Kick off the OAuth dance for the given provider. The browser navigates
   *  away to the provider's auth screen and returns via the callback URL
   *  (which lands back on /login → hydrateFromBetterAuthSession). */
  signInWithProvider: (provider: 'github' | 'google') => void;
  /** Request a magic link be emailed to `email`. In dev the link is logged
   *  to the gateway stdout. Resolves with the better-auth response so the
   *  caller can surface "check your email" UI. */
  requestMagicLink: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

function setSessionCookie(token: string): void {
  if (typeof window === 'undefined') return;
  const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: Next.js proxy needs to read this cookie server-side; HttpOnly is impossible from client JS. Gateway verifies the JWT on every request — that's the real security boundary.
  document.cookie = `accessToken=${token}; path=/; max-age=3600; SameSite=Lax${isSecure}`;
}

function clearSessionCookie(): void {
  if (typeof window === 'undefined') return;
  // biome-ignore lint/suspicious/noDocumentCookie: see setSessionCookie() — same cookie, server-readable by design.
  document.cookie = 'accessToken=; path=/; max-age=0';
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 segments');
  return JSON.parse(atob(parts[1]));
}

export const useAuthStore = create<AuthState>((set) => ({
  checkAuth: () => {
    const token = api.getToken();
    if (!token) {
      set({ isAuthenticated: false, user: null });
      return;
    }
    try {
      const payload = decodeJwtPayload(token);
      if ((payload.exp as number) * 1000 < Date.now()) {
        api.clearToken();
        clearSessionCookie();
        set({ isAuthenticated: false, user: null });
        return;
      }
      set({ isAuthenticated: true, user: payload as AuthState['user'] });
    } catch {
      api.clearToken();
      clearSessionCookie();
      set({ isAuthenticated: false, user: null });
    }
  },

  hydrateFromBetterAuthSession: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/session-token`, {
        // The better-auth session cookie lives on the gateway origin; sending
        // it requires credentials: 'include' on the cross-origin fetch.
        credentials: 'include',
        method: 'POST',
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { data: { accessToken: string } };
      api.setToken(body.data.accessToken);
      setSessionCookie(body.data.accessToken);
      set({
        isAuthenticated: true,
        user: decodeJwtPayload(body.data.accessToken) as AuthState['user'],
      });
      return true;
    } catch {
      return false;
    }
  },
  isAuthenticated: false,

  login: async (email, password) => {
    const { data } = await api.post<{ data: { accessToken: string } }>('/api/v1/auth/login', {
      email,
      password,
    });
    api.setToken(data.accessToken);
    setSessionCookie(data.accessToken);
    set({
      isAuthenticated: true,
      user: decodeJwtPayload(data.accessToken) as AuthState['user'],
    });
  },

  logout: async () => {
    // Tell the gateway to clear the better-auth session cookie too. If it
    // fails (no session, network issue) we still clear local state.
    try {
      await fetch(`${API_BASE}/api/auth/sign-out`, { credentials: 'include', method: 'POST' });
    } catch {
      /* ignore */
    }
    api.clearToken();
    clearSessionCookie();
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
    // The browser is redirected to better-auth's OAuth-initiate endpoint,
    // which 302s onward to the provider. After the user authorises, the
    // provider redirects back to {BETTER_AUTH_URL}/api/auth/callback/{provider},
    // better-auth sets the session cookie, then redirects to callbackURL.
    const callbackURL = `${window.location.origin}/login?bridge=1`;
    const url = new URL(`${API_BASE}/api/auth/sign-in/social`);
    url.searchParams.set('provider', provider);
    url.searchParams.set('callbackURL', callbackURL);
    // Better-auth expects this as a POST with JSON body — but for browser
    // redirect we hit a form-encoded POST. Easier: navigate to a GET helper
    // url that better-auth also accepts on /sign-in/social/{provider}.
    // For maximum compat: do a POST via a tiny dynamically-created form.
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
