import { API_BASE, COOKIE_ACCESS_TOKEN } from './config';
import { gatewayUnreachableMessage } from './networkErrors';

interface ApiError {
  code: string;
  message: string;
}

interface ApiErrorBody {
  error?: ApiError;
}

export class ApiClient {
  private accessToken: string | null = null;

  setToken(token: string) {
    this.accessToken = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem(COOKIE_ACCESS_TOKEN, token);
    }
  }

  getToken(): string | null {
    if (!this.accessToken && typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem(COOKIE_ACCESS_TOKEN);
    }
    return this.accessToken;
  }

  clearToken() {
    this.accessToken = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(COOKIE_ACCESS_TOKEN);
    }
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options.headers as Record<string, string>) ?? {}),
    };

    // `credentials: 'include'` sends the better-auth session cookie cross-
    // origin. The gateway's requireAuth tries the Authorization header first
    // (legacy JWT / PAT path) and falls back to the session cookie — so this
    // wrapper supports both auth modes without per-call branching.
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        credentials: 'include',
        headers,
      });
    } catch (err) {
      // Network-level failure (gateway down, CORS rejected, DNS failure, …)
      // Rewrap with a message that says exactly what wasn't reachable.
      const friendly = gatewayUnreachableMessage(err, API_BASE);
      if (friendly) throw new Error(friendly);
      throw err;
    }

    if (response.status === 401) {
      // Try the legacy refresh path. Only meaningful when a JWT was already
      // in play; for the better-auth cookie path a 401 means the session was
      // revoked / expired and the user has to sign back in.
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        headers.Authorization = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(`${API_BASE}${path}`, {
          ...options,
          credentials: 'include',
          headers,
        });
        if (!retryResponse.ok) {
          const err = await retryResponse.json().catch(() => ({}));
          throw new Error((err as ApiErrorBody).error?.message ?? `HTTP ${retryResponse.status}`);
        }
        return retryResponse.json();
      }
      this.clearToken();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      throw new Error('Session expired');
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error((err as ApiErrorBody).error?.message ?? `HTTP ${response.status}`);
    }

    return response.json();
  }

  private async tryRefresh(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        credentials: 'include',
        method: 'POST',
      });

      if (!response.ok) return false;

      const { data } = await response.json();
      this.setToken(data.accessToken);
      return true;
    } catch {
      return false;
    }
  }

  get<T>(path: string) {
    return this.fetch<T>(path);
  }

  post<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { body: JSON.stringify(body), method: 'POST' });
  }

  patch<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { body: JSON.stringify(body), method: 'PATCH' });
  }

  put<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { body: JSON.stringify(body), method: 'PUT' });
  }

  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
