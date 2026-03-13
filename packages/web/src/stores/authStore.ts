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
  user: null,
  isAuthenticated: false,

  login: async (email, password) => {
    const { data } = await api.post<{ data: { accessToken: string; refreshToken: string } }>(
      '/api/v1/auth/login',
      { email, password },
    );
    api.setToken(data.accessToken);
    if (typeof window !== 'undefined') {
      localStorage.setItem('refreshToken', data.refreshToken);
      // Set cookie so Next.js middleware can detect auth on server-side navigation.
      // NOTE: HttpOnly cannot be set from client-side JS — this cookie is readable
      // by scripts. The gateway verifies the JWT on every API call, so the real
      // security boundary is server-side. Secure; ensures it is never sent over HTTP.
      const isSecure = window.location.protocol === 'https:' ? '; Secure' : '';
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
    set({ user: payload as any, isAuthenticated: true });
  },

  logout: () => {
    api.clearToken();
    if (typeof window !== 'undefined') {
      document.cookie = 'accessToken=; path=/; max-age=0';
    }
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: () => {
    const token = api.getToken();
    if (!token) {
      set({ user: null, isAuthenticated: false });
      return;
    }
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) {
        api.clearToken();
        set({ user: null, isAuthenticated: false });
        return;
      }
      set({ user: payload, isAuthenticated: true });
    } catch {
      api.clearToken();
      set({ user: null, isAuthenticated: false });
    }
  },
}));
