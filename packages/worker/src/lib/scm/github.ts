/**
 * GitHub implementation of the `ScmProvider` seam.
 *
 * This is moved logic, not new logic:
 *   - clone URL construction + `x-access-token:` embedding previously lived
 *     in workspace.ts / shellStep.ts and each provisioning activity
 *   - PR create-or-reuse previously lived in createOrUpdatePullRequest.ts
 *   - CI log fetching previously lived in ciFixLoop.ts
 *
 * Token resolution (PAT vs. GitHub App installation token) stays in
 * `../githubAuth.ts` — it is a GitHub-internal concern behind this provider.
 */

import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { GitHubTokenMissingError, requireGitHubToken, resolveGitHubToken } from '../githubAuth.js';
import type {
  CloneCredentials,
  CreatePullRequestInput,
  PullRequestRef,
  RepoRef,
  ScmProvider,
} from './types.js';

export class GitHubScmProvider implements ScmProvider {
  async cloneCredentials(repo: RepoRef): Promise<CloneCredentials> {
    const ghConfig = await resolveGitHubConfig();
    const baseUrl = repo.baseUrl ?? ghConfig.baseUrl;
    const cloneUrl = `${baseUrl}/${repo.organizationName}/${repo.repoName}.git`;
    const token = await requireGitHubToken(ghConfig);
    return {
      authedCloneUrl: cloneUrl.replace('https://', `https://x-access-token:${token}@`),
      cloneUrl,
      token,
    };
  }

  async createOrUpdatePullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const { Octokit } = await import('@octokit/rest');
    const { repo } = input;

    const ghConfig = await resolveGitHubConfig();
    const token = await requireGitHubToken(ghConfig);
    const apiUrl =
      repo.apiUrl ?? (ghConfig.apiUrl !== 'https://api.github.com' ? ghConfig.apiUrl : undefined);
    const octokit = new Octokit({
      auth: token,
      ...(apiUrl && { baseUrl: apiUrl }),
    });

    // Reuse an already-open PR for this head branch if GitHub has one. This
    // makes the operation idempotent across retries: if a prior attempt
    // created the PR on GitHub but crashed before persisting the DB row, the
    // retry finds it here instead of failing with GitHub's 422 "a pull
    // request already exists for this branch". Callers opt in via
    // `reuseExisting` so the extra GitHub round-trip is skipped on first
    // attempts, where no orphaned PR can exist.
    const priorOpenPr = input.reuseExisting
      ? (
          await octokit.pulls.list({
            base: input.baseBranch,
            head: `${repo.organizationName}:${input.headBranch}`,
            owner: repo.organizationName,
            repo: repo.repoName,
            state: 'open',
          })
        ).data[0]
      : undefined;

    const pr =
      priorOpenPr ??
      (
        await octokit.pulls.create({
          base: input.baseBranch,
          body: input.body,
          head: input.headBranch,
          owner: repo.organizationName,
          repo: repo.repoName,
          title: input.title,
        })
      ).data;

    return { prNumber: pr.number, prUrl: pr.html_url };
  }

  async prUrl(repo: RepoRef, prNumber: number): Promise<string> {
    const ghConfig = await resolveGitHubConfig();
    const baseUrl = repo.baseUrl ?? ghConfig.baseUrl;
    return `${baseUrl}/${repo.organizationName}/${repo.repoName}/pull/${prNumber}`;
  }

  async fetchCiLogs(logsUrl: string): Promise<string> {
    const ghConfig = await resolveGitHubConfig();
    let githubToken: string | null = null;
    try {
      githubToken = await resolveGitHubToken(ghConfig);
    } catch (err) {
      if (!(err instanceof GitHubTokenMissingError)) {
        // Real auth error (e.g. malformed App credentials) — surface it so the
        // operator knows why the log fetch failed rather than seeing a 401.
        return `Cannot fetch CI logs — GitHub auth error: ${err instanceof Error ? err.message : String(err)}`;
      }
      // No token configured at all: proceed unauthenticated for public repos.
    }
    const response = await fetch(logsUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
    });

    if (!response.ok) {
      return `Failed to fetch CI logs (HTTP ${response.status}): ${await response.text().catch(() => 'no body')}`;
    }

    const fullLog = await response.text();
    // Truncate to last 50KB to fit in LLM context
    return fullLog.slice(-50_000);
  }
}
