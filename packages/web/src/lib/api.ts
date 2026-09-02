import { API_BASE, COOKIE_ACCESS_TOKEN } from './config';
import { gatewayUnreachableMessage } from './networkErrors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private tokenGeneration = 0;

  setToken(token: string) {
    this.accessToken = token;
    this.tokenGeneration++;
    if (typeof window !== 'undefined') {
      // biome-ignore lint/suspicious/noDocumentCookie: middleware-visible bearer token cookie for server-side admin guards.
      document.cookie = `${COOKIE_ACCESS_TOKEN}=${encodeURIComponent(token)}; path=/; max-age=3600; SameSite=Lax`;
    }
  }

  getToken(): string | null {
    return this.accessToken;
  }

  /**
   * Proactively exchange the better-auth session for a JWT and persist it in the
   * middleware-visible cookie. Useful on initial page load before the first
   * /api/v1/* call would otherwise trigger a lazy refresh.
   */
  refreshToken(): Promise<boolean> {
    return this.tryRefresh();
  }

  clearToken() {
    this.accessToken = null;
    this.tokenGeneration++;
    this.refreshPromise = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(COOKIE_ACCESS_TOKEN);
      // biome-ignore lint/suspicious/noDocumentCookie: clears the middleware-visible cookie on sign-out
      document.cookie = `${COOKIE_ACCESS_TOKEN}=; path=/; max-age=0`;
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
      // Only attempt JWT refresh when this request carried a token — a 401 on a
      // login attempt (wrong credentials) should surface as a normal API error
      // rather than triggering a redirect loop.
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
          if (retryResponse.status === 401) {
            this.expireSession();
          }
          if (!retryResponse.ok) {
            throw new Error(await this.extractErrorMessage(retryResponse));
          }
          return this.parseBody<T>(retryResponse);
        }
      }
      // JWT refresh failed or request used BetterAuth session only — session is gone.
      this.expireSession();
    }

    if (!response.ok) {
      throw new Error(await this.extractErrorMessage(response));
    }

    return this.parseBody<T>(response);
  }

  /**
   * Several gateway DELETE routes answer `204 No Content`. Calling `.json()` on
   * an empty body throws, which would reject the mutation *after* the server
   * already applied it — so the caller never runs its invalidation. Treat an
   * empty response as `undefined` instead.
   */
  private async parseBody<T>(res: Response): Promise<T> {
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  private expireSession(): never {
    this.clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }

  private async extractErrorMessage(res: Response): Promise<string> {
    const body: unknown = await res.json().catch(() => ({}));
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === 'string' &&
      body.error.message.length > 0
    ) {
      return body.error.message;
    }
    return `HTTP ${res.status}`;
  }

  private tryRefresh(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<boolean> {
    const generation = this.tokenGeneration;
    try {
      // ARCH-4: the legacy /auth/refresh rotation endpoint is gone. A fresh
      // bearer is minted from the live better-auth session via the bridge;
      // with no session this fails and the caller falls through to login.
      const response = await fetch(`${API_BASE}/api/v1/auth/session-token`, {
        credentials: 'include',
        method: 'POST',
      });

      if (!response.ok) {
        return false;
      }

      const payload: unknown = await response.json();
      if (
        !isRecord(payload) ||
        !isRecord(payload.data) ||
        typeof payload.data.accessToken !== 'string' ||
        payload.data.accessToken.length === 0
      ) {
        return false;
      }
      const accessToken = payload.data.accessToken;
      // Guard against any token change (logout or fresh login) that raced this
      // in-flight request — don't overwrite a token that's newer than ours.
      if (this.tokenGeneration !== generation) {
        return false;
      }
      this.setToken(accessToken);
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
