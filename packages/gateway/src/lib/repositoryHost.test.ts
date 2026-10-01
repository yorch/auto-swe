import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

const {
  deliveryHostMatches,
  insensitiveName,
  likeLiteral,
  repositoryHostWhere,
  webhookHostScope,
  webhookRepositoryWhere,
} = await import('./repositoryHost.js');

const NAMES = {
  organizationName: { equals: 'acme', mode: 'insensitive' },
  repoName: { equals: 'api', mode: 'insensitive' },
};

describe('webhookRepositoryWhere', () => {
  const findMany = vi.fn();
  const secretRows = vi.fn();
  const prisma = {
    connection: { findMany },
    gitHubHostWebhookSecret: { findMany: secretRows },
  } as never;

  beforeEach(() => {
    findMany.mockReset();
    secretRows.mockReset();
    secretRows.mockResolvedValue([]);
  });

  it('matches by name alone when only one host has that owner/name', async () => {
    // So a configured host spelled differently from GitHub's html_url (an
    // internal name, a proxy) cannot make a single-host deployment's webhooks
    // stop matching.
    findMany.mockResolvedValue([{ githubUrl: 'https://github.internal' }]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://github.internal/acme/api', null)
    ).resolves.toEqual(NAMES);
  });

  it('adds the host only when the owner/name is onboarded on more than one', async () => {
    findMany.mockResolvedValue([{ githubUrl: null }, { githubUrl: 'https://ghe.corp' }]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://ghe.corp/acme/api', null)
    ).resolves.toEqual({ ...NAMES, githubUrl: 'https://ghe.corp' });
  });

  it('does not count legacy case-only duplicates on one host as a host ambiguity', async () => {
    // Insensitive matching returns both rows; filtering by html_url then could
    // match none of them when the configured host differs from html_url.
    findMany.mockResolvedValue([{ githubUrl: null }, { githubUrl: 'https://github.com' }]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://github.internal/acme/api', null)
    ).resolves.toEqual(NAMES);
    findMany.mockResolvedValue([
      { githubUrl: 'https://ghe.corp' },
      { githubUrl: 'https://ghe.corp' },
    ]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://ghe.internal/acme/api', null)
    ).resolves.toEqual(NAMES);
  });

  it('matches owner and name case-insensitively, whatever casing the payload uses', async () => {
    findMany.mockResolvedValue([]);
    await expect(
      webhookRepositoryWhere(prisma, 'ACME', 'Api', 'https://github.com/ACME/Api', null)
    ).resolves.toEqual({
      organizationName: { equals: 'ACME', mode: 'insensitive' },
      repoName: { equals: 'Api', mode: 'insensitive' },
    });
  });

  it('escapes LIKE metacharacters so a name is matched literally', async () => {
    findMany.mockResolvedValue([]);
    const where = await webhookRepositoryWhere(prisma, 'my_org', '50%_off\\x', undefined, null);
    expect(where).toEqual({
      organizationName: { equals: 'my\\_org', mode: 'insensitive' },
      repoName: { equals: '50\\%\\_off\\\\x', mode: 'insensitive' },
    });
  });

  describe('bound to the host a per-host secret proved', () => {
    it('always restricts to that host, ambiguous or not, whatever html_url says', async () => {
      findMany.mockResolvedValue([
        { githubUrl: null, id: 'on-github' },
        { githubUrl: 'https://ghe.corp', id: 'on-ghe' },
        { githubUrl: 'https://other.corp', id: 'on-other' },
      ]);
      await expect(
        webhookRepositoryWhere(prisma, 'acme', 'api', 'https://github.com/acme/api', 'ghe.corp')
      ).resolves.toEqual({ ...NAMES, id: { in: ['on-ghe'] } });
      // No ambiguity probe: the host decides.
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(secretRows).not.toHaveBeenCalled();
    });

    it('reaches the instance-host connections only when the verified host is the instance host', async () => {
      findMany.mockResolvedValue([
        { githubUrl: null, id: 'implicit' },
        { githubUrl: 'https://github.com', id: 'explicit' },
        { githubUrl: 'https://ghe.corp', id: 'on-ghe' },
      ]);
      await expect(webhookHostScope(prisma, 'github.com')).resolves.toEqual({
        id: { in: ['implicit', 'explicit'] },
      });
      await expect(webhookHostScope(prisma, 'ghe.corp')).resolves.toEqual({
        id: { in: ['on-ghe'] },
      });
    });

    it('matches a port-qualified host exactly', async () => {
      findMany.mockResolvedValue([
        { githubUrl: 'https://ghe.corp:8443', id: 'ported' },
        { githubUrl: 'https://ghe.corp', id: 'plain' },
      ]);
      await expect(webhookHostScope(prisma, 'ghe.corp:8443')).resolves.toEqual({
        id: { in: ['ported'] },
      });
    });
  });

  describe('bound by the instance secret', () => {
    it('excludes connections on a host that has a webhook secret of its own', async () => {
      secretRows.mockResolvedValue([{ host: 'ghe.corp' }]);
      findMany.mockResolvedValue([
        { githubUrl: null, id: 'on-github' },
        { githubUrl: 'https://ghe.corp', id: 'on-ghe' },
        { githubUrl: 'https://other.corp', id: 'on-other' },
      ]);
      await expect(webhookHostScope(prisma, null)).resolves.toEqual({ id: { notIn: ['on-ghe'] } });
    });

    it('also excludes the instance-host connections when the instance host has a row', async () => {
      secretRows.mockResolvedValue([{ host: 'github.com' }]);
      findMany.mockResolvedValue([
        { githubUrl: null, id: 'implicit' },
        { githubUrl: 'https://ghe.corp', id: 'on-ghe' },
      ]);
      await expect(webhookHostScope(prisma, null)).resolves.toEqual({
        id: { notIn: ['implicit'] },
      });
    });

    it('adds no constraint, and reads no connections, when no host has a secret', async () => {
      await expect(webhookHostScope(prisma, null)).resolves.toEqual({});
      expect(findMany).not.toHaveBeenCalled();
    });

    it('keeps the exclusion alongside the ambiguity filter', async () => {
      secretRows.mockResolvedValue([{ host: 'ghe.corp' }]);
      findMany
        .mockResolvedValueOnce([
          { githubUrl: null, id: 'on-github' },
          { githubUrl: 'https://ghe.corp', id: 'on-ghe' },
        ])
        .mockResolvedValueOnce([{ githubUrl: null }, { githubUrl: 'https://other.corp' }]);
      await expect(
        webhookRepositoryWhere(prisma, 'acme', 'api', 'https://other.corp/acme/api', null)
      ).resolves.toEqual({ ...NAMES, githubUrl: 'https://other.corp', id: { notIn: ['on-ghe'] } });
    });
  });
});

