import crypto from 'node:crypto';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { GitHubTokenMissingError, resolveGitHubToken } from './githubAuth.js';

export { GitHubTokenMissingError };

/**
 * Verify GitHub webhook HMAC signature.
 * Returns true if the signature is valid.
 *
 * Handles malformed signatures gracefully — returns false instead of throwing
 * when buffer lengths differ (which would cause timingSafeEqual to throw).
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  // timingSafeEqual throws if buffers have different lengths.
  // A length mismatch means the signature is invalid.
  if (sigBuf.length !== expBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export interface GitHubRepoInfo {
  org: string;
  name: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  apiUrl: string;
}

type RawRepo = {
  owner: { login: string };
  name: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  html_url: string;
  url: string;
};

function mapRepo(r: RawRepo): GitHubRepoInfo {
  return {
    apiUrl: r.url,
    defaultBranch: r.default_branch,
    description: r.description,
    htmlUrl: r.html_url,
    language: r.language,
    name: r.name,
    org: r.owner.login,
  };
}

/**
 * List repositories accessible to the configured GitHub integration.
 * Uses installation repositories endpoint for GitHub App auth, or
 * user repos endpoint for PAT auth. Returns up to 100 repos.
 */
export async function listGitHubRepos(): Promise<GitHubRepoInfo[]> {
  const config = await resolveGitHubConfig();
  const token = await resolveGitHubToken(config);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'auto-swe/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const authMode = config.authMode ?? 'auto';
  const appConfigured =
    Boolean(config.appId) && Boolean(config.appPrivateKey) && Boolean(config.appInstallationId);
  const useApp = authMode === 'app' || (authMode === 'auto' && appConfigured);

  if (useApp) {
    const res = await fetch(`${config.apiUrl}/installation/repositories?per_page=100`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} listing installation repositories`);
    }
    const data = (await res.json()) as { repositories: RawRepo[] };
    return data.repositories.map(mapRepo);
  }

  const res = await fetch(`${config.apiUrl}/user/repos?type=all&per_page=100&sort=updated`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} listing user repositories`);
  }
  return ((await res.json()) as RawRepo[]).map(mapRepo);
}
