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

import { prisma } from '@auto-swe/shared/db';
import {
  CredentialUnreadableError,
  repositoryHostsAllowed,
  resolveUserCredential,
  resolveUserCredentialPolicy,
} from '@auto-swe/shared/lib/connectionCredential';
import {
  hostKey,
  installationTargetFor,
  platformCredentialScope as scopeOf,
} from '@auto-swe/shared/lib/githubHostScope';
import { fetchRepoPermission } from '@auto-swe/shared/lib/githubPermission';
import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { GitHubTokenMissingError, requireGitHubToken, resolveGitHubToken } from '../githubAuth.js';
import { currentRunLauncherId } from '../runLauncher.js';
import { normalizeCiStatus, pickLogsUrl } from './ciStatus.js';
import type {
  CiStatusResult,
  CloneCredentials,
  CreatePullRequestInput,
  PermissionLookup,
  PullRequestRef,
  RepoRef,
  ScmProvider,
} from './types.js';

/** The web and API bases `repo` actually lives on. */
function repoHosts(repo: RepoRef, ghConfig: { baseUrl: string; apiUrl: string }) {
  return { apiUrl: repo.apiUrl ?? ghConfig.apiUrl, baseUrl: repo.baseUrl ?? ghConfig.baseUrl };
}

type PlatformConfig = { baseUrl: string; apiUrl: string } & Partial<
  Pick<Awaited<ReturnType<typeof resolveGitHubConfig>>, 'authMode' | 'appId' | 'appPrivateKey'>
>;

/**
 * Where the platform credential may go for `repo` — the shared rule
 * (`@auto-swe/shared/lib/githubHostScope`) over this ref's columns. The
 * gateway, and the shared permission lookup, apply the same function.
 */
function platformCredentialScope(repo: RepoRef, ghConfig: PlatformConfig) {
  return scopeOf(
    { apiUrl: repo.apiUrl, baseUrl: repo.baseUrl, installationId: repo.installationId },
    ghConfig
  );
}

/** Which installation, and at which API host, a repository's credential comes from. */
function installationTarget(repo: RepoRef, ghConfig: { apiUrl: string }) {
  return installationTargetFor(
    { apiUrl: repo.apiUrl, baseUrl: repo.baseUrl, installationId: repo.installationId },
    ghConfig
  );
}

/** The failure for a platform credential that has nowhere valid to go. */
function credentialHostMismatch(repo: RepoRef, ghConfig: PlatformConfig) {
  const host = hostKey(repo.baseUrl ?? repo.apiUrl ?? ghConfig.baseUrl);
  const instanceHost = hostKey(ghConfig.baseUrl);
  return ApplicationFailure.nonRetryable(
    `The repository is on ${host}, which needs its own GitHub App installation (Studio → GitHub installations) or a user's own token. The platform's credential is valid only on the instance's own GitHub host (${instanceHost}) and is not sent elsewhere. Or, if the platform's own credential belongs to ${host}, set the GitHub integration's web and API URLs to ${host}.`,
    'REPO_CREDENTIAL_HOST_MISMATCH'
  );
}

/**
 * A repository whose web host and API host are different hosts: a token minted
 * for one would be sent to the other (the API's token embedded in a clone URL,
 * or a GitHub Enterprise token sent to the instance's web host).
 */
function hostMisconfigured(repo: RepoRef, ghConfig: PlatformConfig) {
  const { apiUrl, baseUrl } = repoHosts(repo, ghConfig);
  return ApplicationFailure.nonRetryable(
    `The repository's web URL (${baseUrl}) and API URL (${apiUrl}) are on different hosts. Set both overrides to the same host, or neither.`,
    'REPO_HOST_MISCONFIGURED'
  );
}

/**
 * The token the current execution's launcher saved for `repo`, when they have
 * a usable one.
 *
 * Keyed on the execution's own launcher, never on the repository alone — a run
 * launched by someone else, or by nobody, gets null here and falls back to the
 * platform credential. `resolveUserCredential` applies the allowlist and the
 * verified-origin binding to the repository's current URLs; this also requires
 * those to be the URLs this ref carries, so a ref loaded before the repository
 * was repointed cannot send the token to the old host.
 *
 * The policy is read first: it is a cached settings read, and on a deployment
 * that never enabled the feature it spares every GitHub call a database round
 * trip and a new way to fail.
 */
async function launcherToken(
  repo: RepoRef,
  ghConfig: { baseUrl: string; apiUrl: string }
): Promise<string | null> {
  if (!repo.connectionId) {
    return null;
  }
  if (!(await resolveUserCredentialPolicy()).enabled) {
    return null;
  }
  const launcherId = await currentRunLauncherId();
  if (!launcherId) {
    return null;
  }
  let credential: Awaited<ReturnType<typeof resolveUserCredential>>;
  try {
    credential = await resolveUserCredential(prisma, {
      connectionId: repo.connectionId,
      userId: launcherId,
    });
  } catch (err) {
    // Unreadable is a standing condition, not a transient one: fail now with
    // what the owner has to do, instead of retrying to exhaustion. Any other
    // error (the database) stays retryable.
    if (err instanceof CredentialUnreadableError) {
      throw ApplicationFailure.nonRetryable(err.message, 'CREDENTIAL_UNREADABLE');
    }
    throw err;
  }
  if (!credential) {
    return null;
  }
  const { apiUrl, baseUrl } = repoHosts(repo, ghConfig);
  if (credential.apiUrl !== apiUrl || credential.baseUrl !== baseUrl) {
    return null;
  }
  return credential.token;
}

