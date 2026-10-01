import { describe, expect, it, vi } from 'vitest';
import {
  REPO_IDENTITY_INDEX,
  REPO_IDENTITY_INDEX_SQL,
  warnIfGitHubDotComWebhookSecret,
  warnIfRepoIdentityIndexMissing,
} from './repoIdentityIndexCheck.js';

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

function setup(opts: { indexed: boolean; repos?: object[]; queryFails?: boolean }) {
  const queryRaw = vi.fn(async () => {
    if (opts.queryFails) {
      throw new Error('catalog unreadable');
    }
    return opts.indexed ? [{ indexname: REPO_IDENTITY_INDEX }] : [];
  });
  const findMany = vi.fn(async () => opts.repos ?? []);
  const warn = vi.fn();
  return {
    findMany,
    prisma: { $queryRaw: queryRaw, connection: { findMany } } as never,
    queryRaw,
    warn,
  };
}

describe('warnIfRepoIdentityIndexMissing', () => {
  it('is silent, and scans nothing, when the index exists', async () => {
    const { prisma, warn, findMany } = setup({ indexed: true });
    await expect(warnIfRepoIdentityIndexMissing(prisma, { warn })).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('names the case-only duplicate groups, and the SQL to finish the job, when it is missing', async () => {
    const { prisma, warn } = setup({
      indexed: false,
      repos: [
        { githubUrl: null, organizationName: 'Acme', repoName: 'API' },
        { githubUrl: null, organizationName: 'acme', repoName: 'api' },
        { githubUrl: 'https://ghe.corp', organizationName: 'acme', repoName: 'api' },
        { githubUrl: null, organizationName: 'acme', repoName: 'web' },
      ],
    });
    await expect(warnIfRepoIdentityIndexMissing(prisma, { warn })).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0];
    expect(fields.duplicates).toEqual(['<instance> acme/api (2 rows)']);
    expect(fields.duplicateGroups).toBe(1);
    expect(fields.sql).toBe(REPO_IDENTITY_INDEX_SQL);
    expect(fields.sql).toContain('CREATE UNIQUE INDEX connections_git_repo_host_org_repo_ci_uidx');
    expect(message).toContain('case-sensitive');
  });

  it('still warns when the index is missing and no duplicates remain', async () => {
    const { prisma, warn } = setup({ indexed: false, repos: [] });
    await expect(warnIfRepoIdentityIndexMissing(prisma, { warn })).resolves.toBe(true);
    expect(warn.mock.calls[0][0].duplicateGroups).toBe(0);
  });

  it('never throws: a failed check must not stop the gateway starting', async () => {
    const { prisma, warn } = setup({ indexed: false, queryFails: true });
    await expect(warnIfRepoIdentityIndexMissing(prisma, { warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String)
    );
  });
});

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
