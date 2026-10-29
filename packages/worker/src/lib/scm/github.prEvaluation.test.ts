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
vi.mock('@auto-swe/shared/lib/githubHostCredential', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-swe/shared/lib/githubHostCredential')>();
  return {
    ...actual,
    resolvePlatformCredential: (repo: never, config: never) =>
      actual.platformCredentialFor(repo, config, () => null as never),
  };
});
vi.mock('../runLauncher.js', () => ({
  currentRunLauncherId: vi.fn(async () => null),
}));

const octokit = vi.hoisted(() => ({
  createCommitStatus: vi.fn(),
  getBranchProtection: vi.fn(),
  graphql: vi.fn(),
  listFiles: vi.fn(),
  listReviews: vi.fn(),
  pullsGet: vi.fn(),
  reposGet: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    graphql = octokit.graphql;
    request = octokit.request;
    repos = {
      createCommitStatus: octokit.createCommitStatus,
      get: octokit.reposGet,
      getBranchProtection: octokit.getBranchProtection,
    };
    pulls = {
      get: octokit.pullsGet,
      listFiles: octokit.listFiles,
      listReviews: octokit.listReviews,
    };
  },
}));

import { GitHubScmProvider } from './github.js';
import type { RepoRef } from './types.js';

const repo: RepoRef = { installationHost: null, organizationName: 'acme', repoName: 'api' };
const provider = new GitHubScmProvider();

const prData = (over: Record<string, unknown> = {}) => ({
  data: {
    base: { ref: 'main' },
    changed_files: 1,
    draft: false,
    head: { ref: 'feat', sha: 'abc123' },
    merged: false,
    node_id: 'PR_node',
    number: 7,
    state: 'open',
    title: 'A change',
    user: { login: 'octocat' },
    ...over,
  },
});

const file = (over: Record<string, unknown> = {}) => ({
  additions: 1,
  changes: 2,
  deletions: 1,
  filename: 'a.ts',
  patch: '@@ -1 +1 @@',
  status: 'modified',
  ...over,
});

const notFound = (message = 'Not Found') => Object.assign(new Error(message), { status: 404 });
const forbidden = () => Object.assign(new Error('Forbidden'), { status: 403 });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getPullRequest', () => {
  it('maps the pull request', async () => {
    octokit.pullsGet.mockResolvedValue(prData());
    expect(await provider.getPullRequest(repo, 7)).toEqual({
      author: 'octocat',
      autoMerge: { enabled: false },
      baseBranch: 'main',
      draft: false,
      headBranch: 'feat',
      headSha: 'abc123',
      merged: false,
      nodeId: 'PR_node',
      number: 7,
      state: 'open',
      title: 'A change',
    });
  });

  it('exposes whether GitHub has auto-merge enabled, and by which method', async () => {
    octokit.pullsGet.mockResolvedValue(prData({ auto_merge: { merge_method: 'squash' } }));
    expect((await provider.getPullRequest(repo, 7))?.autoMerge).toEqual({
      enabled: true,
      method: 'squash',
    });
    octokit.pullsGet.mockResolvedValue(prData({ auto_merge: null }));
    expect((await provider.getPullRequest(repo, 7))?.autoMerge).toEqual({ enabled: false });
  });

  it('reports a deleted author as null and a closed PR as closed', async () => {
    octokit.pullsGet.mockResolvedValue(prData({ merged: true, state: 'closed', user: null }));
    const pr = await provider.getPullRequest(repo, 7);
    expect(pr).toMatchObject({ author: null, merged: true, state: 'closed' });
  });

  it('returns null on 404 and rethrows other errors', async () => {
    octokit.pullsGet.mockRejectedValueOnce(notFound());
    expect(await provider.getPullRequest(repo, 7)).toBeNull();
    octokit.pullsGet.mockRejectedValueOnce(forbidden());
    await expect(provider.getPullRequest(repo, 7)).rejects.toThrow('Forbidden');
  });
});

