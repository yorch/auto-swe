import { create } from 'zustand';
import { api } from '@/lib/api';

interface AuthState {
  user: { sub: string; role: string; email?: string } | null;
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
      // Set cookie so Next.js middleware can detect auth on server-side navigation
      document.cookie = `accessToken=${data.accessToken}; path=/; max-age=3600; SameSite=Lax`;
    }

    // Decode JWT payload (base64)
    const payload = JSON.parse(atob(data.accessToken.split('.')[1]));
    set({ user: payload, isAuthenticated: true });
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
