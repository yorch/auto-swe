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

const { createMock, listMock, getMock, getBranchMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getBranchMock: vi.fn(),
  getMock: vi.fn(),
  listMock: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    pulls = { create: createMock, get: getMock, list: listMock };
    repos = { getBranch: getBranchMock };
  },
}));

import { GitHubScmProvider } from './github.js';
import {
  DraftPullRequestUnsupportedError,
  ExistingPullRequestNotDraftError,
  type RepoRef,
} from './types.js';

const repo = { organizationName: 'acme', repoName: 'api' } as unknown as RepoRef;
const base = { baseBranch: 'main', body: 'b', headBranch: 'auto/agent-1', repo, title: 't' };

beforeEach(() => {
  createMock.mockReset();
  listMock.mockReset();
  getMock.mockReset();
  getBranchMock.mockReset();
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

describe('draft requests never reuse a ready-for-review PR', () => {
  const open = (draft: boolean) => ({ data: [{ draft, html_url: 'https://x/pull/9', number: 9 }] });

  it('refuses an open PR that is not a draft, and creates nothing', async () => {
    listMock.mockResolvedValue(open(false));
    await expect(
      new GitHubScmProvider().createOrUpdatePullRequest({
        ...base,
        draft: true,
        reuseExisting: true,
      })
    ).rejects.toBeInstanceOf(ExistingPullRequestNotDraftError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reuses an open PR that is still a draft', async () => {
    listMock.mockResolvedValue(open(true));
    await expect(
      new GitHubScmProvider().createOrUpdatePullRequest({
        ...base,
        draft: true,
        reuseExisting: true,
      })
    ).resolves.toEqual({ prNumber: 9, prUrl: 'https://x/pull/9' });
  });

  it('keeps reusing a ready PR for a caller that did not ask for a draft', async () => {
    listMock.mockResolvedValue(open(false));
    await expect(
      new GitHubScmProvider().createOrUpdatePullRequest({ ...base, reuseExisting: true })
    ).resolves.toMatchObject({ prNumber: 9 });
  });
});

describe('GitHubScmProvider branch and draft lookups', () => {
  it('reports a missing branch and no PR', async () => {
    getBranchMock.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    listMock.mockResolvedValue({ data: [] });
    await expect(new GitHubScmProvider().findBranchWork(repo, 'auto/x')).resolves.toEqual({
      branchExists: false,
      openPr: null,
    });
  });

  it('reports an existing branch with its open PR', async () => {
    getBranchMock.mockResolvedValue({ data: {} });
    listMock.mockResolvedValue({ data: [{ html_url: 'https://x/pull/3', number: 3 }] });
    await expect(new GitHubScmProvider().findBranchWork(repo, 'auto/x')).resolves.toEqual({
      branchExists: true,
      openPr: { prNumber: 3, prUrl: 'https://x/pull/3' },
    });
  });

  it('does not swallow a failure that is not a 404', async () => {
    getBranchMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(new GitHubScmProvider().findBranchWork(repo, 'auto/x')).rejects.toThrow('boom');
  });

  it('reads a PR draft state with one call', async () => {
    getMock.mockResolvedValue({ data: { draft: true } });
    await expect(new GitHubScmProvider().isDraftPullRequest(repo, 3)).resolves.toBe(true);
    getMock.mockResolvedValue({ data: { draft: false } });
    await expect(new GitHubScmProvider().isDraftPullRequest(repo, 3)).resolves.toBe(false);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
