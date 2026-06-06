import { createSign } from 'node:crypto';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';

interface CachedInstallToken {
  token: string;
  expiresAt: number; // epoch ms
}

let _cachedInstallToken: CachedInstallToken | null = null;

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: now + 600, iat: now - 60, iss: appId })
  ).toString('base64url');
  const signing = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${signing}.${sig}`;
}

async function fetchInstallationToken(config: ResolvedGitHubConfig): Promise<string> {
  const { appId, appPrivateKey, appInstallationId, apiUrl } = config;
  if (!appId || !appPrivateKey || !appInstallationId) {
    throw new Error(
      'GitHub App auth requires appId, appPrivateKey, and appInstallationId to all be configured'
    );
  }
  const jwt = createGitHubAppJwt(appId, appPrivateKey);
  const res = await fetch(`${apiUrl}/app/installations/${appInstallationId}/access_tokens`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'auto-swe/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub App installation token request failed: ${res.status} ${body.message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  return data.token;
}

export async function resolveGitHubToken(config: ResolvedGitHubConfig): Promise<string> {
  const mode = config.authMode ?? 'auto';

  const appConfigured =
    Boolean(config.appId) && Boolean(config.appPrivateKey) && Boolean(config.appInstallationId);

  const useApp = mode === 'app' || (mode === 'auto' && appConfigured);

  if (useApp) {
    const now = Date.now();
    if (_cachedInstallToken && now < _cachedInstallToken.expiresAt) {
      return _cachedInstallToken.token;
    }
    const token = await fetchInstallationToken(config);
    _cachedInstallToken = { expiresAt: now + 50 * 60 * 1000, token };
    return token;
  }

  if (config.token) {
    return config.token;
  }

  throw new Error(
    'No GitHub token configured: set a PAT or configure GitHub App (appId + privateKey + installationId)'
  );
}
