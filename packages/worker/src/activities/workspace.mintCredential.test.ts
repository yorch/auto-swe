import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  cloneCredentials: vi.fn(),
  findFirst: vi.fn(),
  getScmProvider: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: { connection: { findFirst: m.findFirst } } }));
vi.mock('../lib/scm/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/scm/index.js')>()),
  getScmProvider: m.getScmProvider,
}));

const { mintGitHubCloneUrl } = await import('./workspace.js');

beforeEach(() => {
  m.findFirst.mockReset();
  m.getScmProvider.mockReset();
  m.cloneCredentials.mockReset();
  m.cloneCredentials.mockResolvedValue({
    authedCloneUrl: 'https://x-access-token:t@github.com/a/b.git',
  });
  m.getScmProvider.mockReturnValue({ cloneCredentials: m.cloneCredentials });
});

describe('mintGitHubCloneUrl', () => {
  it('looks a dependency up among GitHub repositories only, so a same-named GitLab row is never picked', async () => {
    m.findFirst.mockResolvedValue(null);
    await mintGitHubCloneUrl('Acme', 'Lib');
    expect(m.findFirst).toHaveBeenCalledTimes(1);
    expect(m.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      isActive: true,
      organizationName: { equals: 'Acme', mode: 'insensitive' },
      repoName: { equals: 'Lib', mode: 'insensitive' },
      scmProvider: 'github',
      type: 'git_repo',
    });
  });

  it('mints through the GitHub provider for the row it found', async () => {
    m.findFirst.mockResolvedValue({
      githubApiUrl: null,
      githubUrl: null,
      id: 'c1',
      installation: null,
      organizationName: 'acme',
      repoName: 'lib',
      scmProvider: 'github',
    });
    await expect(mintGitHubCloneUrl('acme', 'lib')).resolves.toBe(
      'https://x-access-token:t@github.com/a/b.git'
    );
    expect(m.getScmProvider).toHaveBeenCalledWith(
      expect.objectContaining({ scmProvider: 'github' })
    );
  });

  it('treats a repository with no row as the instance GitHub one, saying so explicitly', async () => {
    m.findFirst.mockResolvedValue(null);
    await mintGitHubCloneUrl('acme', 'lib');
    expect(m.getScmProvider).toHaveBeenCalledWith({
      installationHost: null,
      installationId: null,
      organizationName: 'acme',
      repoName: 'lib',
      scmProvider: 'github',
    });
    expect(m.cloneCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ scmProvider: 'github' })
    );
  });
});
