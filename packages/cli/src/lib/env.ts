/**
 * CLI environment + auth resolution.
 *
 * Resolution order for the bearer token:
 *   1. `AUTO_SWE_TOKEN` (raw JWT or phase-8 `ats_*` personal access token —
 *      the gateway accepts both formats transparently)
 *   2. `AUTO_SWE_USERNAME` + `AUTO_SWE_PASSWORD` (POST /auth/login)
 *
 * PATs are the recommended path for long-running CI integrations — they
 * survive the JWT's 1h TTL without re-logging in. The login fallback exists
 * so a CI cron can authenticate without copy-pasting a token. Tokens are NOT
 * cached on disk — re-derived per process.
 */

export interface CliEnv {
  apiUrl: string;
  token: string;
}

interface AuthLoginResponse {
  data?: { accessToken?: string };
  error?: { code?: string; message?: string };
}

export async function loadCliEnv(): Promise<CliEnv> {
  const apiUrl = (process.env.AUTO_SWE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const raw = process.env.AUTO_SWE_TOKEN?.trim();
  if (raw) {
    return { apiUrl, token: raw };
  }
  const username = process.env.AUTO_SWE_USERNAME?.trim();
  const password = process.env.AUTO_SWE_PASSWORD;
  if (username && password) {
    const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
      body: JSON.stringify({ email: username, password }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const data = (await res.json().catch(() => ({}))) as AuthLoginResponse;
    if (!res.ok || !data.data?.accessToken) {
      throw new Error(
        `Login failed: ${data.error?.message ?? `HTTP ${res.status}`} — set AUTO_SWE_TOKEN to skip login.`
      );
    }
    return { apiUrl, token: data.data.accessToken };
  }
  throw new Error('No credentials. Set AUTO_SWE_TOKEN, or AUTO_SWE_USERNAME + AUTO_SWE_PASSWORD.');
}
