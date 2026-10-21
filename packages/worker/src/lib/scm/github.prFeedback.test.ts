import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
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
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  CredentialUnreadableError: class CredentialUnreadableError extends Error {},
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredential: vi.fn(async () => null),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: true, hosts: ['github.com'] })),
}));
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
vi.mock('../runLauncher.js', () => ({
  currentRunLauncherId: vi.fn(async () => null),
}));

const octokit = vi.hoisted(() => ({
  ctor: vi.fn(),
  getComment: vi.fn(),
  getReview: vi.fn(),
  getReviewComment: vi.fn(),
  gitCreateRef: vi.fn(),
  gitGetRef: vi.fn(),
  graphql: vi.fn(),
  reply: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    graphql = octokit.graphql;
    git = { createRef: octokit.gitCreateRef, getRef: octokit.gitGetRef };
    issues = { getComment: octokit.getComment };
    pulls = {
      createReplyForReviewComment: octokit.reply,
      getReview: octokit.getReview,
      getReviewComment: octokit.getReviewComment,
    };
    constructor(opts: unknown) {
      octokit.ctor(opts);
    }
  },
}));

import { GitHubScmProvider } from './github.js';
import type { RepoRef } from './types.js';

const repo: RepoRef = {
  installationHost: null,
  organizationName: 'acme',
  repoName: 'api',
};
const gheRepo: RepoRef = {
  ...repo,
  apiUrl: 'https://ghe.corp/api/v3',
  baseUrl: 'https://ghe.corp',
};
const provider = new GitHubScmProvider();

beforeEach(() => {
  vi.clearAllMocks();
});

const THREADS = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: [
          {
            comments: {
              nodes: [
                {
                  author: { __typename: 'User', databaseId: 42, login: 'octocat' },
                  body: 'handle the null',
                  createdAt: '2026-10-01T00:00:00Z',
                  databaseId: 1001,
                  pullRequestReview: { databaseId: 777 },
                },
                {
                  author: { __typename: 'Bot', login: 'dependabot[bot]' },
                  body: 'bump',
                  createdAt: '2026-10-01T01:00:00Z',
                  databaseId: 1002,
                  pullRequestReview: null,
                },
              ],
            },
            id: 'PRRT_abc',
            isOutdated: false,
            isResolved: false,
            line: 12,
            path: 'src/x.ts',
          },
        ],
      },
    },
  },
};

describe('listReviewThreads', () => {
  it('maps threads and comments, author ids only for users', async () => {
    octokit.graphql.mockResolvedValue(THREADS);
    const threads = await provider.listReviewThreads(repo, 9);
    expect(octokit.graphql).toHaveBeenCalledWith(expect.stringContaining('reviewThreads'), {
      name: 'api',
      number: 9,
      owner: 'acme',
    });
    expect(threads).toEqual([
      {
        comments: [
          {
            authorId: '42',
            authorLogin: 'octocat',
            authorType: 'User',
            body: 'handle the null',
            createdAt: '2026-10-01T00:00:00Z',
            databaseId: 1001,
            reviewDatabaseId: 777,
          },
          {
            authorId: null,
            authorLogin: 'dependabot[bot]',
            authorType: 'Bot',
            body: 'bump',
            createdAt: '2026-10-01T01:00:00Z',
            databaseId: 1002,
            reviewDatabaseId: null,
          },
        ],
        isOutdated: false,
        isResolved: false,
        line: 12,
        path: 'src/x.ts',
        threadId: 'PRRT_abc',
      },
    ]);
  });

  it('builds the client on the repository’s own GHES API base', async () => {
    hostCredential.mockResolvedValue({
      appId: null,
      appPrivateKey: null,
      host: 'ghe.corp',
      token: 'host-pat',
    });
    octokit.graphql.mockResolvedValue(THREADS);
    await provider.listReviewThreads(gheRepo, 9);
    expect(octokit.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://ghe.corp/api/v3' })
    );
  });
});

