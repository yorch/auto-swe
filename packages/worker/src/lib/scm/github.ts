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
  type PlatformCredential,
  resolvePlatformCredential,
} from '@auto-swe/shared/lib/githubHostCredential';
import { hostKey, installationTargetFor } from '@auto-swe/shared/lib/githubHostScope';
import { PlatformCredentialHostError } from '@auto-swe/shared/lib/githubInstallation';
import { fetchRepoPermission } from '@auto-swe/shared/lib/githubPermission';
import {
  createGuardedFetch,
  createOriginScopedFetch,
} from '@auto-swe/shared/lib/guardedDispatcher';
import { fetchGuarded } from '@auto-swe/shared/lib/guardedFetch';
import { checkProbeUrl, isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { GitHubTokenMissingError, requireGitHubToken, resolveGitHubToken } from '../githubAuth.js';
import { currentRunLauncherId } from '../runLauncher.js';
import { normalizeCiStatus, pickLogsUrl } from './ciStatus.js';
import {
  type BranchInfo,
  type CiStatusResult,
  type CloneCredentials,
  type CommitComparison,
  type CreatePullRequestInput,
  DraftPullRequestUnsupportedError,
  ExistingPullRequestNotDraftError,
  type PermissionLookup,
  type PullRequestInfo,
  type PullRequestRef,
  type RepoRef,
  type ScmProvider,
  type WorkflowRunFailedJob,
  type WorkflowRunFailure,
} from './types.js';

/**
 * GitHub answers a draft request on a repository that cannot have drafts with a
 * 422 whose message names drafts ("Draft pull requests are not supported in this
 * repository"). Matched on status AND message so an unrelated 422 (a missing
 * branch, an existing PR) is not misreported as a draft problem.
 */
function isDraftUnsupported(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  return e?.status === 422 && /draft/i.test(e.message ?? '');
}

/** The web and API bases `repo` actually lives on. */
function repoHosts(repo: RepoRef, ghConfig: { baseUrl: string; apiUrl: string }) {
  return { apiUrl: repo.apiUrl ?? ghConfig.apiUrl, baseUrl: repo.baseUrl ?? ghConfig.baseUrl };
}

type PlatformConfig = Awaited<ReturnType<typeof resolveGitHubConfig>>;

/**
 * Which platform credential set may go to `repo`'s host — the shared rule
 * (`@auto-swe/shared/lib/githubHostCredential`) over this ref's columns. The
 * gateway, and the shared permission lookup, apply the same function.
 */
async function platformCredential(
  repo: RepoRef,
  ghConfig: PlatformConfig
): Promise<PlatformCredential> {
  try {
    return await resolvePlatformCredential(
      {
        apiUrl: repo.apiUrl,
        baseUrl: repo.baseUrl,
        installationHost: repo.installationHost,
        installationId: repo.installationId,
      },
      ghConfig
    );
  } catch (err) {
    // Say which host's credentials could not be loaded, rather than surfacing a
    // bare decryption or database error from deep inside the lookup.
    throw new Error(
      `Could not load the platform GitHub credentials for ${hostKey(repo.baseUrl ?? ghConfig.baseUrl)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/** Which installation a repository's credential comes from, at its credential set's API host. */
function installationTarget(repo: RepoRef, credentialConfig: { apiUrl: string }) {
  return installationTargetFor(
    { apiUrl: repo.apiUrl, baseUrl: repo.baseUrl, installationId: repo.installationId },
    credentialConfig
  );
}

/** The failure for a repository on a host that has no platform credential. */
function credentialHostMismatch(repo: RepoRef, ghConfig: PlatformConfig) {
  const host = hostKey(repo.baseUrl ?? repo.apiUrl ?? ghConfig.baseUrl);
  const instanceHost = hostKey(ghConfig.baseUrl);
  return ApplicationFailure.nonRetryable(
    `The repository is on ${host}, for which no platform GitHub credential is configured. A platform credential is valid only on the host it belongs to (the instance's is ${instanceHost}) and is not sent elsewhere. Ask an admin to add a PAT or GitHub App for ${host} (Studio > Integrations > GitHub > Host credentials), or save your own token for this repository. Or, if the instance's own credential belongs to ${host}, set the GitHub integration's web and API URLs to ${host}.`,
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
  const credential = await platformCredential(repo, ghConfig);
  if (credential.scope === 'misconfigured') {
    throw hostMisconfigured(repo, ghConfig);
  }
  const own = await launcherToken(repo, ghConfig);
  if (own) {
    return own;
  }
  if (credential.scope === 'installation-mismatch') {
    throw ApplicationFailure.nonRetryable(
      `The repository's GitHub App installation is recorded for ${credential.host || "the instance's own host"}, not the host the repository is on. Point the repository at an installation recorded for its host.`,
      'REPO_INSTALLATION_HOST_MISMATCH'
    );
  }
  if (credential.scope === 'mismatch') {
    throw credentialHostMismatch(repo, ghConfig);
  }
  return requireGitHubToken(credential.config, installationTarget(repo, credential.config));
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

/** Characters of a CI log kept: its end, where the failure is. */
const CI_LOG_TAIL_CHARS = 50_000;

/**
 * The last `maxChars` characters of a response body, read as a stream so memory stays
 * bounded by the tail however large the body is. Bytes are decoded as they arrive (a split
 * multi-byte character is carried over by the streaming decoder).
 */
export async function readTail(
  response: Pick<Response, 'body' | 'text'>,
  maxChars: number
): Promise<string> {
  if (!response.body) {
    // A body that cannot be streamed is read whole.
    return (await response.text()).slice(-maxChars);
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    tail += decoder.decode(value, { stream: true });
    if (tail.length > maxChars * 2) {
      tail = tail.slice(-maxChars);
    }
  }
  tail += decoder.decode();
  return tail.slice(-maxChars);
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

/** True when the web or API base is not on github.com, i.e. a GitHub Enterprise host. */
function isEnterpriseHost(hosts: { baseUrl: string; apiUrl: string }): boolean {
  for (const raw of [hosts.baseUrl, hosts.apiUrl]) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host !== 'github.com' && host !== 'api.github.com') {
        return true;
      }
    } catch {
      // An unparsable base adds nothing.
    }
  }
  return false;
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

/** Job and step conclusions that count as failed. */
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out']);
/** At most this many failed jobs have their logs read. */
const MAX_FAILED_JOBS = 5;
/** The tail of each failed job's log kept: the failure is at the end. */
const MAX_JOB_LOG_CHARS = 12_000;

/** The REST URL of a job's log, on the repository's own API host. */
function jobLogsUrl(apiBase: string, repo: RepoRef, jobId: number): string {
  const owner = encodeURIComponent(repo.organizationName);
  const name = encodeURIComponent(repo.repoName);
  return `${apiBase.replace(/\/$/, '')}/repos/${owner}/${name}/actions/jobs/${jobId}/logs`;
}

/** A GitHub run id as a number: decimal digits only, and exact as a JavaScript number. */
export function parseRunId(runId: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(runId)) {
    return null;
  }
  const n = Number(runId);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A failure to read a workflow run, as a non-retryable failure that says what to do:
 * a missing run stays missing, and a credential without Actions read access stays so until
 * an admin changes the App's permissions. Anything else (a 5xx, the network) is retryable.
 */
function actionsReadFailure(err: unknown, what: string): Error {
  const status = (err as { status?: number }).status;
  if (status === 404) {
    return ApplicationFailure.nonRetryable(
      `GitHub has no ${what} in this repository.`,
      'CI_RUN_NOT_FOUND'
    );
  }
  if (status === 401 || status === 403) {
    return ApplicationFailure.nonRetryable(
      `GitHub refused to show ${what} (HTTP ${status}). The platform credential needs ` +
        'read access to Actions (a GitHub App needs the "Actions: Read" permission, accepted ' +
        'on the installation).',
      'CI_RUN_FORBIDDEN'
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** At most this many pages of comments are searched for the platform's own marked comment. */
const MAX_COMMENT_PAGES = 30;

/**
 * Who the platform's comments are written as on `repo`: the login a token authenticates as
 * (a PAT), or, for a GitHub App installation token (which cannot read `GET /user`), the App's
 * id, which GitHub stamps on its comments as `performed_via_github_app`. Undefined when
 * neither can be established; nothing is edited then.
 */
async function commentIdentity(
  octokit: Awaited<ReturnType<typeof octokitFor>>,
  repo: RepoRef
): Promise<{ login?: string; appId?: number } | undefined> {
  try {
    const { data } = await octokit.users.getAuthenticated();
    return { login: data.login };
  } catch {
    // An installation token: fall through to the App id.
  }
  try {
    const credential = await platformCredential(repo, await resolveGitHubConfig());
    if (credential.scope !== 'instance' && credential.scope !== 'host') {
      return undefined;
    }
    const appId = Number(credential.config.appId);
    return Number.isSafeInteger(appId) && appId > 0 ? { appId } : undefined;
  } catch {
    return undefined;
  }
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

    const create = async (): Promise<{ number: number; html_url: string }> => {
      try {
        return (
          await octokit.pulls.create({
            base: input.baseBranch,
            body: input.body,
            // Only sent when asked for, so every existing caller's request is unchanged.
            ...(input.draft ? { draft: true } : {}),
            head: input.headBranch,
            owner: repo.organizationName,
            repo: repo.repoName,
            title: input.title,
          })
        ).data;
      } catch (err) {
        if (input.draft && isDraftUnsupported(err)) {
          throw new DraftPullRequestUnsupportedError(
            `${repo.organizationName}/${repo.repoName} does not support draft pull requests`
          );
        }
        throw err;
      }
    };
    // The list response already says whether it is a draft, so this costs no call.
    if (input.draft && priorOpenPr && priorOpenPr.draft !== true) {
      throw new ExistingPullRequestNotDraftError(
        `${repo.organizationName}/${repo.repoName}#${priorOpenPr.number} is open and ready for review`
      );
    }
    const pr = priorOpenPr ?? (await create());

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
    const result = await this.downloadCiLogs(logsUrl, repo);
    return result.ok ? result.text : result.error;
  }

  /**
   * The download behind {@link fetchCiLogs}, telling a log apart from a reason there is none:
   * the fix loop hands either to a model as text, but a caller that must know whether it got
   * a log (the CI triage) reads `ok`.
   */
  private async downloadCiLogs(
    logsUrl: string,
    repo?: RepoRef
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const ghConfig = await resolveGitHubConfig();
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
        return {
          error: `Cannot fetch CI logs — repository URL ${hosts.url} is not on an allowed GitHub host`,
          ok: false,
        };
      }
    }
    // The platform credential set for this repository's host. Without a
    // repository the logs URL stands alone, and the instance's set is the only
    // one it could belong to.
    const credential: PlatformCredential = repo
      ? await platformCredential(repo, ghConfig)
      : { config: ghConfig, scope: 'instance' };
    // Web and API on different hosts: no token of any kind is attached.
    if (repo && credential.scope === 'misconfigured') {
      return {
        error: `Cannot fetch CI logs — the repository's web URL and API URL are on different hosts (${hostMisconfigured(repo, ghConfig).message})`,
        ok: false,
      };
    }
    // The platform credential is attached only on the origins of the set it
    // belongs to: the instance's, or the repository's host's own. A repository
    // on a host with no set has no trusted origin, so it gets none.
    const platform =
      credential.scope === 'instance' || credential.scope === 'host' ? credential : null;
    const target = resolveCiLogsTarget(
      logsUrl,
      platform ? trustedGitHubOrigins(platform.config) : []
    );
    if (!target.ok) {
      return {
        error: `Cannot fetch CI logs — refusing to fetch '${logsUrl}': ${target.reason}`,
        ok: false,
      };
    }
    let githubToken: string | null = null;
    // A launcher's own token goes only to the repository's own hosts, which
    // are the ones checked against the allowlist when it was resolved — not to
    // the instance-wide origins, which a repository on another host does not
    // share.
    const userToken = repo ? await launcherToken(repo, ghConfig) : null;
    if (userToken && repo) {
      const own = resolveCiLogsTarget(logsUrl, trustedGitHubOrigins(repoHosts(repo, ghConfig)));
      if (own.ok && own.trusted) {
        githubToken = userToken;
      }
    }
    if (!githubToken && platform && target.trusted) {
      try {
        // `repo` is optional because a logs URL can arrive without one, but
        // when it is available the token must come from that repository's
        // installation — the singleton's credential cannot read a repo on a
        // different installation, and the fix loop would run blind on a 404.
        githubToken = await resolveGitHubToken(
          platform.config,
          repo ? installationTarget(repo, platform.config) : {}
        );
      } catch (err) {
        if (!(err instanceof GitHubTokenMissingError)) {
          // Real auth error (e.g. malformed App credentials) — surface it so the
          // operator knows why the log fetch failed rather than seeing a 401.
          return {
            error: `Cannot fetch CI logs — GitHub auth error: ${err instanceof Error ? err.message : String(err)}`,
            ok: false,
          };
        }
        // No token configured at all: proceed unauthenticated for public repos.
      }
    }
    // The origins that may sit on a private network: the credential's own, and
    // the repository's own hosts (vetted by `repositoryHostsAllowed` above) —
    // a repository fetched with the launcher's token may have no platform set.
    const privateOrigins = [
      ...(platform ? trustedGitHubOrigins(platform.config) : []),
      ...(repo ? trustedGitHubOrigins(repoHosts(repo, ghConfig)) : []),
    ];
    // A repository on a GitHub Enterprise host (not github.com) keeps its log
    // storage on the same private network, so every hop of its download may
    // resolve to a private address. Loopback, link-local, unspecified, reserved
    // and metadata addresses stay refused on every hop. A github.com repository
    // resolves strictly everywhere but its own GitHub origins.
    const enterprise = repo ? isEnterpriseHost(repoHosts(repo, ghConfig)) : false;
    // Log downloads redirect (to blob storage), so redirects are followed by
    // hand: every hop passes the SSRF guard and the token goes only to the
    // origin it was resolved for.
    const response = await fetchGuarded(
      target.url.toString(),
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
        signal: AbortSignal.timeout(CI_LOG_FETCH_TIMEOUT_MS),
      },
      {
        check: (hop) =>
          checkProbeUrl(hop.toString(), {
            allowPrivate: enterprise || privateOrigins.includes(hop.origin),
          }).ok,
        credentialOrigin: target.url.origin,
        // The URL is not ours, so each hop is also resolved, checked and pinned.
        fetchImpl: enterprise
          ? createGuardedFetch({ allowPrivate: true })
          : createOriginScopedFetch(privateOrigins),
      }
    );

    if (!response.ok) {
      return {
        error: `Failed to fetch CI logs (HTTP ${response.status}): ${await response.text().catch(() => 'no body')}`,
        ok: false,
      };
    }

    // Only the end is kept (it fits an LLM's context, and the failure is there), and it is kept
    // while streaming: a job log can run to hundreds of megabytes.
    return { ok: true, text: await readTail(response, CI_LOG_TAIL_CHARS) };
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

  async findBranchWork(
    repo: RepoRef,
    branch: string,
    baseBranch: string
  ): Promise<{ branchExists: boolean; aheadBy: number | null; openPr: PullRequestRef | null }> {
    const octokit = await octokitFor(repo);
    let branchExists = true;
    try {
      await octokit.repos.getBranch({ branch, owner: repo.organizationName, repo: repo.repoName });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) {
        throw err;
      }
      branchExists = false;
    }
    // Not caught: a compare that fails must fail the lookup, not read as "nothing ahead".
    const aheadBy = branchExists
      ? (
          await octokit.repos.compareCommits({
            base: baseBranch,
            head: branch,
            owner: repo.organizationName,
            per_page: 1,
            repo: repo.repoName,
          })
        ).data.ahead_by
      : null;
    const open = (
      await octokit.pulls.list({
        head: `${repo.organizationName}:${branch}`,
        owner: repo.organizationName,
        repo: repo.repoName,
        state: 'open',
      })
    ).data[0];
    return {
      aheadBy,
      branchExists,
      openPr: open ? { prNumber: open.number, prUrl: open.html_url } : null,
    };
  }

  async fetchWorkflowRunFailure(
    repo: RepoRef,
    runId: string,
    attempt: number
  ): Promise<WorkflowRunFailure> {
    const runNumber = parseRunId(runId);
    if (runNumber === null || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw ApplicationFailure.nonRetryable(
        `Invalid workflow run reference ${String(runId).slice(0, 40)}#${attempt}`,
        'CI_RUN_INVALID'
      );
    }
    const octokit = await octokitFor(repo);
    const apiBase = repoHosts(repo, await resolveGitHubConfig()).apiUrl;
    const where = { owner: repo.organizationName, repo: repo.repoName, run_id: runNumber };
    let run: Awaited<ReturnType<typeof octokit.actions.getWorkflowRunAttempt>>['data'];
    try {
      run = (await octokit.actions.getWorkflowRunAttempt({ ...where, attempt_number: attempt }))
        .data;
    } catch (err) {
      throw actionsReadFailure(err, `workflow run ${runNumber} (attempt ${attempt})`);
    }
    let jobs: Awaited<
      ReturnType<typeof octokit.actions.listJobsForWorkflowRunAttempt>
    >['data']['jobs'];
    try {
      jobs = (
        await octokit.actions.listJobsForWorkflowRunAttempt({
          ...where,
          attempt_number: attempt,
          per_page: 100,
        })
      ).data.jobs;
    } catch (err) {
      throw actionsReadFailure(err, `the jobs of workflow run ${runNumber}`);
    }
    const failed = jobs
      .filter((j) => j.conclusion !== null && FAILED_JOB_CONCLUSIONS.has(j.conclusion))
      .slice(0, MAX_FAILED_JOBS);
    const failedJobs: WorkflowRunFailedJob[] = [];
    for (const job of failed) {
      const base = {
        conclusion: job.conclusion,
        failedSteps: (job.steps ?? [])
          .filter((st) => st.conclusion !== null && FAILED_JOB_CONCLUSIONS.has(st.conclusion))
          .map((st) => st.name),
        htmlUrl: job.html_url ?? null,
        name: job.name,
      };
      // Through the same download as the fix loop's logs: the API answers with a redirect to
      // short-lived storage, and every hop is checked, pinned and timed out, with the
      // credential sent only to the API's origin.
      const logs = await this.downloadCiLogs(jobLogsUrl(apiBase, repo, job.id), repo);
      failedJobs.push(
        logs.ok
          ? { ...base, log: logs.text.slice(-MAX_JOB_LOG_CHARS) }
          : { ...base, log: '', logUnavailable: logs.error.slice(0, 200) }
      );
    }
    return {
      failedJobs,
      run: {
        attempt: run.run_attempt ?? attempt,
        conclusion: run.conclusion ?? null,
        event: run.event,
        headBranch: run.head_branch ?? null,
        headRepositoryFullName: run.head_repository?.full_name ?? null,
        headSha: run.head_sha,
        htmlUrl: run.html_url,
        id: String(run.id),
        name: run.name ?? '',
        path: run.path ?? '',
        pullRequests: (run.pull_requests ?? []).map((pr) => ({
          baseRef: pr.base.ref,
          headRef: pr.head.ref,
          number: pr.number,
        })),
        repositoryFullName: run.repository.full_name,
        status: run.status ?? null,
      },
    };
  }

  async branchHeadSha(repo: RepoRef, branch: string): Promise<string | null> {
    const octokit = await octokitFor(repo);
    try {
      const { data } = await octokit.repos.getBranch({
        branch,
        owner: repo.organizationName,
        repo: repo.repoName,
      });
      return data.commit.sha;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  async pullRequestInfo(repo: RepoRef, prNumber: number): Promise<PullRequestInfo | null> {
    const octokit = await octokitFor(repo);
    try {
      const { data } = await octokit.pulls.get({
        owner: repo.organizationName,
        pull_number: prNumber,
        repo: repo.repoName,
      });
      return {
        baseRef: data.base.ref,
        headRef: data.head.ref,
        headRepositoryFullName: data.head.repo?.full_name ?? null,
        headSha: data.head.sha,
        htmlUrl: data.html_url,
        merged: data.merged === true,
        number: data.number,
        state: data.state === 'open' ? 'open' : 'closed',
      };
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  async branchInfo(repo: RepoRef, branch: string): Promise<BranchInfo | null> {
    const octokit = await octokitFor(repo);
    try {
      const { data } = await octokit.repos.getBranch({
        branch,
        owner: repo.organizationName,
        repo: repo.repoName,
      });
      return { protected: data.protected === true, sha: data.commit.sha };
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  async defaultBranch(repo: RepoRef): Promise<string> {
    const octokit = await octokitFor(repo);
    const { data } = await octokit.repos.get({
      owner: repo.organizationName,
      repo: repo.repoName,
    });
    return data.default_branch;
  }

  async compareCommits(repo: RepoRef, base: string, head: string): Promise<CommitComparison> {
    const octokit = await octokitFor(repo);
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      basehead: `${base}...${head}`,
      owner: repo.organizationName,
      per_page: 100,
      repo: repo.repoName,
    });
    const files = data.files ?? [];
    // GitHub lists at most 300 files on a comparison; past that the list is not the whole range.
    const truncated = files.length >= 300;
    return {
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      paths: truncated
        ? null
        : files.flatMap((f) =>
            f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]
          ),
      status: data.status,
    };
  }

  async fastForwardBranch(repo: RepoRef, branch: string, sha: string): Promise<boolean> {
    const octokit = await octokitFor(repo);
    try {
      // `force: false`: the host moves the ref only when `sha` descends from where it points.
      await octokit.git.updateRef({
        force: false,
        owner: repo.organizationName,
        ref: `heads/${branch}`,
        repo: repo.repoName,
        sha,
      });
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      // 422: not a fast-forward, or a protection / ruleset refused the update. 403: the
      // credential may not push here. Either is a refusal, not a failure.
      if (status === 422 || status === 403 || status === 409) {
        return false;
      }
      throw err;
    }
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<boolean> {
    const octokit = await octokitFor(repo);
    try {
      await octokit.git.deleteRef({
        owner: repo.organizationName,
        ref: `heads/${branch}`,
        repo: repo.repoName,
      });
      return true;
    } catch {
      return false;
    }
  }

  async upsertMarkedComment(
    repo: RepoRef,
    issueNumber: number,
    marker: string,
    body: string
  ): Promise<{ htmlUrl: string; updated: boolean }> {
    const octokit = await octokitFor(repo);
    const where = { issue_number: issueNumber, owner: repo.organizationName, repo: repo.repoName };
    // Only a comment the platform itself wrote is edited. Anyone who can comment can paste the
    // marker, and a credential with write access can edit other people's comments, so the
    // marker alone would let the platform overwrite a person's comment under their name.
    const identity = await commentIdentity(octokit, repo);
    let existing: { id: number } | undefined;
    if (identity) {
      let pages = 0;
      // Comments list oldest first; walk every page so the newest marked comment is found.
      for await (const page of octokit.paginate.iterator(octokit.issues.listComments, {
        ...where,
        per_page: 100,
      })) {
        for (const c of page.data) {
          const ours =
            (identity.login !== undefined && c.user?.login === identity.login) ||
            (identity.appId !== undefined && c.performed_via_github_app?.id === identity.appId);
          if (ours && c.body?.includes(marker)) {
            existing = { id: c.id };
          }
        }
        pages += 1;
        if (pages >= MAX_COMMENT_PAGES) {
          break;
        }
      }
    }
    if (existing) {
      const { data } = await octokit.issues.updateComment({
        body,
        comment_id: existing.id,
        owner: repo.organizationName,
        repo: repo.repoName,
      });
      return { htmlUrl: data.html_url, updated: true };
    }
    const { data } = await octokit.issues.createComment({ ...where, body });
    return { htmlUrl: data.html_url, updated: false };
  }

  async isDraftPullRequest(repo: RepoRef, prNumber: number): Promise<boolean> {
    const octokit = await octokitFor(repo);
    const { data } = await octokit.pulls.get({
      owner: repo.organizationName,
      pull_number: prNumber,
      repo: repo.repoName,
    });
    return data.draft === true;
  }

  async repoPermission(repo: RepoRef, username: string): Promise<PermissionLookup> {
    // An unapproved or non-canonical API override gets no credential: "could
    // not ask", never a denial — and a standing condition, not a transient one.
    if (!(await repositoryHostsAllowed({ githubApiUrl: repo.apiUrl })).ok) {
      return { failure: 'host-mismatch', ok: false };
    }
    const ghConfig = await resolveGitHubConfig();
    // The credential set of the repository's own host, and its own API: the
    // instance's would answer for the wrong repository on another host.
    let credential: PlatformCredential;
    try {
      credential = await platformCredential(repo, ghConfig);
    } catch {
      return { failure: 'unavailable', ok: false };
    }
    if (credential.scope !== 'instance' && credential.scope !== 'host') {
      return { failure: 'host-mismatch', ok: false };
    }
    const target = installationTarget(repo, credential.config);
    let token: string;
    try {
      token = await resolveGitHubToken(credential.config, target);
    } catch (err) {
      // No usable credential is "could not ask", not "no access". Resolving it
      // to a verdict would write a denial into the projection that GitHub never
      // made, and it would look identical to a real one.
      return {
        failure:
          err instanceof PlatformCredentialHostError ? 'host-mismatch' : 'credential-rejected',
        ok: false,
      };
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
