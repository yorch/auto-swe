import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositoryManagementTeams } from './tenantScope.js';

const h = vi.hoisted(() => ({
  config: {
    apiUrl: 'https://api.github.com',
    appInstallationId: null as string | null,
    authMode: 'pat',
    baseUrl: 'https://github.com',
  },
  credential: vi.fn(),
  fetch: vi.fn(),
  list: vi.fn(),
  login: vi.fn(),
  lookup: vi.fn(),
  token: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({ resolveGitHubConfig: async () => h.config }));
vi.mock('@auto-swe/shared/lib/guardedDispatcher', () => ({ createGuardedFetch: () => h.fetch }));
vi.mock('@auto-swe/shared/lib/githubHostCredential', () => ({
  resolvePlatformCredential: (...args: unknown[]) => h.credential(...args),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({
  resolveGitHubToken: (...args: unknown[]) => h.token(...args),
}));
vi.mock('@auto-swe/shared/lib/repoPermission', () => ({
  lookupRepoPermission: (...args: unknown[]) => h.lookup(...args),
  verifiedGithubLoginFor: (...args: unknown[]) => h.login(...args),
}));
vi.mock('./github.js', () => ({ listGitHubRepos: () => h.list() }));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

import {
  availableGitHubRepos,
  clearGitHubImportCaches,
  IMPORT_ACCESS_LOOKUP_CAP,
  IMPORT_CACHE_TTL_MS,
  verifiedImportInstallation,
} from './githubImport.js';

const installation = {
  accountLogin: 'acme',
  host: '',
  id: 'install-1',
  installationId: '123',
  isActive: true,
};
const actor = { role: 'ENGINEER', sub: 'u1' };
const admin = { ...actor, role: 'ADMIN' };
const repo = (name: string) => ({
  apiUrl: `https://api.github.com/repos/acme/${name}`,
  defaultBranch: 'main',
  description: null,
  htmlUrl: `https://github.com/acme/${name}`,
  language: null,
  name,
  org: 'acme',
});
const raw = (name: string) => ({
  default_branch: 'main',
  description: null,
  html_url: `https://github.com/acme/${name}`,
  language: null,
  name,
  owner: { login: 'acme' },
  url: `https://api.github.com/repos/acme/${name}`,
});
const ok = (names: string[], wrapped = true) =>
  new Response(JSON.stringify(wrapped ? { repositories: names.map(raw) } : names.map(raw)), {
    status: 200,
  });

function database() {
  return {
    account: { findMany: vi.fn().mockResolvedValue([{ accessToken: null, accountId: '42' }]) },
    connection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubInstallation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(installation),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ githubLoginAccountId: '42' }) },
  };
}
let db: ReturnType<typeof database>;
const prisma = () => db as unknown as FastifyInstance['prisma'];
beforeEach(() => {
  vi.resetAllMocks();
  clearGitHubImportCaches();
  db = database();
  h.config.baseUrl = 'https://github.com';
  h.config.apiUrl = 'https://api.github.com';
  h.config.authMode = 'pat';
  h.config.appInstallationId = null;
  h.list.mockResolvedValue([repo('api')]);
  h.login.mockResolvedValue('octocat');
  h.lookup.mockResolvedValue({ ok: true, permission: 'read' });
  h.credential.mockResolvedValue({ config: h.config, scope: 'instance' });
  h.token.mockResolvedValue('platform-secret');
  h.fetch.mockImplementation(async () => ok(['api']));
});
afterEach(() => vi.useRealTimers());

describe('GitHub discovery', () => {
  it('merges all active installation sources, prefers installation rows and marks imported by host and case', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([
      installation,
      { ...installation, accountLogin: 'enterprise', host: 'ghe.example', id: 'install-2' },
    ]);
    db.connection.findMany.mockResolvedValue([
      { githubUrl: null, organizationName: 'Acme', repoName: 'API' },
    ] as never);
    const result = await availableGitHubRepos(prisma(), admin);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      access: 'readable',
      alreadyImported: true,
      installationId: 'install-1',
    });
    expect(result.data[1]).toMatchObject({
      alreadyImported: false,
      githubApiUrl: 'https://ghe.example/api/v3',
      githubUrl: 'https://ghe.example',
      installationAccount: 'enterprise',
      installationId: 'install-2',
    });
    expect(result.sources).toHaveLength(3);
    expect(db.gitHubInstallation.findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' },
      where: { isActive: true },
    });
    expect(h.credential.mock.calls[1][0]).toMatchObject({
      apiUrl: 'https://ghe.example/api/v3',
      installationHost: 'ghe.example',
    });
    expect(h.token.mock.calls[0]).toMatchObject([
      { authMode: 'app' },
      { apiUrl: 'https://api.github.com', installationId: '123' },
    ]);
  });

  it('scopes org-linked sources to organizations with a managed active team', async () => {
    await availableGitHubRepos(prisma(), { role: 'ENGINEER', sub: 'caller' });
    expect(db.gitHubInstallation.findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' },
      where: {
        isActive: true,
        OR: [
          { organizationId: null },
          {
            organization: {
              teams: { some: repositoryManagementTeams({ sub: 'caller' }) },
            },
          },
        ],
      },
    });
  });
  it('does not expose a filtered installation again as the singleton default source', async () => {
    h.config.authMode = 'app';
    h.config.appInstallationId = '123';
    db.gitHubInstallation.findUnique.mockResolvedValue({
      ...installation,
      organizationId: 'org-a',
    } as never);
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(h.list).not.toHaveBeenCalled();
  });
  it('keeps the singleton default source bound to its registered installation', async () => {
    h.config.authMode = 'app';
    h.config.appInstallationId = '123';
    db.gitHubInstallation.findMany.mockResolvedValue([installation]);
    const result = await availableGitHubRepos(prisma(), admin);
    expect(result.data[0].installationId).toBe(installation.id);
  });
  it('does not filter admins or look up their identity', async () => {
    h.lookup.mockResolvedValue({ ok: true, permission: 'none' });
    const result = await availableGitHubRepos(prisma(), admin);
    expect(result.data[0].access).toBe('readable');
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
    expect(db.account.findMany).not.toHaveBeenCalled();
  });

  it('uses complete App-user installation listings authoritatively, including denials', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([installation]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'user-secret', accountId: '42' },
    ] as never);
    h.fetch.mockImplementation(async (_url, init) =>
      init.headers.Authorization === 'Bearer platform-secret' ? ok(['api', 'hidden']) : ok(['api'])
    );
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data.map((r) => r.name)).toEqual(['api']);
    expect(
      h.fetch.mock.calls.some(([url]) => url.includes('/user/installations/123/repositories'))
    ).toBe(true);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(h.fetch.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
  });

  it('falls back after refused user-token requests and omits known unreadable repositories', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([installation]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'expired-secret', accountId: '42' },
    ] as never);
    h.fetch.mockImplementation(async (_url, init) =>
      init.headers.Authorization === 'Bearer platform-secret'
        ? ok(['api', 'hidden'])
        : new Response(null, { status: 401 })
    );
    h.lookup.mockImplementation(async (r) => ({
      ok: true,
      permission: r.repoName === 'hidden' ? 'none' : 'read',
    }));
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data.map((r) => r.name)).toEqual(['api']);
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(result.sources.every((s) => !s.error)).toBe(true);
    expect(h.lookup.mock.calls[0][0]).toMatchObject({
      installation: { host: '', installationId: '123' },
    });
  });

  it('accepts /user/repos visibility as positive evidence only', async () => {
    h.list.mockResolvedValue([repo('api'), repo('other')]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'user-secret', accountId: '42' },
    ] as never);
    h.fetch.mockImplementation(async () => ok(['api'], false));
    h.lookup.mockResolvedValue({ failure: 'unavailable', ok: false });
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data.map((r) => r.access)).toEqual(['readable', 'unchecked']);
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it('never sends a user token to another host and leaves other-host identities unchecked', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([{ ...installation, host: 'ghe.example' }]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'dotcom-secret', accountId: '42' },
    ] as never);
    h.fetch.mockImplementation(async (url) =>
      url.includes('ghe.example') ? ok(['api']) : ok(['api'], false)
    );
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data.find((r) => r.githubUrl)?.access).toBe('unchecked');
    expect(
      h.fetch.mock.calls
        .filter(([, init]) => init.headers.Authorization === 'Bearer dotcom-secret')
        .every(([url]) => url.startsWith('https://api.github.com/'))
    ).toBe(true);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('uses a GHE generic-provider account only on its host', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([{ ...installation, host: 'ghe.example' }]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'enterprise-secret', accountId: 'ghe.example:42' },
    ] as never);
    db.user.findUnique.mockResolvedValue({ githubLoginAccountId: 'ghe.example:42' });
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data.find((r) => r.githubUrl)?.access).toBe('readable');
    expect(
      h.fetch.mock.calls
        .filter(([, init]) => init.headers.Authorization === 'Bearer enterprise-secret')
        .every(([url]) => url.startsWith('https://ghe.example/api/v3/'))
    ).toBe(true);
  });

  it('caps uncached lookups and advances on the next load using cached answers', async () => {
    h.list.mockResolvedValue(
      Array.from({ length: IMPORT_ACCESS_LOOKUP_CAP + 2 }, (_, i) => repo(`r${i}`))
    );
    const first = await availableGitHubRepos(prisma(), actor);
    expect(h.lookup).toHaveBeenCalledTimes(IMPORT_ACCESS_LOOKUP_CAP);
    expect(first.data.filter((r) => r.access === 'unchecked')).toHaveLength(2);
    const next = await availableGitHubRepos(prisma(), actor);
    expect(h.lookup).toHaveBeenCalledTimes(IMPORT_ACCESS_LOOKUP_CAP + 2);
    expect(next.data.every((r) => r.access === 'readable')).toBe(true);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it('caches unanswered lookups as unchecked so failures do not starve later repositories', async () => {
    h.list.mockResolvedValue(
      Array.from({ length: IMPORT_ACCESS_LOOKUP_CAP + 1 }, (_, i) => repo(`r${i}`))
    );
    h.lookup.mockRejectedValue(new Error('rate limited platform-secret'));
    const first = await availableGitHubRepos(prisma(), actor);
    expect(first.data.every((r) => r.access === 'unchecked')).toBe(true);
    await availableGitHubRepos(prisma(), actor);
    expect(h.lookup).toHaveBeenCalledTimes(IMPORT_ACCESS_LOOKUP_CAP + 1);
    expect(JSON.stringify(first)).not.toContain('platform-secret');
  });

  it('returns unchecked without a linked login', async () => {
    h.login.mockResolvedValue(null);
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data[0].access).toBe('unchecked');
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('does not guess the host of a legacy login with several linked accounts', async () => {
    db.user.findUnique.mockResolvedValue({ githubLoginAccountId: null } as never);
    db.account.findMany.mockResolvedValue([
      { accessToken: null, accountId: '42' },
      { accessToken: null, accountId: 'ghe.example:42' },
    ]);
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data[0].access).toBe('unchecked');
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('isolates failing sources and never returns exception bodies or tokens', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([
      installation,
      { ...installation, id: 'install-2', installationId: '456' },
    ]);
    h.list.mockRejectedValue(new Error('default-secret'));
    h.token.mockImplementation(async (_config, target) => {
      if (target.installationId === '123') {
        throw new Error('platform-secret');
      }
      return 'other-secret';
    });
    const result = await availableGitHubRepos(prisma(), admin);
    expect(result.sources.filter((s) => s.error)).toHaveLength(2);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].installationId).toBe('install-2');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns an empty listing with source errors when every source fails', async () => {
    h.list.mockRejectedValue(new Error('not configured'));
    const result = await availableGitHubRepos(prisma(), admin);
    expect(result.data).toEqual([]);
    expect(result.sources[0].error).toBeTruthy();
  });

  it('expires listings and access answers after three minutes', async () => {
    vi.useFakeTimers();
    await availableGitHubRepos(prisma(), actor);
    vi.advanceTimersByTime(IMPORT_CACHE_TTL_MS + 1);
    await availableGitHubRepos(prisma(), actor);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.lookup).toHaveBeenCalledTimes(2);
  });

  it('does not deny missing repos based on a truncated App-user listing', async () => {
    db.gitHubInstallation.findMany.mockResolvedValue([installation]);
    db.account.findMany.mockResolvedValue([
      { accessToken: 'user-secret', accountId: '42' },
    ] as never);
    h.fetch.mockImplementation(async (_url, init) =>
      init.headers.Authorization === 'Bearer platform-secret'
        ? ok(['api'])
        : ok(Array.from({ length: 100 }, (_, i) => `r${i}`))
    );
    const result = await availableGitHubRepos(prisma(), actor);
    expect(result.data[0].access).toBe('readable');
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('server-verified import installation', () => {
  it('requires an active row whose actual listing contains the requested repository', async () => {
    expect(
      await verifiedImportInstallation(prisma(), installation.id, 'ACME', 'API')
    ).toMatchObject({ installation });
    expect(
      await verifiedImportInstallation(prisma(), installation.id, 'acme', 'not-listed')
    ).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    db.gitHubInstallation.findUnique.mockResolvedValue({ ...installation, isActive: false });
    expect(await verifiedImportInstallation(prisma(), installation.id, 'acme', 'api')).toBeNull();
    db.gitHubInstallation.findUnique.mockResolvedValue(null as never);
    expect(await verifiedImportInstallation(prisma(), installation.id, 'acme', 'api')).toBeNull();
  });
});