/**
 * The token a run uses for `repo`: its launcher's own, else the platform's.
 *
 * Throws a non-retryable failure when neither exists, like every other
 * missing-configuration condition.
 */
async function runToken(
  repo: RepoRef,
  ghConfig: Awaited<ReturnType<typeof resolveGitHubConfig>>
): Promise<string> {
  // Before any credential goes anywhere: the repository's own URL overrides
  // must be on an approved host, or a team lead could point a repository at a
  // host they control and collect the token. Standing configuration, so it
  // fails the activity outright rather than retrying.
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.apiUrl,
    githubUrl: repo.baseUrl,
  });
  if (!hosts.ok) {
    throw ApplicationFailure.nonRetryable(
      `Repository URL ${hosts.url} is not on an allowed GitHub host. An admin can allow it under the github.repositoryHosts platform setting.`,
      'REPO_HOST_NOT_ALLOWED'
    );
  }
  // Before any token, the user's included: web and API on different hosts
  // would send one host's token to the other, and `cloneCredentials` embeds
  // this token in the web host's clone URL.
  const scope = platformCredentialScope(repo, ghConfig);
  if (scope === 'misconfigured') {
    throw hostMisconfigured(repo, ghConfig);
  }
  const own = await launcherToken(repo, ghConfig);
  if (own) {
    return own;
  }
  if (scope === 'mismatch') {
    throw credentialHostMismatch(repo, ghConfig);
  }
  return requireGitHubToken(ghConfig, installationTarget(repo, ghConfig));
}

/**
 * Build an authenticated Octokit for `repo`.
 *
 * The token and the GHE base URL both come from DB-backed config, so every API
 * call resolves them the same way; this is the one place that knows how. The
 * import is dynamic because `@octokit/rest` is ESM-heavy and only a subset of
 * worker activities ever reach GitHub.
 */
async function octokitFor(repo: RepoRef) {
  const { Octokit } = await import('@octokit/rest');
  const ghConfig = await resolveGitHubConfig();
  const token = await runToken(repo, ghConfig);
  const apiUrl =
    repo.apiUrl ?? (ghConfig.apiUrl !== 'https://api.github.com' ? ghConfig.apiUrl : undefined);
  return new Octokit({ auth: token, ...(apiUrl && { baseUrl: apiUrl }) });
}

/** Wall-clock cap on a CI log download — the URL is third-party data. */
const CI_LOG_FETCH_TIMEOUT_MS = 15_000;

/** Origins the configured GitHub credential may be sent to. */
function trustedGitHubOrigins(ghConfig: { baseUrl: string; apiUrl: string }): string[] {
  const origins: string[] = [];
  for (const raw of [ghConfig.baseUrl, ghConfig.apiUrl]) {
    try {
      origins.push(new URL(raw).origin);
    } catch {
      // A malformed configured URL simply contributes no trusted origin.
    }
  }
  return origins;
}

export type CiLogsTarget = { ok: true; url: URL; trusted: boolean } | { ok: false; reason: string };

/**
 * Decide whether — and how — to fetch a CI logs URL.
 *
 * The URL is not ours: it is a check-run `html_url`, a commit-status
 * `target_url` (set by whichever integration posted the status), or a webhook
 * payload field. Two things follow. It goes through the SSRF guard like every
 * other externally-supplied URL the worker fetches, and the configured GitHub
 * token is attached ONLY when the target is https on the configured GitHub
 * origin (web or API host) — a status whose `target_url` points anywhere else
 * must not receive a bearer token that can read and push to every repository
 * the credential covers. Per-repo GHE overrides (`RepoRef.baseUrl`) are not
 * consulted here because the log URL arrives without its repository; such a
 * deployment's logs are fetched unauthenticated.
 */
export function resolveCiLogsTarget(logsUrl: string, trustedOrigins: string[]): CiLogsTarget {
  const safety = isSafeProbeUrl(logsUrl);
  if (!safety.ok) {
    return { ok: false, reason: safety.reason };
  }
  const trusted = safety.url.protocol === 'https:' && trustedOrigins.includes(safety.url.origin);
  return { ok: true, trusted, url: safety.url };
}

export class GitHubScmProvider implements ScmProvider {
  async cloneCredentials(repo: RepoRef): Promise<CloneCredentials> {
    const ghConfig = await resolveGitHubConfig();
    const baseUrl = repo.baseUrl ?? ghConfig.baseUrl;
    const cloneUrl = `${baseUrl}/${repo.organizationName}/${repo.repoName}.git`;
    const token = await runToken(repo, ghConfig);
    return {
      authedCloneUrl: cloneUrl.replace('https://', `https://x-access-token:${token}@`),
      cloneUrl,
      token,
    };
  }