describe('listPullRequestFiles', () => {
  it('maps files, keeps previous path and passes the patch through', async () => {
    octokit.listFiles.mockResolvedValue({
      data: [
        file(),
        file({ filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed' }),
        file({ filename: 'bin.png', patch: undefined, status: 'added' }),
      ],
    });
    octokit.pullsGet.mockResolvedValue(prData({ changed_files: 3 }));
    const { files, truncated } = await provider.listPullRequestFiles(repo, 7);
    expect(truncated).toBe(false);
    expect(files[0]).toEqual({
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@',
      path: 'a.ts',
      status: 'modified',
    });
    expect(files[1]).toMatchObject({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' });
    expect(files[1]?.similarity).toBeUndefined();
    expect(files[2]).not.toHaveProperty('patch');
  });

  it.each(['copied', 'changed', 'unchanged'])('maps %s to modified', async (status) => {
    octokit.listFiles.mockResolvedValue({ data: [file({ status })] });
    octokit.pullsGet.mockResolvedValue(prData());
    const { files } = await provider.listPullRequestFiles(repo, 7);
    expect(files[0]?.status).toBe('modified');
  });

  it('sets similarity 100 only for a rename with no changes', async () => {
    octokit.listFiles.mockResolvedValue({
      data: [
        file({
          additions: 0,
          changes: 0,
          deletions: 0,
          filename: 'b.ts',
          previous_filename: 'a.ts',
          status: 'renamed',
        }),
        file({ additions: 0, changes: 0, deletions: 0, status: 'modified' }),
      ],
    });
    octokit.pullsGet.mockResolvedValue(prData({ changed_files: 2 }));
    const { files } = await provider.listPullRequestFiles(repo, 7);
    expect(files[0]?.similarity).toBe(100);
    expect(files[1]?.similarity).toBeUndefined();
  });

  it('treats a patch over 200 000 characters as absent', async () => {
    octokit.listFiles.mockResolvedValue({
      data: [file({ patch: 'x'.repeat(200_001) }), file({ patch: 'y'.repeat(200_000) })],
    });
    octokit.pullsGet.mockResolvedValue(prData({ changed_files: 2 }));
    const { files } = await provider.listPullRequestFiles(repo, 7);
    expect(files[0]).not.toHaveProperty('patch');
    expect(files[1]?.patch).toHaveLength(200_000);
  });

  it('paginates until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => file({ filename: `f${i}` }));
    octokit.listFiles
      .mockResolvedValueOnce({ data: full })
      .mockResolvedValueOnce({ data: [file({ filename: 'last' })] });
    octokit.pullsGet.mockResolvedValue(prData({ changed_files: 101 }));
    const { files, truncated } = await provider.listPullRequestFiles(repo, 7);
    expect(files).toHaveLength(101);
    expect(truncated).toBe(false);
    expect(octokit.listFiles).toHaveBeenCalledTimes(2);
    expect(octokit.listFiles.mock.calls[1]?.[0]).toMatchObject({ page: 2, per_page: 100 });
  });

  it('is truncated at the page cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => file({ filename: `f${i}` }));
    octokit.listFiles.mockResolvedValue({ data: full });
    const { files, truncated } = await provider.listPullRequestFiles(repo, 7);
    expect(octokit.listFiles).toHaveBeenCalledTimes(30);
    expect(files).toHaveLength(3000);
    expect(truncated).toBe(true);
  });

  it('is truncated when the PR reports more files than came back', async () => {
    octokit.listFiles.mockResolvedValue({ data: [file()] });
    octokit.pullsGet.mockResolvedValue(prData({ changed_files: 5 }));
    expect((await provider.listPullRequestFiles(repo, 7)).truncated).toBe(true);
  });
});

describe('listPullRequestReviews', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    commit_id: 'abc',
    state: 'approved',
    submitted_at: '2026-01-01T00:00:00Z',
    user: { login: 'alice' },
    ...over,
  });

  it('upper-cases states and skips deleted users', async () => {
    octokit.listReviews.mockResolvedValue({
      data: [
        review(),
        review({ user: null }),
        review({ state: 'changes_requested', submitted_at: null }),
      ],
    });
    expect(await provider.listPullRequestReviews(repo, 7)).toEqual([
      { commitId: 'abc', login: 'alice', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
      { commitId: 'abc', login: 'alice', state: 'CHANGES_REQUESTED', submittedAt: null },
    ]);
  });

  it('reads every page, up to the cap', async () => {
    const full = Array.from({ length: 100 }, () => review());
    octokit.listReviews
      .mockResolvedValueOnce({ data: full })
      .mockResolvedValueOnce({ data: [review({ user: { login: 'bob' } })] });
    expect(await provider.listPullRequestReviews(repo, 7)).toHaveLength(101);

    octokit.listReviews.mockReset();
    octokit.listReviews.mockResolvedValue({ data: full });
    expect(await provider.listPullRequestReviews(repo, 7)).toHaveLength(3000);
    expect(octokit.listReviews).toHaveBeenCalledTimes(30);
  });
});

