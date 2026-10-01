import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

const { repositoryHostWhere, webhookRepositoryWhere } = await import('./repositoryHost.js');

describe('webhookRepositoryWhere', () => {
  const findMany = vi.fn();
  const prisma = { connection: { findMany } } as never;

  it('matches by name alone when only one host has that owner/name', async () => {
    // So a configured host spelled differently from GitHub's html_url (an
    // internal name, a proxy) cannot make a single-host deployment's webhooks
    // stop matching.
    findMany.mockResolvedValue([{ id: 'only' }]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://github.internal/acme/api')
    ).resolves.toEqual({ organizationName: 'acme', repoName: 'api' });
  });

  it('adds the host only when the owner/name is onboarded on more than one', async () => {
    findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(
      webhookRepositoryWhere(prisma, 'acme', 'api', 'https://ghe.corp/acme/api')
    ).resolves.toEqual({
      githubUrl: 'https://ghe.corp',
      organizationName: 'acme',
      repoName: 'api',
    });
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
