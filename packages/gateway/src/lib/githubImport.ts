import { resolvePlatformCredential } from '@auto-swe/shared/lib/githubHostCredential';
import {
  defaultApiUrlForHost,
  GITHUB_SCM_PROVIDER,
  hostFamily,
} from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { lookupRepoPermission, verifiedGithubLoginFor } from '@auto-swe/shared/lib/repoPermission';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { type GitHubRepoInfo, listGitHubRepos } from './github.js';
import { defaultGitHubInstallation } from './installationOrganization.js';
import { repositoryManagementTeams } from './tenantScope.js';

export const IMPORT_ACCESS_LOOKUP_CAP = 100;
export const IMPORT_CACHE_TTL_MS = 180_000;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

type Installation = { id: string; installationId: string; host: string; accountLogin: string };
export interface ImportSource {
  installationId: string | null;
  installationAccount: string | null;
  githubUrl: string;
  githubApiUrl: string;
  error?: string;
}
export interface ImportableRepo extends GitHubRepoInfo {
  installationId: string | null;
  installationAccount: string | null;
  githubUrl: string | null;
  githubApiUrl: string | null;
  access: 'readable' | 'unchecked';
  alreadyImported: boolean;
}
interface RawRepo {
  owner: { login: string };
  name: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  html_url: string;
  url: string;
}
interface Cached<T> {
  value: T;
  expiresAt: number;
}
const listings = new Map<string, Cached<GitHubRepoInfo[]>>();
const access = new Map<string, Cached<boolean | 'unchecked'>>();

function read<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value;
  }
  cache.delete(key);
  return undefined;
}
function write<T>(cache: Map<string, Cached<T>>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + IMPORT_CACHE_TTL_MS, value });
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
}
export function clearGitHubImportCaches() {
  listings.clear();
  access.clear();
}