describe('setCommitStatus', () => {
  const input = { context: 'auto-swe/pr-evaluation', description: 'ok', state: 'success' as const };

  it('creates the status, truncating the description to 140 characters', async () => {
    octokit.createCommitStatus.mockResolvedValue({ data: {} });
    const res = await provider.setCommitStatus(repo, 'abc', {
      ...input,
      description: 'd'.repeat(300),
      targetUrl: 'https://x.test/p',
    });
    expect(res).toEqual({ ok: true });
    const arg = octokit.createCommitStatus.mock.calls[0]?.[0];
    expect(arg.description).toHaveLength(140);
    expect(arg).toMatchObject({
      context: 'auto-swe/pr-evaluation',
      owner: 'acme',
      repo: 'api',
      sha: 'abc',
      state: 'success',
      target_url: 'https://x.test/p',
    });
  });

  it('omits target_url when none is given', async () => {
    octokit.createCommitStatus.mockResolvedValue({ data: {} });
    await provider.setCommitStatus(repo, 'abc', input);
    expect(octokit.createCommitStatus.mock.calls[0]?.[0]).not.toHaveProperty('target_url');
  });

  it('reports a 422 or 403 as a refusal and rethrows anything else', async () => {
    octokit.createCommitStatus.mockRejectedValueOnce(
      Object.assign(new Error('Validation Failed'), { status: 422 })
    );
    expect(await provider.setCommitStatus(repo, 'abc', input)).toEqual({
      ok: false,
      reason: 'Validation Failed',
    });
    octokit.createCommitStatus.mockRejectedValueOnce(forbidden());
    expect((await provider.setCommitStatus(repo, 'abc', input)).ok).toBe(false);
    octokit.createCommitStatus.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { status: 500 })
    );
    await expect(provider.setCommitStatus(repo, 'abc', input)).rejects.toThrow('boom');
  });
});

describe('readBranchRules', () => {
  const protection = {
    data: {
      required_pull_request_reviews: {
        require_code_owner_reviews: true,
        required_approving_review_count: 2,
      },
      required_status_checks: {
        checks: [{ context: 'lint' }, { context: 'ci' }],
        contexts: ['ci'],
      },
    },
  };
  const rulesets = {
    data: [
      {
        parameters: { require_code_owner_review: false, required_approving_review_count: 1 },
        type: 'pull_request',
      },
      {
        parameters: { required_status_checks: [{ context: 'e2e' }, { context: 'ci' }] },
        type: 'required_status_checks',
      },
      { type: 'deletion' },
    ],
  };

  it('combines protection, rulesets and allow_auto_merge', async () => {
    octokit.getBranchProtection.mockResolvedValue(protection);
    octokit.request.mockResolvedValue(rulesets);
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    expect(await provider.readBranchRules(repo, 'main')).toEqual({
      allowsAutoMerge: true,
      requiredReviewCount: 2,
      requiredStatusContexts: ['ci', 'lint', 'e2e'],
      requiredStatusPinnedToApp: 'unknown',
      requiresCodeOwnerReview: true,
      requiresReviews: true,
      source: 'both',
    });
    expect(octokit.request.mock.calls[0]?.[0]).toBe(
      'GET /repos/{owner}/{repo}/rules/branches/{branch}'
    );
  });

  it('reads a ruleset-only branch (protection says not protected)', async () => {
    octokit.getBranchProtection.mockRejectedValue(notFound('Branch not protected'));
    octokit.request.mockResolvedValue(rulesets);
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: false } });
    expect(await provider.readBranchRules(repo, 'main')).toMatchObject({
      allowsAutoMerge: false,
      requiredReviewCount: 1,
      requiresCodeOwnerReview: false,
      requiresReviews: true,
      source: 'rulesets',
    });
  });

  it('reports none when both sources answer and have nothing', async () => {
    octokit.getBranchProtection.mockRejectedValue(notFound('Branch not protected'));
    octokit.request.mockResolvedValue({ data: [] });
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: false } });
    expect(await provider.readBranchRules(repo, 'main')).toEqual({
      allowsAutoMerge: false,
      requiredReviewCount: 0,
      requiredStatusContexts: [],
      requiredStatusPinnedToApp: 'unknown',
      requiresCodeOwnerReview: false,
      requiresReviews: false,
      source: 'none',
    });
  });

  it('is unknown, never false, when a source cannot be read', async () => {
    octokit.getBranchProtection.mockRejectedValue(forbidden());
    octokit.request.mockResolvedValue({ data: [] });
    octokit.reposGet.mockRejectedValue(forbidden());
    expect(await provider.readBranchRules(repo, 'main')).toEqual({
      allowsAutoMerge: 'unknown',
      requiredReviewCount: 'unknown',
      requiredStatusContexts: 'unknown',
      requiredStatusPinnedToApp: 'unknown',
      requiresCodeOwnerReview: 'unknown',
      requiresReviews: 'unknown',
      source: 'unknown',
    });
  });

  it('treats a plain 404 on protection as unknown, not unprotected', async () => {
    octokit.getBranchProtection.mockRejectedValue(notFound());
    octokit.request.mockResolvedValue({ data: [] });
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    const rules = await provider.readBranchRules(repo, 'main');
    expect(rules.requiresReviews).toBe('unknown');
    expect(rules.source).toBe('unknown');
  });

  it('still reports true when the other source is unreadable', async () => {
    octokit.getBranchProtection.mockResolvedValue(protection);
    octokit.request.mockRejectedValue(forbidden());
    octokit.reposGet.mockResolvedValue({ data: {} });
    expect(await provider.readBranchRules(repo, 'main')).toMatchObject({
      allowsAutoMerge: 'unknown',
      requiredReviewCount: 'unknown',
      requiresCodeOwnerReview: true,
      requiresReviews: true,
      source: 'protection',
    });
  });

  it('never throws on a server error from a source', async () => {
    octokit.getBranchProtection.mockRejectedValue(
      Object.assign(new Error('bad gateway'), { status: 502 })
    );
    octokit.request.mockRejectedValue(new Error('network'));
    octokit.reposGet.mockRejectedValue(new Error('network'));
    expect((await provider.readBranchRules(repo, 'main')).source).toBe('unknown');
  });
});

