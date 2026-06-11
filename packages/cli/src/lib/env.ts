/**
 * CLI environment + auth resolution.
 *
 * Auth is `AUTO_SWE_TOKEN` only — a personal access token (`ats_*`, minted
 * at Settings → API tokens in the dashboard) or any bearer the gateway
 * accepts. Password sign-in is a browser flow via better-auth; the CLI is
 * token-only. Tokens are NOT cached on disk — re-read per process.
 */

export interface CliEnv {
  apiUrl: string;
  token: string;
}

export async function loadCliEnv(): Promise<CliEnv> {
  const apiUrl = (process.env.AUTO_SWE_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const raw = process.env.AUTO_SWE_TOKEN?.trim();
  if (raw) {
    return { apiUrl, token: raw };
  }
  throw new Error(
    'No credentials. Set AUTO_SWE_TOKEN (personal access token from Settings → API tokens).'
  );
}
