/**
 * CLI environment + auth resolution.
 *
 * Auth is `AUTO_SWE_TOKEN` only — a personal access token (`ats_*`, minted
 * at Settings → API tokens in the dashboard) or any bearer the gateway
 * accepts. The legacy `AUTO_SWE_USERNAME`/`AUTO_SWE_PASSWORD` exchange was
 * removed along with the hand-rolled /auth/login endpoint (ARCH-4) —
 * password sign-in is a browser flow via better-auth now. Tokens are NOT
 * cached on disk — re-read per process.
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
  if (process.env.AUTO_SWE_USERNAME || process.env.AUTO_SWE_PASSWORD) {
    throw new Error(
      'AUTO_SWE_USERNAME/AUTO_SWE_PASSWORD are no longer supported — mint a personal access token at Settings → API tokens and set AUTO_SWE_TOKEN.'
    );
  }
  throw new Error(
    'No credentials. Set AUTO_SWE_TOKEN (personal access token from Settings → API tokens).'
  );
}