describe('readBranchRules: requiredStatusPinnedToApp', () => {
  const CTX = 'auto-swe/pr-evaluation';
  const classic = (checks: unknown[], contexts: string[] = []) => ({
    data: { required_status_checks: { checks, contexts } },
  });
  const ruleset = (checks: unknown[]) => ({
    data: [{ parameters: { required_status_checks: checks }, type: 'required_status_checks' }],
  });
  const OURS = 15368;
  const read = async (p: unknown, r: unknown, expectedAppId: number | null = OURS) => {
    if (p instanceof Error) {
      octokit.getBranchProtection.mockRejectedValue(p);
    } else {
      octokit.getBranchProtection.mockResolvedValue(p);
    }
    octokit.request.mockResolvedValue(r);
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    return (await provider.readBranchRules(repo, 'main', CTX, expectedAppId))
      .requiredStatusPinnedToApp;
  };
  const noProtection = Object.assign(new Error('Branch not protected'), { status: 404 });

  it('is true when classic protection pins the context to an app', async () => {
    expect(await read(classic([{ app_id: 15368, context: CTX }]), { data: [] })).toBe(true);
  });

  it('is true when a ruleset pins the context with an integration_id', async () => {
    expect(await read(noProtection, ruleset([{ context: CTX, integration_id: OURS }]))).toBe(true);
  });

  it('is false when the context is pinned to a different app (any workflow can post it)', async () => {
    expect(await read(classic([{ app_id: 9, context: CTX }]), { data: [] })).toBe(false);
    expect(await read(classic([{ app_id: 15368, context: CTX }]), { data: [] }, 77)).toBe(false);
    expect(await read(noProtection, ruleset([{ context: CTX, integration_id: 9 }]))).toBe(false);
    expect(await read(classic([{ app_id: -1, context: CTX }]), { data: [] })).toBe(false);
  });

  it('is unknown when no expected app id is known (a personal access token cannot be pinned)', async () => {
    expect(await read(classic([{ app_id: OURS, context: CTX }]), { data: [] }, null)).toBe(
      'unknown'
    );
  });

  it('is false when the context is required with no app (classic null app_id, legacy contexts)', async () => {
    expect(await read(classic([{ app_id: null, context: CTX }]), { data: [] })).toBe(false);
    expect(await read(classic([], [CTX]), { data: [] })).toBe(false);
    expect(await read(noProtection, ruleset([{ context: CTX }]))).toBe(false);
  });

  it('is false when either source requires it unpinned (conservative combination)', async () => {
    expect(await read(classic([{ app_id: OURS, context: CTX }]), ruleset([{ context: CTX }]))).toBe(
      false
    );
  });

  it('is unknown when the context is not listed, a source is unreadable, or no context is given', async () => {
    expect(await read(classic([{ app_id: OURS, context: 'other' }]), { data: [] })).toBe('unknown');
    expect(await read(Object.assign(new Error('Forbidden'), { status: 403 }), { data: [] })).toBe(
      'unknown'
    );
    octokit.getBranchProtection.mockResolvedValue(classic([{ app_id: OURS, context: CTX }]));
    octokit.request.mockResolvedValue({ data: [] });
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    expect((await provider.readBranchRules(repo, 'main')).requiredStatusPinnedToApp).toBe(
      'unknown'
    );
  });
});

