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

const a = vi.hoisted(() => ({
  createComment: vi.fn(),
  download: vi.fn(),
  getAttempt: vi.fn(),
  getBranch: vi.fn(),
  listComments: vi.fn(),
  listJobs: vi.fn(),
  pullsGet: vi.fn(),
  updateComment: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    actions = {
      downloadJobLogsForWorkflowRun: a.download,
      getWorkflowRunAttempt: a.getAttempt,
      listJobsForWorkflowRunAttempt: a.listJobs,
    };
    issues = {
      createComment: a.createComment,
      listComments: a.listComments,
      updateComment: a.updateComment,
    };
    pulls = { get: a.pullsGet };
    repos = { getBranch: a.getBranch };
  },
}));

import { GitHubScmProvider, parseRunId } from './github.js';
import type { RepoRef } from './types.js';

const repo = { organizationName: 'acme', repoName: 'api' } as unknown as RepoRef;
const run = {
  conclusion: 'failure',
  event: 'push',
  head_branch: 'main',
  head_repository: { full_name: 'acme/api' },
  head_sha: 'abc',
  html_url: 'https://github.com/acme/api/actions/runs/9',
  id: 9,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  pull_requests: [],
  repository: { full_name: 'acme/api' },
  run_attempt: 2,
  status: 'completed',
};

beforeEach(() => {
  for (const f of Object.values(a)) {
    f.mockReset();
  }
});

describe('parseRunId', () => {
  it('accepts only exact decimal run ids', () => {
    expect(parseRunId('12345678901')).toBe(12345678901);
    for (const bad of ['', '0', '01', '-1', '1.5', '1e3', 'https://x', '99999999999999999']) {
      expect(parseRunId(bad)).toBeNull();
    }
  });
});

describe('GitHubScmProvider.fetchWorkflowRunFailure', () => {
  it('reads the run, its failed jobs and the end of their logs from the repository itself', async () => {
    a.getAttempt.mockResolvedValue({ data: run });
    a.listJobs.mockResolvedValue({
      data: {
        jobs: [
          { conclusion: 'success', html_url: null, id: 1, name: 'lint', steps: [] },
          {
            conclusion: 'failure',
            html_url: 'https://github.com/acme/api/actions/runs/9/job/2',
            id: 2,
            name: 'test',
            steps: [
              { conclusion: 'success', name: 'Checkout' },
              { conclusion: 'failure', name: 'Run tests' },
            ],
          },
        ],
      },
    });
    a.download.mockResolvedValue({ data: `${'x'.repeat(20_000)}TAIL` });
    const out = await new GitHubScmProvider().fetchWorkflowRunFailure(repo, '9', 2);
    expect(a.getAttempt).toHaveBeenCalledWith({
      attempt_number: 2,
      owner: 'acme',
      repo: 'api',
      run_id: 9,
    });
    expect(out.run).toMatchObject({
      attempt: 2,
      headBranch: 'main',
      id: '9',
      repositoryFullName: 'acme/api',
    });
    expect(out.failedJobs).toHaveLength(1);
    expect(out.failedJobs[0]).toMatchObject({ failedSteps: ['Run tests'], name: 'test' });
    expect(out.failedJobs[0]?.log.endsWith('TAIL')).toBe(true);
    expect(out.failedJobs[0]?.log.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps going when one job log cannot be read', async () => {
    a.getAttempt.mockResolvedValue({ data: run });
    a.listJobs.mockResolvedValue({
      data: { jobs: [{ conclusion: 'failure', html_url: null, id: 2, name: 'test', steps: [] }] },
    });
    a.download.mockRejectedValue(Object.assign(new Error('gone'), { status: 410 }));
    const out = await new GitHubScmProvider().fetchWorkflowRunFailure(repo, '9', 1);
    expect(out.failedJobs[0]).toMatchObject({ log: '', logUnavailable: 'HTTP 410' });
  });

  it('fails non-retryably on a missing run or a credential without Actions access', async () => {
    a.getAttempt.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    await expect(
      new GitHubScmProvider().fetchWorkflowRunFailure(repo, '9', 1)
    ).rejects.toMatchObject({ nonRetryable: true, type: 'CI_RUN_NOT_FOUND' });
    a.getAttempt.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(
      new GitHubScmProvider().fetchWorkflowRunFailure(repo, '9', 1)
    ).rejects.toMatchObject({ nonRetryable: true, type: 'CI_RUN_FORBIDDEN' });
  });

  it('refuses a run reference that is not a run id, before any request', async () => {
    await expect(
      new GitHubScmProvider().fetchWorkflowRunFailure(repo, '../../contents', 1)
    ).rejects.toMatchObject({ type: 'CI_RUN_INVALID' });
    expect(a.getAttempt).not.toHaveBeenCalled();
  });
});

describe('GitHubScmProvider.branchHeadSha', () => {
  it('is the branch tip, or null when no branch has the name', async () => {
    a.getBranch.mockResolvedValueOnce({ data: { commit: { sha: 'def' } } });
    await expect(new GitHubScmProvider().branchHeadSha(repo, 'main')).resolves.toBe('def');
    a.getBranch.mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404 }));
    await expect(new GitHubScmProvider().branchHeadSha(repo, 'v1.0')).resolves.toBeNull();
  });
});

describe('GitHubScmProvider.upsertMarkedComment', () => {
  it('edits the newest comment carrying the marker', async () => {
    a.listComments.mockResolvedValue({
      data: [
        { body: 'unrelated', id: 1 },
        { body: '<!-- m --> old', id: 2 },
      ],
    });
    a.updateComment.mockResolvedValue({ data: { html_url: 'https://x/c/2' } });
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(a.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }));
    expect(out).toEqual({ htmlUrl: 'https://x/c/2', updated: true });
    expect(a.createComment).not.toHaveBeenCalled();
  });

  it('posts a new comment when there is none, or the marked one is not ours to edit', async () => {
    a.listComments.mockResolvedValue({ data: [{ body: '<!-- m --> theirs', id: 3 }] });
    a.updateComment.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    a.createComment.mockResolvedValue({ data: { html_url: 'https://x/c/4' } });
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(out).toEqual({ htmlUrl: 'https://x/c/4', updated: false });
  });
});
