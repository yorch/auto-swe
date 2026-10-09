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
const cred = vi.hoisted(() => ({ appId: null as string | null }));
vi.mock('@auto-swe/shared/lib/githubHostCredential', () => ({
  resolvePlatformCredential: vi.fn(async () => ({
    config: { apiUrl: 'https://api.github.com', appId: cred.appId, baseUrl: 'https://github.com' },
    scope: 'instance',
  })),
}));
vi.mock('../runLauncher.js', () => ({ currentRunLauncherId: vi.fn(async () => null) }));

const a = vi.hoisted(() => ({
  createComment: vi.fn(),
  getAttempt: vi.fn(),
  getAuth: vi.fn(),
  getBranch: vi.fn(),
  listComments: vi.fn(),
  listJobs: vi.fn(),
  pullsGet: vi.fn(),
  updateComment: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    actions = {
      getWorkflowRunAttempt: a.getAttempt,
      listJobsForWorkflowRunAttempt: a.listJobs,
    };
    issues = {
      createComment: a.createComment,
      listComments: a.listComments,
      updateComment: a.updateComment,
    };
    paginate = {
      // One page per listComments result, as the real iterator yields.
      iterator: async function* (
        fn: (p: unknown) => Promise<{ data: unknown[] }>,
        params: unknown
      ) {
        const pages = (await fn(params)) as unknown as { data: unknown[] }[] | { data: unknown[] };
        for (const page of Array.isArray(pages) ? pages : [pages]) {
          yield page;
        }
      },
    };
    pulls = { get: a.pullsGet };
    repos = { getBranch: a.getBranch };
    users = { getAuthenticated: a.getAuth };
  },
}));

import { GitHubScmProvider, parseRunId, readTail } from './github.js';
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
    const scm = new GitHubScmProvider();
    const download = vi
      .spyOn(scm as unknown as { downloadCiLogs: () => Promise<unknown> }, 'downloadCiLogs')
      .mockResolvedValue({ ok: true, text: `${'x'.repeat(20_000)}TAIL` });
    const out = await scm.fetchWorkflowRunFailure(repo, '9', 2);
    // The job log is read from the repository's own API, through the guarded download.
    expect(download).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/api/actions/jobs/2/logs',
      repo
    );
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
    const scm = new GitHubScmProvider();
    vi.spyOn(
      scm as unknown as { downloadCiLogs: () => Promise<unknown> },
      'downloadCiLogs'
    ).mockResolvedValue({
      error: 'Failed to fetch CI logs (HTTP 410): gone',
      ok: false,
    });
    const out = await scm.fetchWorkflowRunFailure(repo, '9', 1);
    expect(out.failedJobs[0]).toMatchObject({
      log: '',
      logUnavailable: 'Failed to fetch CI logs (HTTP 410): gone',
    });
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
  const ours = { body: '<!-- m --> old', id: 2, user: { login: 'platform-bot' } };

  beforeEach(() => {
    a.getAuth.mockResolvedValue({ data: { login: 'platform-bot' } });
    a.updateComment.mockResolvedValue({ data: { html_url: 'https://x/c/2' } });
    a.createComment.mockResolvedValue({ data: { html_url: 'https://x/c/new' } });
  });

  it("edits the newest of the platform's own marked comments, on any page", async () => {
    a.listComments.mockResolvedValue([
      { data: [{ body: '<!-- m --> first', id: 1, user: { login: 'platform-bot' } }] },
      { data: [{ body: 'unrelated', id: 5, user: { login: 'alice' } }, ours] },
    ]);
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(a.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }));
    expect(out).toEqual({ htmlUrl: 'https://x/c/2', updated: true });
    expect(a.createComment).not.toHaveBeenCalled();
  });

  it("never edits someone else's comment that carries the marker", async () => {
    a.listComments.mockResolvedValue({
      data: [{ body: '<!-- m --> planted', id: 3, user: { login: 'mallory' } }],
    });
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(a.updateComment).not.toHaveBeenCalled();
    expect(out).toEqual({ htmlUrl: 'https://x/c/new', updated: false });
  });

  it('recognises an App installation by the app GitHub stamps on its comments', async () => {
    a.getAuth.mockRejectedValue(Object.assign(new Error('integration'), { status: 403 }));
    cred.appId = '41';
    a.listComments.mockResolvedValue({
      data: [
        {
          body: '<!-- m -->',
          id: 4,
          performed_via_github_app: { id: 41 },
          user: { login: 'app[bot]' },
        },
        {
          body: '<!-- m -->',
          id: 6,
          performed_via_github_app: { id: 99 },
          user: { login: 'other[bot]' },
        },
      ],
    });
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(a.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 4 }));
    expect(out.updated).toBe(true);
    cred.appId = null;
  });

  it('edits nothing when it cannot tell which comments are its own', async () => {
    a.getAuth.mockRejectedValue(Object.assign(new Error('integration'), { status: 403 }));
    a.listComments.mockResolvedValue({
      data: [{ body: '<!-- m -->', id: 4, performed_via_github_app: { id: 41 } }],
    });
    const out = await new GitHubScmProvider().upsertMarkedComment(repo, 7, '<!-- m -->', 'new');
    expect(a.listComments).not.toHaveBeenCalled();
    expect(out.updated).toBe(false);
  });
});

describe('readTail', () => {
  it('keeps only the end of a large streamed body', async () => {
    const chunks = Array.from(
      { length: 50 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(998)}`
    );
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c));
        }
        controller.close();
      },
    });
    const tail = await readTail(new Response(body), 1_500);
    expect(tail).toHaveLength(1_500);
    expect(tail.endsWith('x'.repeat(998))).toBe(true);
    expect(tail).toContain('49');
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('añb');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    await expect(readTail(new Response(body), 10)).resolves.toBe('añb');
  });
});