async function reposWithToken(apiUrl: string, path: string, token: string, wrapped: boolean) {
  const doFetch = createGuardedFetch({ allowPrivate: hostFamily(apiUrl) !== 'github.com' });
  const repos: GitHubRepoInfo[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await doFetch(
      `${apiUrl.replace(/\/$/, '')}${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'auto-swe/1.0',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      throw new Error('GitHub repository listing unavailable');
    }
    const body = await response.json();
    const rows = wrapped ? (body as { repositories: RawRepo[] }).repositories : (body as RawRepo[]);
    if (!Array.isArray(rows)) {
      throw new Error('Invalid GitHub repository listing');
    }
    repos.push(
      ...rows.map((r) => ({
        apiUrl: r.url,
        defaultBranch: r.default_branch,
        description: r.description,
        htmlUrl: r.html_url,
        language: r.language,
        name: r.name,
        org: r.owner.login,
      }))
    );
    if (rows.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  return { complete, repos };
}

export function repoImportKey(host: string, owner: string, name: string) {
  return `${hostFamily(host)}/${owner}/${name}`.toLowerCase();
}
function repoNameKey(repo: GitHubRepoInfo) {
  return `${repo.org}/${repo.name}`.toLowerCase();
}
function accountHost(accountId: string) {
  const match = /^(.*):\d+$/.exec(accountId);
  return match ? hostFamily(`https://${match[1]}`) : 'github.com';
}

export async function installationRepos(
  installation: Installation
): Promise<{ source: ImportSource; repos: GitHubRepoInfo[] }> {
  const config = await resolveGitHubConfig();
  const source: ImportSource = {
    githubApiUrl: installation.host ? defaultApiUrlForHost(installation.host) : config.apiUrl,
    githubUrl: installation.host ? `https://${installation.host}` : config.baseUrl,
    installationAccount: installation.accountLogin,
    installationId: installation.id,
  };
  const key = `${installation.id}:${installation.installationId}:${source.githubApiUrl}`;
  const hit = read(listings, key);
  if (hit) {
    return { repos: hit, source };
  }
  const credential = await resolvePlatformCredential(
    {
      apiUrl: source.githubApiUrl,
      baseUrl: source.githubUrl,
      installationHost: installation.host,
      installationId: installation.installationId,
      // Listings come from a GitHub installation; no other provider has one.
      scmProvider: GITHUB_SCM_PROVIDER,
    },
    config
  );
  if (credential.scope !== 'instance' && credential.scope !== 'host') {
    throw new Error('No credential for installation host');
  }
  const token = await resolveGitHubToken(
    { ...credential.config, authMode: 'app' },
    { apiUrl: source.githubApiUrl, installationId: installation.installationId }
  );
  const { repos } = await reposWithToken(
    source.githubApiUrl,
    '/installation/repositories',
    token,
    true
  );
  write(listings, key, repos, 100);
  return { repos, source };
}

export async function verifiedImportInstallation(
  prisma: FastifyInstance['prisma'],
  id: string,
  owner: string,
  name: string
) {
  const row = await prisma.gitHubInstallation.findUnique({ where: { id } });
  if (!row?.isActive) {
    return null;
  }
  const listing = await installationRepos(row);
  return listing.repos.some((repo) => repoNameKey(repo) === `${owner}/${name}`.toLowerCase())
    ? { installation: row, source: listing.source }
    : null;
}

export async function availableGitHubRepos(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string }
) {
  const config = await resolveGitHubConfig();
  const rows = await prisma.gitHubInstallation.findMany({
    orderBy: { id: 'asc' },
    where: {
      isActive: true,
      ...(user.role === 'ADMIN'
        ? {}
        : {
            OR: [
              { organizationId: null },
              { organization: { teams: { some: repositoryManagementTeams(user) } } },
            ],
          }),
    },
  });
  const sources: ImportSource[] = [];
  const merged = new Map<
    string,
    { repo: GitHubRepoInfo; source: ImportSource; installation: Installation | null }
  >();
  const add = (
    repos: GitHubRepoInfo[],
    source: ImportSource,
    installation: Installation | null
  ) => {
    for (const repo of repos) {
      merged.set(repoImportKey(source.githubUrl, repo.org, repo.name), {
        installation,
        repo,
        source,
      });
    }
  };
  const defaultSource: ImportSource = {
    githubApiUrl: config.apiUrl,
    githubUrl: config.baseUrl,
    installationAccount: null,
    installationId: null,
  };
  const defaultInstallation = await defaultGitHubInstallation(prisma, config);
  const defaultAllowed =
    !defaultInstallation ||
    (defaultInstallation.isActive && rows.some((row) => row.id === defaultInstallation.id));
  if (defaultInstallation) {
    defaultSource.installationId = defaultInstallation.id;
    defaultSource.installationAccount = defaultInstallation.accountLogin;
  }
  if (defaultAllowed) {
    try {
      const key = `default:${config.baseUrl}:${config.authMode}:${config.appInstallationId}`;
      let repos = read(listings, key);
      if (!repos) {
        repos = await listGitHubRepos();
        write(listings, key, repos, 100);
      }
      add(repos, defaultSource, defaultInstallation);
      sources.push(defaultSource);
    } catch {
      sources.push({ ...defaultSource, error: 'Default GitHub source could not be listed.' });
    }
  }
  for (const row of rows) {
    try {
      const listed = await installationRepos(row);
      sources.push(listed.source);
      add(listed.repos, listed.source, row);
    } catch {
      sources.push({
        error: 'Installation could not be listed. Check its credentials and suspension status.',
        githubApiUrl: row.host ? defaultApiUrlForHost(row.host) : config.apiUrl,
        githubUrl: row.host ? `https://${row.host}` : config.baseUrl,
        installationAccount: row.accountLogin,
        installationId: row.id,
      });
    }
  }
  const admin = user.role === 'ADMIN';
  const accounts = admin
    ? []
    : await prisma.account.findMany({
        select: { accessToken: true, accountId: true },
        where: { providerId: 'github', userId: user.sub },
      });
  const identity = admin
    ? null
    : await prisma.user.findUnique({
        select: { githubLoginAccountId: true },
        where: { id: user.sub },
      });
  const login = admin ? null : await verifiedGithubLoginFor(prisma, user.sub).catch(() => null);
  const loginAccount =
    accounts.find((a) => a.accountId === identity?.githubLoginAccountId) ??
    (identity?.githubLoginAccountId || accounts.length !== 1 ? undefined : accounts[0]);
  const positive = new Map<string, Set<string>>();
  const authoritative = new Map<string, Set<string>>();
  if (!admin) {
    for (const source of sources.filter((s) => !s.error)) {
      const host = hostFamily(source.githubUrl);
      if (hostFamily(source.githubApiUrl) !== host) {
        continue;
      }
      const account = accounts.find((a) => a.accessToken && accountHost(a.accountId) === host);
      if (!account?.accessToken) {
        continue;
      }
      const row = rows.find((r) => r.id === source.installationId);
      const defaultUsesApp =
        config.authMode === 'app' ||
        ((config.authMode ?? 'auto') === 'auto' &&
          config.appId &&
          config.appPrivateKey &&
          config.appInstallationId);
      const userInstallationId =
        row?.installationId ??
        (source.installationId === null && defaultUsesApp ? config.appInstallationId : null);
      if (userInstallationId) {
        try {
          const result = await reposWithToken(
            source.githubApiUrl,
            `/user/installations/${encodeURIComponent(userInstallationId)}/repositories`,
            account.accessToken,
            true
          );
          const names = new Set(result.repos.map(repoNameKey));
          if (result.complete) {
            authoritative.set(source.installationId ?? 'default', names);
          }
          const known = positive.get(host) ?? new Set<string>();
          for (const name of names) {
            known.add(name);
          }
          positive.set(host, known);
        } catch {
          /* A sign-in token need not be an App user token. */
        }
      }
      if (!positive.has(host)) {
        try {
          const result = await reposWithToken(
            source.githubApiUrl,
            '/user/repos?type=all',
            account.accessToken,
            false
          );
          positive.set(host, new Set(result.repos.map(repoNameKey)));
        } catch {
          /* Expired or insufficient sign-in tokens supply no evidence. */
        }
      }
    }
  }
  const existing = await runUnscoped(
    'import de-duplication must span every team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { githubUrl: true, organizationName: true, repoName: true },
        where: { type: 'git_repo' },
      })
  );
  const imported = new Set(
    existing.map((r) =>
      repoImportKey(r.githubUrl ?? config.baseUrl, r.organizationName ?? '', r.repoName ?? '')
    )
  );
  let lookups = 0;
  const data: ImportableRepo[] = [];
  for (const [key, { repo, source, installation }] of merged) {
    let readable: boolean | undefined = admin ? true : undefined;
    const host = hostFamily(source.githubUrl);
    const authoritativeNames = authoritative.get(source.installationId ?? 'default');
    if (!admin && authoritativeNames) {
      readable = authoritativeNames.has(repoNameKey(repo));
    } else if (!admin && positive.get(host)?.has(repoNameKey(repo))) {
      readable = true;
    }
    if (
      readable === undefined &&
      login &&
      loginAccount &&
      accountHost(loginAccount.accountId) === host
    ) {
      const accessKey = `${user.sub}:${login.toLowerCase()}:${key}`;
      const cached = read(access, accessKey);
      readable = cached === 'unchecked' ? undefined : cached;
      if (cached === undefined && lookups < IMPORT_ACCESS_LOOKUP_CAP) {
        lookups++;
        try {
          const verdict = await lookupRepoPermission(
            {
              githubApiUrl: source.githubApiUrl,
              githubUrl: source.githubUrl,
              installation,
              organizationName: repo.org,
              repoName: repo.name,
              scmProvider: GITHUB_SCM_PROVIDER,
            },
            login
          );
          if (verdict.ok) {
            readable = permissionMeets(verdict.permission, 'read');
          }
        } catch {
          /* An unanswered lookup is never readable evidence. */
        }
        write(access, accessKey, readable ?? 'unchecked', 10_000);
      }
    }
    if (readable === false) {
      continue;
    }
    const instanceHost = host === hostFamily(config.baseUrl);
    data.push({
      ...repo,
      access: readable ? 'readable' : 'unchecked',
      alreadyImported: imported.has(key),
      githubApiUrl: instanceHost ? null : source.githubApiUrl,
      githubUrl: instanceHost ? null : source.githubUrl,
      installationAccount: source.installationAccount,
      installationId: source.installationId,
    });
  }
  return { data, sources };
}
