import { createSign } from 'node:crypto';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';

interface CachedInstallToken {
  token: string;
  expiresAt: number;
  configKey: string;
}

let _cachedInstallToken: CachedInstallToken | null = null;

export class GitHubTokenMissingError extends Error {
  constructor() {
    super(
      'No GitHub token configured: set a PAT or configure GitHub App (appId + privateKey + installationId)'
    );
    this.name = 'GitHubTokenMissingError';
  }
}

function configCacheKey(c: ResolvedGitHubConfig): string {
  return `${c.appId}|${c.appInstallationId}|${c.appPrivateKey?.slice(-20) ?? ''}`;
}

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: now + 600, iat: now - 60, iss: appId })
  ).toString('base64url');
  const signing = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  return `${signing}.${signer.sign(privateKey).toString('base64url')}`;
}

async function fetchInstallationToken(
  config: ResolvedGitHubConfig
): Promise<{ token: string; expiresAt: number }> {
  const { appId, appPrivateKey, appInstallationId, apiUrl } = config;
  if (!appId || !appPrivateKey || !appInstallationId) {
    throw new Error('GitHub App auth requires appId, appPrivateKey, and appInstallationId');
  }
  const res = await fetch(`${apiUrl}/app/installations/${appInstallationId}/access_tokens`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${createJwt(appId, appPrivateKey)}`,
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
  return { expiresAt: new Date(data.expires_at).getTime() - 60_000, token: data.token };
}

export async function resolveGitHubToken(config: ResolvedGitHubConfig): Promise<string> {
  const mode = config.authMode ?? 'auto';
  const appConfigured =
    Boolean(config.appId) && Boolean(config.appPrivateKey) && Boolean(config.appInstallationId);
  const useApp = mode === 'app' || (mode === 'auto' && appConfigured);

  if (useApp) {
    const now = Date.now();
    const key = configCacheKey(config);
    if (
      _cachedInstallToken &&
      now < _cachedInstallToken.expiresAt &&
      _cachedInstallToken.configKey === key
    ) {
      return _cachedInstallToken.token;
    }
    const { token, expiresAt } = await fetchInstallationToken(config);
    _cachedInstallToken = { configKey: key, expiresAt, token };
    return token;
  }

  if (config.token) {
    return config.token;
  }

  throw new GitHubTokenMissingError();
}
