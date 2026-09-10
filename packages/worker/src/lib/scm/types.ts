/**
 * SCM provider seam (EVOL-1).
 *
 * Everything the execution path needs from a source-control host is expressed
 * through `ScmProvider`. GitHub is the first (and currently only)
 * implementation — see `github.ts`. The interface is intentionally tight:
 * clone credentials, idempotent PR create-or-reuse, PR URL construction, CI log
 * fetching, and one user's permission on a repository. Webhook payload parsing
 * stays provider-specific in the gateway
 * (`packages/gateway/src/routes/webhooks.ts`); only its payload→domain-event
 * mapping is factored out there for reuse by a future GitLab route.
 */

import type { PermissionLookup } from '@auto-swe/shared/lib/githubPermission';

export type { PermissionLookup, RepoPermission } from '@auto-swe/shared/lib/githubPermission';

/** Provider-agnostic reference to a remote repository. */
export interface RepoRef {
  organizationName: string;
  repoName: string;
  /**
   * Per-repo web/clone base URL override (e.g. a GitHub Enterprise host).
   * Null/undefined → the instance-wide configured base URL.
   */
  baseUrl?: string | null;
  /** Per-repo REST API base URL override. Null/undefined → instance default. */
  apiUrl?: string | null;
  /**
   * The host's numeric installation id for the App that reaches this repo, when
   * the host has such a concept. Null means the instance-wide default
   * installation, which is what every repo meant before a deployment could span
   * more than one GitHub organization.
   */
  installationId?: string | null;
}

/** Result of resolving clone credentials for a repository. */
export interface CloneCredentials {
  /** Plain HTTPS clone URL with no credentials embedded. */
  cloneUrl: string;
  /** Clone URL with embedded short-lived credentials, ready for `git clone`. */
  authedCloneUrl: string;
  /**
   * The raw token embedded in `authedCloneUrl`. Exposed so call sites can
   * redact it from error messages and logs (see shellStep.ts `redactToken`).
   */
  token: string;
}

export interface CreatePullRequestInput {
  repo: RepoRef;
  /** Branch the PR merges into (usually the repo default branch). */
  baseBranch: string;
  /** Branch the PR merges from. */
  headBranch: string;
  title: string;
  body: string;
  /**
   * When true, look up an already-open PR for `headBranch` before creating
   * one. Used on Temporal activity retries so a PR orphaned by a crash
   * between the create call and the DB write is reused instead of failing
   * with the host's "a pull request already exists" error.
   */
  reuseExisting?: boolean;
}

export interface PullRequestRef {
  prNumber: number;
  prUrl: string;
}

/** A normalized CI verdict for a ref, plus an optional link to failing logs. */
export interface CiStatusResult {
  verdict: import('./ciStatus.js').CiVerdict;
  logsUrl?: string;
}

/**
 * The seam between auto-swe's execution path and a source-control host.
 *
 * Implementations resolve their own configuration and credentials on every
 * call (same contract as model-config resolution): mid-run config changes
 * land on the next SCM operation rather than waiting for a fresh run.
 */
export interface ScmProvider {
  /** Resolve clone URLs + a short-lived credential for a repository. */
  cloneCredentials(repo: RepoRef): Promise<CloneCredentials>;
  /** Idempotent PR create-or-reuse for a branch. */
  createOrUpdatePullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
  /** Web URL for an existing PR. */
  prUrl(repo: RepoRef, prNumber: number): Promise<string>;
  /** Fetch CI logs for the fix loop (provider-specific URL/auth handling). */
  fetchCiLogs(logsUrl: string): Promise<string>;
  /**
   * Fetch the current CI verdict for a ref (branch or SHA) by combining the
   * Checks API and the legacy Statuses API. Used by the poll-based CI wait when
   * no webhook is available. Returns `none` when the repo has no CI at all.
   */
  fetchCiStatus(repo: RepoRef, ref: string): Promise<CiStatusResult>;
  /**
   * Fetch a single file's content from the repo at `ref` (default branch when
   * omitted). Used by the repo dependency graph's manifest/git-signal
   * detectors (P1). Returns `null` when the path doesn't exist as a plain
   * file — missing, a directory/symlink, or any other non-file entry — so a
   * repo without a given manifest is a normal, non-throwing outcome.
   */
  fetchFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null>;
  /**
   * What access `username` — a host login, not a platform user id — has to
   * `repo`.
   *
   * Answers with a level rather than a boolean so one lookup can serve both
   * "may start a run here" and "may look at one". Never throws: a lookup that
   * could not be made is reported as a typed failure, because "no access" and
   * "could not ask" must not be recorded as the same thing.
   */
  repoPermission(repo: RepoRef, username: string): Promise<PermissionLookup>;
}
