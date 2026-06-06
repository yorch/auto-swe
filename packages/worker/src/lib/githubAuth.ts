import { createSign } from 'node:crypto';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';

interface CachedInstallToken {
  token: string;
  expiresAt: number; // epoch ms
  configKey: string; // detects credential rotation
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

function configCacheKey(config: ResolvedGitHubConfig): string {
  // Use the last 20 chars of the private key so a key rotation busts the cache
  // without storing the full key in memory twice.
  return `${config.appId}|${config.appInstallationId}|${config.appPrivateKey?.slice(-20) ?? ''}`;
}

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

async function fetchInstallationToken(
  config: ResolvedGitHubConfig
): Promise<{ token: string; expiresAt: number }> {
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
  // Use GitHub's declared expiry minus a 60-second safety margin so we never
  // serve a token that has already expired or is about to expire mid-request.
  const expiresAt = new Date(data.expires_at).getTime() - 60_000;
  return { expiresAt, token: data.token };
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

/**
 * Like resolveGitHubToken but converts GitHubTokenMissingError into
 * ApplicationFailure.nonRetryable so Temporal does not burn retry budget
 * on a missing-config condition. Use this in all activity call sites.
 */
export async function requireGitHubToken(config: ResolvedGitHubConfig): Promise<string> {
  try {
    return await resolveGitHubToken(config);
  } catch (err) {
    if (err instanceof GitHubTokenMissingError) {
      throw ApplicationFailure.nonRetryable(
        `GitHub token not configured. Set it at /admin/integrations.`,
        'CONFIG_MISSING'
      );
    }
    throw err;
  }
}
