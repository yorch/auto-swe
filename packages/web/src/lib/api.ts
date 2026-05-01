const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

interface ApiError {
  code: string;
  message: string;
}

export class ApiClient {
  private accessToken: string | null = null;

  setToken(token: string) {
    this.accessToken = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', token);
    }
  }

  getToken(): string | null {
    if (!this.accessToken && typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
    }
    return this.accessToken;
  }

  clearToken() {
    this.accessToken = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
    }
  }

  async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string> ?? {}),
    };

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      // Try refresh
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        headers.Authorization = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (!retryResponse.ok) {
          const err = await retryResponse.json().catch(() => ({}));
          throw new Error((err as any).error?.message ?? `HTTP ${retryResponse.status}`);
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
      throw new Error((err as any).error?.message ?? `HTTP ${response.status}`);
    }

    return response.json();
  }

  private async tryRefresh(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) return false;

      const { data } = await response.json();
      this.setToken(data.accessToken);
      return true;
    } catch {
      return false;
    }
  }

  // ── Convenience Methods ──

  get<T>(path: string) {
    return this.fetch<T>(path);
  }

  post<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown) {
    return this.fetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
