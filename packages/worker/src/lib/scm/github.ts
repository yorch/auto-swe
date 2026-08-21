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
import { normalizeCiStatus, pickLogsUrl } from './ciStatus.js';
import type {
  CiStatusResult,
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

  async fetchCiStatus(repo: RepoRef, ref: string): Promise<CiStatusResult> {
    const { Octokit } = await import('@octokit/rest');
    const ghConfig = await resolveGitHubConfig();
    const token = await requireGitHubToken(ghConfig);
    const apiUrl =
      repo.apiUrl ?? (ghConfig.apiUrl !== 'https://api.github.com' ? ghConfig.apiUrl : undefined);
    const octokit = new Octokit({ auth: token, ...(apiUrl && { baseUrl: apiUrl }) });

    const owner = repo.organizationName;
    const repoName = repo.repoName;

    // Query both surfaces: check-runs (Checks API) + the combined commit status
    // (legacy Statuses API). Either may be empty depending on how the repo runs CI.
    const [checksResp, combinedResp] = await Promise.all([
      octokit.checks.listForRef({ owner, ref, repo: repoName }),
      octokit.repos.getCombinedStatusForRef({ owner, ref, repo: repoName }),
    ]);

    const checkRuns = checksResp.data.check_runs.map((r) => ({
      conclusion: r.conclusion,
      htmlUrl: r.html_url,
      status: r.status,
    }));
    const combined = {
      state: combinedResp.data.state,
      targetUrl: combinedResp.data.statuses[0]?.target_url ?? null,
      totalCount: combinedResp.data.total_count,
    };

    return {
      logsUrl: pickLogsUrl(checkRuns, combined),
      verdict: normalizeCiStatus(checkRuns, combined),
    };
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

  async fetchFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
    const { Octokit } = await import('@octokit/rest');
    const ghConfig = await resolveGitHubConfig();
    const token = await requireGitHubToken(ghConfig);
    const apiUrl =
      repo.apiUrl ?? (ghConfig.apiUrl !== 'https://api.github.com' ? ghConfig.apiUrl : undefined);
    const octokit = new Octokit({ auth: token, ...(apiUrl && { baseUrl: apiUrl }) });

    try {
      const { data } = await octokit.repos.getContent({
        owner: repo.organizationName,
        path,
        repo: repo.repoName,
        ...(ref && { ref }),
      });
      // `data` is an array for a directory, or an object for a file/symlink/
      // submodule. Only a plain file has content to decode.
      if (Array.isArray(data) || data.type !== 'file' || !data.content) {
        return null;
      }
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (err) {
      // A missing manifest is the normal case, not a failure — swallow 404s.
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }
}
