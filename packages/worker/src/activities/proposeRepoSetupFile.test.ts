import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectionFindUnique = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: (...a: unknown[]) => connectionFindUnique(...a) } },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));

const provider = {
  createBranch: vi.fn(async () => 'created'),
  createFile: vi.fn(async () => undefined),
  createOrUpdatePullRequest: vi.fn(async () => ({
    prNumber: 7,
    prUrl: 'https://github.com/acme/widgets/pull/7',
  })),
  defaultBranch: vi.fn(async () => 'main'),
  fetchFileContent: vi.fn(async (): Promise<string | null> => null),
  resolveRef: vi.fn(async (): Promise<string | null> => 'abc123'),
};
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => provider,
  toRepoRef: (repo: { organizationName: string; repoName: string }) => ({
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  }),
}));

const { proposeRepoSetupFile } = await import('./proposeRepoSetupFile.js');
const { parseRepoSetupYaml } = await import('@auto-swe/shared/lib/repoSetup');

const setup = { cache: { paths: ['node_modules'] }, steps: [{ run: 'npm ci' }] };

describe('proposeRepoSetupFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionFindUnique.mockResolvedValue({
      defaultBranch: 'main',
      id: 'repo-1',
      installation: null,
      organizationName: 'acme',
      repoName: 'widgets',
      type: 'git_repo',
    });
  });

  it('commits the file to a new branch cut from the default branch and opens a PR', async () => {
    const result = await proposeRepoSetupFile({ connectionId: 'repo-1', setup });
    expect(result).toMatchObject({ ok: true, prNumber: 7 });
    const branch = (result as { branch: string }).branch;
    expect(branch).toMatch(/^auto\/setup-yml-[0-9a-f]{8}$/);
    expect(provider.createBranch).toHaveBeenCalledWith(expect.anything(), branch, 'abc123');
    const file = (provider.createFile.mock.calls[0] as unknown[])[1] as {
      branch: string;
      content: string;
      path: string;
    };
    expect(file).toMatchObject({ branch, path: '.auto-swe/setup.yml' });
    expect(parseRepoSetupYaml(file.content)).toEqual({ ok: true, setup });
    expect(provider.createOrUpdatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main', headBranch: branch })
    );
  });

  it('refuses when the default branch already has the file', async () => {
    provider.fetchFileContent.mockResolvedValueOnce('steps: []');
    await expect(proposeRepoSetupFile({ connectionId: 'repo-1', setup })).resolves.toMatchObject({
      ok: false,
      reason: 'exists',
    });
    expect(provider.createBranch).not.toHaveBeenCalled();
  });

  it('refuses an invalid definition without touching the repository', async () => {
    await expect(
      proposeRepoSetupFile({ connectionId: 'repo-1', setup: { steps: [{ run: '' }] } })
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    expect(connectionFindUnique).not.toHaveBeenCalled();
  });
});