describe('deliveryHostMatches', () => {
  it('accepts anything when the instance secret verified, and an absent html_url', () => {
    expect(deliveryHostMatches(null, 'https://ghe.corp/acme/api')).toBe(true);
    expect(deliveryHostMatches('ghe.corp', undefined)).toBe(true);
  });

  it('requires the html_url host to be the verified host', () => {
    expect(deliveryHostMatches('ghe.corp', 'https://GHE.corp/acme/api')).toBe(true);
    expect(deliveryHostMatches('ghe.corp', 'https://github.com/acme/api')).toBe(false);
    expect(deliveryHostMatches('ghe.corp', 'https://ghe.corp:8443/acme/api')).toBe(false);
    expect(deliveryHostMatches('ghe.corp', 'not a url')).toBe(false);
  });
});

describe('likeLiteral', () => {
  it('escapes the LIKE wildcards and the escape character, and nothing else', () => {
    expect(likeLiteral('my_repo')).toBe('my\\_repo');
    expect(likeLiteral('100%')).toBe('100\\%');
    expect(likeLiteral('a\\b')).toBe('a\\\\b');
    expect(likeLiteral('plain-name.js')).toBe('plain-name.js');
  });

  it('builds a case-insensitive equals over the escaped literal', () => {
    expect(insensitiveName('My_Repo')).toEqual({ equals: 'My\\_Repo', mode: 'insensitive' });
  });
});

describe('repositoryHostWhere', () => {
  it('adds no constraint when the payload names no host', async () => {
    await expect(repositoryHostWhere(undefined)).resolves.toEqual({});
    await expect(repositoryHostWhere('not a url')).resolves.toEqual({});
  });

  it('matches the instance host to repositories with no override', async () => {
    await expect(repositoryHostWhere('https://github.com/acme/api')).resolves.toEqual({
      OR: [{ githubUrl: null }, { githubUrl: 'https://github.com' }],
    });
  });

  it('matches another host only to repositories overridden onto it', async () => {
    await expect(repositoryHostWhere('https://GHE.corp/acme/api')).resolves.toEqual({
      githubUrl: 'https://ghe.corp',
    });
  });
});