describe('getPullRequestReview / getIssueComment / getReviewComment', () => {
  it('reads a review by id', async () => {
    octokit.getReview.mockResolvedValue({
      data: {
        body: 'changes, please',
        state: 'CHANGES_REQUESTED',
        user: { id: 42, login: 'octocat', type: 'User' },
      },
    });
    await expect(provider.getPullRequestReview(repo, 9, '777')).resolves.toEqual({
      authorId: '42',
      authorLogin: 'octocat',
      authorType: 'User',
      body: 'changes, please',
      state: 'CHANGES_REQUESTED',
    });
    expect(octokit.getReview).toHaveBeenCalledWith({
      owner: 'acme',
      pull_number: 9,
      repo: 'api',
      review_id: 777,
    });
  });

  it('answers null for a missing or non-numeric id', async () => {
    octokit.getReview.mockRejectedValue(Object.assign(new Error('no'), { status: 404 }));
    await expect(provider.getPullRequestReview(repo, 9, '777')).resolves.toBeNull();
    await expect(provider.getPullRequestReview(repo, 9, 'abc')).resolves.toBeNull();
  });

  it('reads an issue comment with its pull-request number', async () => {
    octokit.getComment.mockResolvedValue({
      data: {
        body: '/auto-swe fix',
        issue_url: 'https://api.github.com/repos/acme/api/issues/9',
        user: { id: 7, login: 'hubot', type: 'User' },
      },
    });
    await expect(provider.getIssueComment(repo, '999')).resolves.toEqual({
      authorId: '7',
      authorLogin: 'hubot',
      authorType: 'User',
      body: '/auto-swe fix',
      issueNumber: 9,
    });
  });

  it('reads a review comment with its thread linkage', async () => {
    octokit.getReviewComment.mockResolvedValue({
      data: {
        body: '/auto-swe fix this line',
        in_reply_to_id: 1001,
        pull_request_url: 'https://api.github.com/repos/acme/api/pulls/9',
        user: { id: 42, login: 'octocat', type: 'User' },
      },
    });
    await expect(provider.getReviewComment(repo, '1005')).resolves.toEqual({
      authorId: '42',
      authorLogin: 'octocat',
      authorType: 'User',
      body: '/auto-swe fix this line',
      inReplyToId: 1001,
      pullRequestNumber: 9,
    });
  });
});

describe('replyToReviewComment', () => {
  it('replies in the thread the top-level comment names', async () => {
    octokit.reply.mockResolvedValue({ data: { html_url: 'https://x/c' } });
    await expect(provider.replyToReviewComment(repo, 9, 1001, 'done')).resolves.toEqual({
      htmlUrl: 'https://x/c',
    });
    expect(octokit.reply).toHaveBeenCalledWith({
      body: 'done',
      comment_id: 1001,
      owner: 'acme',
      pull_number: 9,
      repo: 'api',
    });
  });
});

describe('createBranch', () => {
  it('creates the ref', async () => {
    octokit.gitCreateRef.mockResolvedValue({});
    await expect(provider.createBranch(repo, 'auto/prfb-9-1', 'abc')).resolves.toBe('created');
    expect(octokit.gitCreateRef).toHaveBeenCalledWith({
      owner: 'acme',
      ref: 'refs/heads/auto/prfb-9-1',
      repo: 'api',
      sha: 'abc',
    });
  });

  it('reports exists_same when the ref already points at the sha', async () => {
    octokit.gitCreateRef.mockRejectedValue(
      Object.assign(new Error('Reference already exists'), { status: 422 })
    );
    octokit.gitGetRef.mockResolvedValue({ data: { object: { sha: 'abc' } } });
    await expect(provider.createBranch(repo, 'auto/prfb-9-1', 'abc')).resolves.toBe('exists_same');
  });

  it('reports exists_other when the ref points elsewhere', async () => {
    octokit.gitCreateRef.mockRejectedValue(
      Object.assign(new Error('Reference already exists'), { status: 422 })
    );
    octokit.gitGetRef.mockResolvedValue({ data: { object: { sha: 'def' } } });
    await expect(provider.createBranch(repo, 'auto/prfb-9-1', 'abc')).resolves.toBe('exists_other');
  });

  it('propagates other failures', async () => {
    octokit.gitCreateRef.mockRejectedValue(Object.assign(new Error('down'), { status: 500 }));
    await expect(provider.createBranch(repo, 'auto/prfb-9-1', 'abc')).rejects.toThrow('down');
  });
});
