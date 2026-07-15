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

/** Page size used by every paginated GitHub REST call in this module. */
const PER_PAGE = 100;
/** Hard cap on pages fetched per call — bounds worst-case request fan-out. */
const MAX_PAGES = 5;

/**
 * Fetch up to `MAX_PAGES` pages (`per_page=PER_PAGE`) from a paginated GitHub
 * REST list endpoint, stopping as soon as a page returns fewer than
 * `PER_PAGE` items (no more pages left). `urlForPage` builds the request URL
 * for a given 1-indexed page; `extractItems` pulls the items array out of the
 * (possibly wrapped) JSON body.
 */
async function fetchAllPages<T>(
  urlForPage: (page: number) => string,
  headers: Record<string, string>,
  extractItems: (body: unknown) => T[],
  errorContext: string
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(urlForPage(page), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} ${errorContext}`);
    }
    const pageItems = extractItems(await res.json());
    items.push(...pageItems);
    if (pageItems.length < PER_PAGE) {
      break;
    }
  }
  return items;
}

/**
 * List repositories accessible to the configured GitHub integration.
 * Uses installation repositories endpoint for GitHub App auth, or
 * user repos endpoint for PAT auth. Paginates up to `MAX_PAGES` pages of
 * `PER_PAGE` repos each — up to 500 repos.
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
    const repos = await fetchAllPages<RawRepo>(
      (page) => `${config.apiUrl}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      headers,
      (body) => (body as { repositories: RawRepo[] }).repositories,
      'listing installation repositories'
    );
    return repos.map(mapRepo);
  }

  const repos = await fetchAllPages<RawRepo>(
    (page) => `${config.apiUrl}/user/repos?type=all&per_page=${PER_PAGE}&sort=updated&page=${page}`,
    headers,
    (body) => body as RawRepo[],
    'listing user repositories'
  );
  return repos.map(mapRepo);
}
