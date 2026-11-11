import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getScmProvider } from '../lib/scm/index.js';
import type { RepoRef } from '../lib/scm/types.js';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * Inline pull-request finding comments against real GitHub: the path the review network and the
 * PR-feedback responder use to put a comment on a line of a changed file.
 *
 * The suite cuts a branch on the fixture repository, commits one file through the contents API,
 * opens a pull request with the platform's own SCM provider, posts a review with one inline
 * comment through `createReview`, and reads the comment back from GitHub (REST for the comment,
 * GraphQL for the review thread). It then closes the pull request and deletes the branch.
 *
 * The provider resolves the GitHub credential the way the worker does, from the database with the
 * `GITHUB_TOKEN` fallback, so `DATABASE_URL` must point at the migrated stack database
 * (`LIVE_E2E_DATABASE_URL` names the same one). Opt in with `LIVE_GITHUB_REVIEW=1`.
 */
const REQUIRED = ['GITHUB_TOKEN', 'LIVE_E2E_FIXTURE_REPO', 'LIVE_E2E_DATABASE_URL'] as const;
const gate = liveGate(
  'github review comments',
  'LIVE_GITHUB_REVIEW',
  process.env.LIVE_GITHUB_REVIEW === '1',
  REQUIRED
);

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${liveEnv('GITHUB_TOKEN')}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    method,
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

describe.skipIf(!gate.enabled)(liveTitle('live GitHub inline review comments', gate), () => {
  const provider = getScmProvider({ scmProvider: 'github' });
  const branch = `live-review-${Date.now().toString(36)}`;
  const file = 'src/live-review-target.js';
  let repo: RepoRef;
  let slug: string;
  let prNumber: number | undefined;
  let commitId: string;

  beforeAll(() => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must be the stack database named by LIVE_E2E_DATABASE_URL'
    ).toBe(liveEnv('LIVE_E2E_DATABASE_URL'));
    slug = liveEnv('LIVE_E2E_FIXTURE_REPO');
    const [organizationName, repoName] = slug.split('/') as [string, string];
    repo = { installationHost: null, organizationName, repoName, scmProvider: 'github' };
  });

  afterAll(async () => {
    if (prNumber !== undefined) {
      await github('PATCH', `/repos/${slug}/pulls/${prNumber}`, { state: 'closed' }).catch(
        () => undefined
      );
    }
    await provider.deleteBranch(repo, branch).catch(() => undefined);
  });

  it('opens a pull request and posts a review with an inline comment on a line', async () => {
    const base = await provider.branchHeadSha(repo, 'main');
    expect(base, 'the fixture repository has a main branch').toBeTruthy();
    expect(await provider.createBranch(repo, branch, base as string)).toBe('created');

    const committed = await github<{ commit: { sha: string } }>(
      'PUT',
      `/repos/${slug}/contents/${file}`,
      {
        branch,
        content: Buffer.from('export const live = true;\nexport const second = 2;\n').toString(
          'base64'
        ),
        message: 'chore: add a file for the live review check',
      }
    );
    commitId = committed.commit.sha;

    const pr = await provider.createOrUpdatePullRequest({
      baseBranch: 'main',
      body: 'Opened by the auto-swe live review check. Safe to close.',
      headBranch: branch,
      repo,
      reuseExisting: true,
      title: 'chore: live review check',
    });
    prNumber = pr.prNumber;

    const review = await provider.createReview(repo, pr.prNumber, {
      body: 'Live review check.',
      comments: [{ body: 'Inline finding from the live check.', line: 2, path: file }],
      commitId,
    });
    expect(review).toMatchObject({ ok: true });
  }, 120_000);

  it('reads the inline comment back from GitHub', async () => {
    expect(prNumber, 'the previous test opens the pull request').toBeDefined();
    const comments = await github<Array<{ body: string; line: number | null; path: string }>>(
      'GET',
      `/repos/${slug}/pulls/${prNumber}/comments`
    );
    const ours = comments.find((c) => c.body.includes('Inline finding from the live check.'));
    expect(ours).toMatchObject({ line: 2, path: file });

    const threads = await provider.listReviewThreads(repo, prNumber as number);
    expect(
      threads.some((t) =>
        t.comments.some((c) => c.body.includes('Inline finding from the live check.'))
      )
    ).toBe(true);
  }, 60_000);
});
