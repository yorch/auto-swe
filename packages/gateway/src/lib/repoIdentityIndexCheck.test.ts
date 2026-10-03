import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  warnIfGitHubDotComWebhookSecret,
  warnIfReposOnUnusableHosts,
} from './repoIdentityIndexCheck.js';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

// The real rule, with the per-host credential lookup (a database read) stubbed.
const { hostCredential } = vi.hoisted(() => ({
  hostCredential: vi.fn(async (_host: string): Promise<unknown> => null),
}));
vi.mock('@auto-swe/shared/lib/githubHostCredential', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-swe/shared/lib/githubHostCredential')>();
  return {
    ...actual,
    resolvePlatformCredential: (repo: never, config: never) =>
      actual.platformCredentialFor(repo, config, (h) => hostCredential(h) as never),
  };
});

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

describe('warnIfGitHubDotComWebhookSecret', () => {
  const setupRows = (rows: Array<{ host: string }> | Error) => {
    const findMany = vi.fn(async () => {
      if (rows instanceof Error) {
        throw rows;
      }
      return rows;
    });
    return { prisma: { gitHubHostWebhookSecret: { findMany } } as never, warn: vi.fn() };
  };

  it('warns, naming the hosts, when a row exists for github.com or api.github.com', async () => {
    const { prisma, warn } = setupRows([{ host: 'github.com' }, { host: 'ghe.corp' }]);
    await expect(warnIfGitHubDotComWebhookSecret(prisma, { warn })).resolves.toBe(true);
    expect(warn.mock.calls[0][0]).toEqual({ hosts: ['github.com'] });
    expect(warn.mock.calls[0][1]).toContain('X-GitHub-Enterprise-Host');
  });

  it('warns for a *.ghe.com row too, which also sends no enterprise-host header', async () => {
    const { prisma, warn } = setupRows([{ host: 'acme.ghe.com' }, { host: 'api.acme.ghe.com' }]);
    await expect(warnIfGitHubDotComWebhookSecret(prisma, { warn })).resolves.toBe(true);
    expect(warn.mock.calls[0][0]).toEqual({ hosts: ['acme.ghe.com', 'api.acme.ghe.com'] });
    expect(warn.mock.calls[0][1]).toContain('*.ghe.com');
  });

  it('is silent when only enterprise hosts have rows', async () => {
    const { prisma, warn } = setupRows([{ host: 'ghe.corp' }]);
    await expect(warnIfGitHubDotComWebhookSecret(prisma, { warn })).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { prisma, warn } = setupRows(new Error('db down'));
    await expect(warnIfGitHubDotComWebhookSecret(prisma, { warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('warnIfReposOnUnusableHosts', () => {
  beforeEach(() => {
    hostCredential.mockReset().mockResolvedValue(null);
  });

  const run = async (repos: object[]) => {
    const findMany = vi.fn(async () => repos);
    const warn = vi.fn();
    const prisma = { connection: { findMany } } as never;
    const warned = await warnIfReposOnUnusableHosts(prisma, { warn });
    return { findMany, warn, warned };
  };
  const repo = (
    id: string,
    githubUrl: string | null,
    githubApiUrl: string | null = githubUrl,
    installation: { installationId: string } | null = null
  ) => ({
    githubApiUrl,
    githubUrl,
    id,
    installation,
    organizationName: 'acme',
    repoName: id,
  });

  it('lists repositories on a foreign host, naming the error their runs hit and the remedy', async () => {
    const { warn, warned, findMany } = await run([
      repo('a', 'https://ghe.corp'),
      repo('b', null),
      // An installation does not make a foreign host usable.
      repo('c', 'https://ghe.corp', 'https://ghe.corp', { installationId: '7' }),
    ]);
    expect(warned).toBe(true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, type: 'git_repo' } })
    );
    const [fields, message] = warn.mock.calls[0];
    expect(fields.total).toBe(2);
    expect(fields.repositories).toEqual([
      expect.objectContaining({
        error: 'REPO_CREDENTIAL_HOST_MISMATCH',
        host: 'ghe.corp',
        repository: 'acme/a',
      }),
      expect.objectContaining({ repository: 'acme/c' }),
    ]);
    expect(message).toContain("set the GitHub integration's web and API URLs");
    expect(message).toContain('Host credentials');
    expect(message).toContain('user must save their own token');
  });

  it('does not list repositories on a host that has a platform credential of its own', async () => {
    hostCredential.mockImplementation(async (host: string) =>
      host === 'ghe.corp' ? { appId: null, appPrivateKey: null, host, token: 'pat' } : null
    );
    const { warn } = await run([repo('a', 'https://ghe.corp'), repo('b', 'https://other.corp')]);
    expect(warn.mock.calls[0][0].total).toBe(1);
    expect(warn.mock.calls[0][0].repositories[0]).toMatchObject({
      host: 'other.corp',
      repository: 'acme/b',
    });
  });

  it('flags a half override as misconfigured', async () => {
    const { warn } = await run([repo('a', 'https://ghe.corp', null)]);
    expect(warn.mock.calls[0][0].repositories[0]).toMatchObject({
      error: 'REPO_HOST_MISCONFIGURED',
    });
  });

  it('caps the list at 20 and reports the total', async () => {
    const many = Array.from({ length: 25 }, (_, i) => repo(`r${i}`, 'https://ghe.corp'));
    const { warn } = await run(many);
    expect(warn.mock.calls[0][0].repositories).toHaveLength(20);
    expect(warn.mock.calls[0][0].total).toBe(25);
  });

  it('is silent when every repository is on the instance host, installed or not', async () => {
    expect((await run([])).warned).toBe(false);
    expect(
      (
        await run([
          repo('a', null),
          repo('b', 'https://github.com', 'https://api.github.com', { installationId: '7' }),
        ])
      ).warned
    ).toBe(false);
  });

  it('never throws', async () => {
    const warn = vi.fn();
    const prisma = {
      connection: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as never;
    await expect(warnIfReposOnUnusableHosts(prisma, { warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