  async createOrUpdatePullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const { repo } = input;
    const octokit = await octokitFor(repo);

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
    const octokit = await octokitFor(repo);

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

  async fetchCiLogs(logsUrl: string, repo?: RepoRef): Promise<string> {
    const ghConfig = await resolveGitHubConfig();
    const target = resolveCiLogsTarget(logsUrl, trustedGitHubOrigins(ghConfig));
    if (!target.ok) {
      return `Cannot fetch CI logs — refusing to fetch '${logsUrl}': ${target.reason}`;
    }
    // Web and API on different hosts: no token of any kind is attached.
    if (repo && platformCredentialScope(repo, ghConfig) === 'misconfigured') {
      return `Cannot fetch CI logs — the repository's web URL and API URL are on different hosts (${hostMisconfigured(repo, ghConfig).message})`;
    }
    let githubToken: string | null = null;
    // A launcher's own token goes only to the repository's own hosts, which
    // are the ones checked against the allowlist when it was resolved — not to
    // the instance-wide origins `trusted` is computed from, which a repository
    // on a GitHub Enterprise override does not share.
    const userToken = repo ? await launcherToken(repo, ghConfig) : null;
    if (userToken && repo) {
      const own = resolveCiLogsTarget(logsUrl, trustedGitHubOrigins(repoHosts(repo, ghConfig)));
      if (own.ok && own.trusted) {
        githubToken = userToken;
      }
    }
    // The platform credential goes only where it is valid: the instance's
    // origins for the instance's credential, the repository's own origins for
    // its own installation's, and nowhere for a repository on another host
    // with neither.
    const scope = repo ? platformCredentialScope(repo, ghConfig) : 'instance';
    const platformTrusted =
      scope === 'instance'
        ? target.trusted
        : scope === 'own-installation' && repo
          ? (() => {
              const own = resolveCiLogsTarget(
                logsUrl,
                trustedGitHubOrigins(repoHosts(repo, ghConfig))
              );
              return own.ok && own.trusted;
            })()
          : false;
    if (!githubToken && (platformTrusted || target.trusted)) {
      // The platform credential — an App JWT, when minting an installation token
      // — goes to this repository's own API host. Every other route to a token
      // checks the repository's overrides first; this one reaches the minting
      // call directly, so it checks here too rather than relying on the caller.
      if (repo) {
        const hosts = await repositoryHostsAllowed({
          githubApiUrl: repo.apiUrl,
          githubUrl: repo.baseUrl,
        });
        if (!hosts.ok) {
          return `Cannot fetch CI logs — repository URL ${hosts.url} is not on an allowed GitHub host`;
        }
      }
    }
    if (!githubToken && platformTrusted) {
      try {
        // `repo` is optional because a logs URL can arrive without one, but
        // when it is available the token must come from that repository's
        // installation — the singleton's credential cannot read a repo on a
        // different installation, and the fix loop would run blind on a 404.
        githubToken = await resolveGitHubToken(
          ghConfig,
          repo ? installationTarget(repo, ghConfig) : {}
        );
      } catch (err) {
        if (!(err instanceof GitHubTokenMissingError)) {
          // Real auth error (e.g. malformed App credentials) — surface it so the
          // operator knows why the log fetch failed rather than seeing a 401.
          return `Cannot fetch CI logs — GitHub auth error: ${err instanceof Error ? err.message : String(err)}`;
        }
        // No token configured at all: proceed unauthenticated for public repos.
      }
    }
    const response = await fetch(target.url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(CI_LOG_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return `Failed to fetch CI logs (HTTP ${response.status}): ${await response.text().catch(() => 'no body')}`;
    }

    const fullLog = await response.text();
    // Truncate to last 50KB to fit in LLM context
    return fullLog.slice(-50_000);
  }

  async fetchFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
    const octokit = await octokitFor(repo);

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

  async repoPermission(repo: RepoRef, username: string): Promise<PermissionLookup> {
    // The platform token goes to the repository's API host; an unapproved one
    // gets no token, which is "could not ask", never a denial.
    if (!(await repositoryHostsAllowed({ githubApiUrl: repo.apiUrl })).ok) {
      return { failure: 'credential-rejected', ok: false };
    }
    const ghConfig = await resolveGitHubConfig();
    // Not the instance's credential, and not the instance's API: either would
    // answer for a repository on another host.
    const scope = platformCredentialScope(repo, ghConfig);
    if (scope === 'mismatch' || scope === 'misconfigured') {
      return { failure: 'credential-rejected', ok: false };
    }
    const target = installationTarget(repo, ghConfig);
    let token: string;
    try {
      token = await resolveGitHubToken(ghConfig, target);
    } catch {
      // No usable credential is "could not ask", not "no access". Resolving it
      // to a verdict would write a denial into the projection that GitHub never
      // made, and it would look identical to a real one.
      return { failure: 'credential-rejected', ok: false };
    }
    return fetchRepoPermission({
      apiUrl: target.apiUrl,
      organizationName: repo.organizationName,
      repoName: repo.repoName,
      token,
      username,
    });
  }
}
