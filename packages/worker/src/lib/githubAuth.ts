import { createAppAuth } from '@octokit/auth-app';

interface CachedToken {
  token: string;
  expiresAt: Date;
}

const tokenCache = new Map<number, CachedToken>();

function decodePrivateKey(raw: string): string {
  if (raw.includes('-----BEGIN')) return raw;
  // Accept base64-encoded PEM — common when storing multiline secrets in CI/CD env vars.
  return Buffer.from(raw, 'base64').toString('utf-8');
}

/**
 * Returns a short-lived GitHub installation token (GitHub App) or a PAT,
 * depending on which credentials are configured.
 *
 * Resolution order:
 *   1. GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) — generates a
 *      60-minute installation token scoped to the given installation, cached
 *      until 5 minutes before expiry to avoid mid-workflow races.
 *   2. PAT (GITHUB_TOKEN) — used as-is when App env vars are absent.
 *
 * @param installationId  Per-repo GitHub App installation ID (Repository.githubAppInstallationId).
 *   Falls back to GITHUB_APP_INSTALLATION_ID env var when null/undefined.
 */
export async function getGitHubToken(installationId?: number | null): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    const pat = process.env.GITHUB_TOKEN;
    if (!pat) {
      throw new Error(
        'No GitHub credentials configured. Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.'
      );
    }
    return pat;
  }

  const instId = installationId ?? Number(process.env.GITHUB_APP_INSTALLATION_ID ?? '');
  if (!instId) {
    throw new Error(
      'GitHub App auth requires an installation ID. Set GITHUB_APP_INSTALLATION_ID or configure githubAppInstallationId on the Repository.'
    );
  }

  const cached = tokenCache.get(instId);
  if (cached && cached.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const auth = createAppAuth({
    appId: Number(appId),
    installationId: instId,
    privateKey: decodePrivateKey(privateKey),
  });

  const result = await auth({ type: 'installation' });
  tokenCache.set(instId, {
    expiresAt: new Date(result.expiresAt),
    token: result.token,
  });

  return result.token;
}
