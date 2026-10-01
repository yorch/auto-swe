import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  })),
}));
vi.mock('../githubAuth.js', () => ({
  GitHubTokenMissingError: class GitHubTokenMissingError extends Error {},
  requireGitHubToken: vi.fn(async () => 'ghp_tok'),
  resolveGitHubToken: vi.fn(async () => 'ghp_tok'),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  CredentialUnreadableError: class CredentialUnreadableError extends Error {},
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredential: vi.fn(async () => null),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: true, hosts: ['github.com'] })),
}));
vi.mock('../runLauncher.js', () => ({ currentRunLauncherId: vi.fn(async () => null) }));

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    pulls = { create: createMock, list: vi.fn() };
  },
}));

import { GitHubScmProvider } from './github.js';
import { DraftPullRequestUnsupportedError, type RepoRef } from './types.js';

const repo = { organizationName: 'acme', repoName: 'api' } as unknown as RepoRef;
const base = { baseBranch: 'main', body: 'b', headBranch: 'auto/agent-1', repo, title: 't' };

beforeEach(() => {
  createMock.mockReset();
});

describe('GitHubScmProvider.createOrUpdatePullRequest draft', () => {
  it('sends draft: true only when asked', async () => {
    createMock.mockResolvedValue({ data: { html_url: 'https://x/pull/1', number: 1 } });
    const scm = new GitHubScmProvider();
    await scm.createOrUpdatePullRequest({ ...base, draft: true });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ draft: true });
    await scm.createOrUpdatePullRequest(base);
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('draft');
  });

  it('raises a typed error, never a ready-for-review PR, when the repo cannot draft', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('Draft pull requests are not supported in this repository'), {
        status: 422,
      })
    );
    await expect(
      new GitHubScmProvider().createOrUpdatePullRequest({ ...base, draft: true })
    ).rejects.toBeInstanceOf(DraftPullRequestUnsupportedError);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does not misreport an unrelated 422 as a draft problem', async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error('A pull request already exists'), { status: 422 })
    );
    await expect(
      new GitHubScmProvider().createOrUpdatePullRequest({ ...base, draft: true })
    ).rejects.not.toBeInstanceOf(DraftPullRequestUnsupportedError);
  });
});
