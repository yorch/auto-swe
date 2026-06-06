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
  private refreshPromise: Promise<boolean> | null = null;
  private tokenGeneration = 0;

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
    this.tokenGeneration++;
    this.refreshPromise = null;
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
      if (friendly) {
        throw new Error(friendly);
      }
      throw err;
    }

    if (response.status === 401) {
      // Only attempt refresh when this request carried a token — a 401 on an
      // unauthenticated call (e.g. the login endpoint for wrong credentials)
      // means bad credentials, not an expired session, and should surface as a
      // normal API error rather than a redirect loop.
      if (token) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          headers.Authorization = `Bearer ${this.accessToken}`;
          const retryResponse = await fetch(`${API_BASE}${path}`, {
            ...options,
            credentials: 'include',
            headers,
          });
          // A 401 on the retry means the new token was also rejected — log out.
          if (retryResponse.status === 401) this.expireSession();
          if (!retryResponse.ok) {
            throw new Error(await this.extractErrorMessage(retryResponse));
          }
          return retryResponse.json();
        }
        this.expireSession();
      }
      // No token on the original request — fall through to the generic error path.
    }

    if (!response.ok) {
      throw new Error(await this.extractErrorMessage(response));
    }

    return response.json();
  }

  private expireSession(): never {
    this.clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }

  private async extractErrorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => ({}));
    return (body as ApiErrorBody).error?.message ?? `HTTP ${res.status}`;
  }

  private tryRefresh(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = this._doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<boolean> {
    const generation = this.tokenGeneration;
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        credentials: 'include',
        method: 'POST',
      });

      if (!response.ok) {
        return false;
      }

      const { data } = await response.json();
      if (!data?.accessToken) {
        return false;
      }
      // Guard against clearToken() (logout) racing with this in-flight request —
      // don't restore a token for a user who logged out while we were fetching.
      if (this.tokenGeneration !== generation) {
        return false;
      }
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