describe('readBranchRules: requiresReviews means at least one approving review', () => {
  const read = async (p: unknown, r: unknown) => {
    octokit.getBranchProtection.mockResolvedValue(p);
    octokit.request.mockResolvedValue(r);
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    return provider.readBranchRules(repo, 'main');
  };
  const noRulesets = { data: [] };
  const classic = (count: number) => ({
    data: { required_pull_request_reviews: { required_approving_review_count: count } },
  });
  const ruleset = (count: number) => ({
    data: [{ parameters: { required_approving_review_count: count }, type: 'pull_request' }],
  });

  it('classic protection with 0 required approvals does not require reviews', async () => {
    expect(await read(classic(0), noRulesets)).toMatchObject({
      requiredReviewCount: 0,
      requiresReviews: false,
    });
  });

  it('classic protection with 1 or more required approvals requires reviews', async () => {
    expect(await read(classic(1), noRulesets)).toMatchObject({ requiresReviews: true });
    expect(await read(classic(2), noRulesets)).toMatchObject({ requiresReviews: true });
  });

  it('a ruleset pull_request rule with 0 required approvals does not require reviews', async () => {
    const none = Object.assign(new Error('Branch not protected'), { status: 404 });
    octokit.getBranchProtection.mockRejectedValue(none);
    octokit.request.mockResolvedValue(ruleset(0));
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    expect(await provider.readBranchRules(repo, 'main')).toMatchObject({
      requiredReviewCount: 0,
      requiresReviews: false,
    });
  });

  it('a ruleset pull_request rule with 1 or more required approvals requires reviews', async () => {
    const none = Object.assign(new Error('Branch not protected'), { status: 404 });
    octokit.getBranchProtection.mockRejectedValue(none);
    octokit.request.mockResolvedValue(ruleset(1));
    octokit.reposGet.mockResolvedValue({ data: { allow_auto_merge: true } });
    expect(await provider.readBranchRules(repo, 'main')).toMatchObject({ requiresReviews: true });
  });
});

describe('GraphQL mutations', () => {
  beforeEach(() => {
    octokit.pullsGet.mockResolvedValue(prData());
  });

  it('enableAutoMerge sends expectedHeadOid and the merge method', async () => {
    octokit.graphql.mockResolvedValue({});
    expect(
      await provider.enableAutoMerge(repo, 7, { expectedHeadSha: 'abc123', method: 'SQUASH' })
    ).toEqual({ ok: true });
    const [query, vars] = octokit.graphql.mock.calls[0] ?? [];
    expect(query).toContain('enablePullRequestAutoMerge');
    expect(query).toContain('expectedHeadOid: $oid');
    expect(vars).toEqual({ id: 'PR_node', method: 'SQUASH', oid: 'abc123' });
  });

  it('enableAutoMerge refuses an empty expected head without calling the host', async () => {
    const res = await provider.enableAutoMerge(repo, 7, { expectedHeadSha: '', method: 'MERGE' });
    expect(res.ok).toBe(false);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it('disableAutoMerge sends the PR node id', async () => {
    octokit.graphql.mockResolvedValue({});
    expect(await provider.disableAutoMerge(repo, 7)).toEqual({ ok: true });
    expect(octokit.graphql.mock.calls[0]?.[0]).toContain('disablePullRequestAutoMerge');
  });

  it('reports a GraphQL error payload as a refusal', async () => {
    octokit.graphql.mockRejectedValue(
      Object.assign(new Error('Head branch was modified'), { errors: [{ message: 'x' }] })
    );
    expect(
      await provider.enableAutoMerge(repo, 7, { expectedHeadSha: 'old', method: 'SQUASH' })
    ).toEqual({ ok: false, reason: 'Head branch was modified' });
  });

  it('reports a 403 as a refusal and rethrows other errors', async () => {
    octokit.graphql.mockRejectedValueOnce(forbidden());
    expect((await provider.disableAutoMerge(repo, 7)).ok).toBe(false);
    octokit.graphql.mockRejectedValueOnce(new Error('network'));
    await expect(provider.disableAutoMerge(repo, 7)).rejects.toThrow('network');
  });

  it('reports a missing pull request without calling GraphQL', async () => {
    octokit.pullsGet.mockRejectedValue(notFound());
    for (const res of [
      await provider.disableAutoMerge(repo, 7),
      await provider.enableAutoMerge(repo, 7, { expectedHeadSha: 'a', method: 'SQUASH' }),
    ]) {
      expect(res).toEqual({ ok: false, reason: 'pull request not found' });
    }
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});
