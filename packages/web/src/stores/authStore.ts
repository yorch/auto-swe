import { create } from 'zustand';
import { api } from '@/lib/api';

interface AuthState {
  user: { sub: string; role: string; email?: string; slackId?: string } | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  checkAuth: () => {
    const token = api.getToken();
    if (!token) {
      set({ isAuthenticated: false, user: null });
      return;
    }
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) {
        api.clearToken();
        set({ isAuthenticated: false, user: null });
        return;
      }
      set({ isAuthenticated: true, user: payload });
    } catch {
      api.clearToken();
      set({ isAuthenticated: false, user: null });
    }
  },
  isAuthenticated: false,

  login: async (email, password) => {
    const { data } = await api.post<{ data: { accessToken: string } }>('/api/v1/auth/login', {
      email,
      password,
    });
    api.setToken(data.accessToken);
    if (typeof window !== 'undefined') {
      const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
      // biome-ignore lint/suspicious/noDocumentCookie: Next.js middleware needs to read this cookie server-side; HttpOnly is impossible from client JS. Gateway verifies the JWT on every request — that's the real security boundary.
      document.cookie = `accessToken=${data.accessToken}; path=/; max-age=3600; SameSite=Lax${isSecure}`;
    }

    // Decode JWT payload client-side (signature is NOT verified here — the
    // gateway verifies on every request). Used only for display/role-gating in UI.
    let payload: Record<string, unknown>;
    try {
      const parts = data.accessToken.split('.');
      if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 segments');
      payload = JSON.parse(atob(parts[1]));
    } catch {
      throw new Error('Received an invalid access token from the server');
    }
    set({ isAuthenticated: true, user: payload as AuthState['user'] });
  },

  logout: () => {
    api.clearToken();
    if (typeof window !== 'undefined') {
      // biome-ignore lint/suspicious/noDocumentCookie: see login() — same cookie, server-readable by design.
      document.cookie = 'accessToken=; path=/; max-age=0';
    }
    set({ isAuthenticated: false, user: null });
  },
  user: null,
}));
