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
import type { ChangedFile } from '@auto-swe/shared/lib/prEvaluation';

export type { PermissionLookup, RepoPermission } from '@auto-swe/shared/lib/githubPermission';

/** Provider-agnostic reference to a remote repository. */
export interface RepoRef {
  /**
   * The `Connection` row this ref was built from. It is what a run's requester
   * is matched against to find their own saved credential; a ref without one
   * (a hand-built test fixture) only ever uses the platform credential.
   */
  connectionId?: string;
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
  /** The `GitHubInstallation.host` of that installation: empty for the instance's. */
  installationHost: string | null;
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
  /**
   * Open the PR as a draft. When the host cannot (GitHub refuses drafts on
   * private repositories of plans without them), the provider throws
   * {@link DraftPullRequestUnsupportedError} — it never falls back to a
   * ready-for-review PR, because "draft" is a promise to the reviewer.
   */
  draft?: boolean;
}

/** The host rejected a draft pull request (the repository cannot have drafts). */
export class DraftPullRequestUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftPullRequestUnsupportedError';
  }
}

/**
 * A draft was requested, but the open PR the host would reuse is ready for review.
 * Pushing agent commits onto it would put unreviewed work in front of a reviewer who
 * was promised a draft, so the provider refuses instead.
 */
export class ExistingPullRequestNotDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExistingPullRequestNotDraftError';
  }
}

export interface PullRequestRef {
  prNumber: number;
  prUrl: string;
}

/** One failed job of a CI workflow run, with the tail of its log. */
export interface WorkflowRunFailedJob {
  name: string;
  conclusion: string | null;
  /** The job's steps that failed, by name. */
  failedSteps: string[];
  /** The end of the job's log (where the failure is), or empty when it could not be read. */
  log: string;
  /** Why the log could not be read, when it could not. */
  logUnavailable?: string;
  htmlUrl: string | null;
}

/**
 * A CI workflow run read from the host by its id, never from a webhook payload or a URL a
 * caller supplied: what ran, on which commit and branch, and why it failed.
 */
export interface WorkflowRunFailure {
  run: {
    id: string;
    attempt: number;
    /** The workflow's display name (set by the workflow file, so by whoever wrote it). */
    name: string;
    /** The workflow file's path in the repository (`.github/workflows/ci.yml`). */
    path: string;
    /** What triggered it: `push`, `pull_request`, `schedule`, … */
    event: string;
    /** The branch (or, for a tag push, the tag) the run is for. */
    headBranch: string | null;
    headSha: string;
    status: string | null;
    conclusion: string | null;
    htmlUrl: string;
    /** `owner/name` of the repository the head commit came from (a fork for a fork PR). */
    headRepositoryFullName: string | null;
    /** `owner/name` of the repository the run belongs to. */
    repositoryFullName: string;
    /** The pull requests the run is associated with, as the host reports them. */
    pullRequests: Array<{ number: number; headRef: string; baseRef: string }>;
  };
  failedJobs: WorkflowRunFailedJob[];
}

/** A pull request's current state, as the host reports it. */
export interface PullRequestInfo {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  /** `owner/name` of the head repository; null when the fork was deleted. */
  headRepositoryFullName: string | null;
  baseRef: string;
  htmlUrl: string;
}

/** A pull request as the PR evaluator reads it. */
export interface PullRequestDetails {
  number: number;
  /** The author's login; null when the account was deleted. */
  author: string | null;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  merged: boolean;
  state: 'open' | 'closed';
  title: string;
  /** The GraphQL node id, which the draft and auto-merge mutations name. */
  nodeId: string;
  /**
   * GitHub's own current auto-merge state for this pull request (its `auto_merge` field), whoever
   * enabled it. `method` is the merge method the host reports, when it does.
   */
  autoMerge: { enabled: boolean; method?: string };
}

/**
 * The changed files of a pull request. `truncated` is true when the list is not provably the
 * whole change (the file cap or page cap was hit, or the PR reports more files than came back);
 * callers fail closed on it rather than classifying a partial list.
 */
export interface PullRequestFiles {
  files: ChangedFile[];
  truncated: boolean;
}

/** One submitted review of a pull request. Reviews by deleted accounts are not listed. */
export interface PullRequestReviewSummary {
  login: string;
  /** Upper-cased: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
  /** The commit the review was submitted against. */
  commitId: string;
  submittedAt: string | null;
}

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatusInput {
  context: string;
  state: CommitStatusState;
  /** Truncated to 140 characters, the host's limit. */
  description: string;
  targetUrl?: string;
}

/** `ok: false` is a refusal by the host (no permission, a validation error), never a crash. */
export interface ScmActionResult {
  ok: boolean;
  reason?: string;
}

/**
 * What the host enforces on a branch, from classic branch protection and from rulesets, plus
 * whether the repository allows auto-merge.
 *
 * Every field is `'unknown'` when it could not be established, and never `false` or empty in
 * that case: reading protection needs admin access, so a 403 or 404 means "could not tell"
 * (a 404 is "unprotected" only when the host says `Branch not protected`). A boolean is `true`
 * as soon as any source says so; `false` and the numeric and list fields need EVERY source to
 * have answered. `source` names the sources that reported a rule.
 */
export interface BranchRules {
  /** True only when the effective required approving review count is at least one. */
  requiresReviews: boolean | 'unknown';
  requiredReviewCount: number | 'unknown';
  requiresCodeOwnerReview: boolean | 'unknown';
  requiredStatusContexts: string[] | 'unknown';
  /**
   * True only when every source that requires the configured status context ties it to OUR
   * App (`app_id` on classic protection, `integration_id` in a ruleset, equal to the expected
   * App id). False when a source requires it from any source or from another App, which a
   * token that is not ours can satisfy under that name. `'unknown'` when a source was
   * unreadable, no context was asked about, no expected App id is known, or the context is
   * not required anywhere.
   */
  requiredStatusPinnedToApp: boolean | 'unknown';
  allowsAutoMerge: boolean | 'unknown';
  source: 'protection' | 'rulesets' | 'both' | 'none' | 'unknown';
}

export type AutoMergeMethod = 'SQUASH' | 'MERGE' | 'REBASE';

/** A branch's tip and whether the host protects it. */
export interface BranchInfo {
  sha: string;
  protected: boolean;
}

/** How `head` relates to `base`, and the files between them. */
export interface CommitComparison {
  /** `ahead`: head is base plus commits — a fast-forward from base reaches it. */
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  aheadBy: number;
  behindBy: number;
  /** Every path the range touches, both ends of a rename. Null when the host truncated the list. */
  paths: string[] | null;
}

/** A normalized CI verdict for a ref, plus an optional link to failing logs. */
export interface CiStatusResult {
  verdict: import('./ciStatus.js').CiVerdict;
  logsUrl?: string;
}

/** Who wrote a host comment or review: the numeric account id is null for bots and apps. */
export interface FeedbackAuthor {
  /** The account's numeric database id, or null for a bot or app (never trusted). */
  authorId: string | null;
  authorLogin: string;
  /** The host's account type (`User`, `Bot`, …), lowercased by the caller when compared. */
  authorType: string;
}

/** One comment of a pull-request review thread, as the host reports it. */
export interface ReviewThreadComment extends FeedbackAuthor {
  /** The comment's database id: what a reply names. */
  databaseId: number;
  body: string;
  createdAt: string;
  /** The review this comment belongs to, when it is part of one. */
  reviewDatabaseId: number | null;
}

/** A pull-request review thread (an inline comment chain on a file). */
export interface ReviewThread {
  /** The thread's GraphQL node id (what replies and the responder cite). */
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

/** A pull-request review, re-read from the host by id. */
export interface PullRequestReview extends FeedbackAuthor {
  body: string;
  state: string;
}

/** An issue-style comment (a discussion comment on a pull request), by id. */
export interface IssueCommentInfo extends FeedbackAuthor {
  body: string;
  issueNumber: number;
}

/** An inline review comment, by id. */
export interface ReviewCommentInfo extends FeedbackAuthor {
  body: string;
  pullRequestNumber: number;
  /** The comment it replies to, when it is not the thread's opening comment. */
  inReplyToId: number | null;
}

/** What `createBranch` learned about the branch it was asked to create. */
export type CreateBranchResult =
  /** The branch did not exist and now points at `sha`. */
  | 'created'
  /** The branch already existed at exactly `sha` (a retry of this call). */
  | 'exists_same'
  /** The branch exists at another sha — never overwritten. */
  | 'exists_other';

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
  /**
   * Fetch CI logs for the fix loop (provider-specific URL/auth handling).
   *
   * `repo` is optional because a logs URL can reach the fix loop without one,
   * but passing it is what lets the credential come from that repository's own
   * installation rather than the instance default.
   */
  fetchCiLogs(logsUrl: string, repo?: RepoRef): Promise<string>;
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
   * List the entry names of a directory in the repo at `ref` (default branch
   * when omitted). Returns `null` when the path is missing or is not a
   * directory; other errors propagate, as `fetchFileContent` does.
   */
  listDirectory(repo: RepoRef, path: string, ref?: string): Promise<string[] | null>;
  /**
   * Every blob path in the repo tree at `ref` (the default branch when
   * omitted). `truncated` is true when the provider cut the listing. `null`
   * when the tree cannot be listed (404); other errors propagate.
   */
  listTree(repo: RepoRef, ref?: string): Promise<{ paths: string[]; truncated: boolean } | null>;
  /**
   * Whether `branch` exists on the host, how many commits it has that `baseBranch`
   * lacks (null when it does not exist), and the open PR from it if any. Lets a run
   * that would reuse a fixed branch (a schedule) stop before it spends a workspace on
   * work that would collide with the previous run's. A branch with no commits ahead
   * is not work: an earlier run that changed nothing still pushes its branch. A
   * failure to compare is thrown, never read as "no work".
   */
  findBranchWork(
    repo: RepoRef,
    branch: string,
    baseBranch: string
  ): Promise<{ branchExists: boolean; aheadBy: number | null; openPr: PullRequestRef | null }>;
  /** Whether an existing PR is still a draft. One API call. */
  isDraftPullRequest(repo: RepoRef, prNumber: number): Promise<boolean>;
  /**
   * A CI workflow run of `repo`, by id and attempt, with its failed jobs and the end of each
   * one's log. The run is looked up in `repo` itself, so an id cannot reach another
   * repository's logs. Throws non-retryably when the run does not exist in `repo` or the
   * credential may not read Actions.
   */
  fetchWorkflowRunFailure(
    repo: RepoRef,
    runId: string,
    attempt: number
  ): Promise<WorkflowRunFailure>;
  /** The commit a BRANCH points at, or null when no branch has that name (a tag, or deleted). */
  branchHeadSha(repo: RepoRef, branch: string): Promise<string | null>;
  /** A pull request's current state, or null when it does not exist. */
  pullRequestInfo(repo: RepoRef, prNumber: number): Promise<PullRequestInfo | null>;
  /** A branch's tip and protection, or null when no branch has that name. */
  branchInfo(repo: RepoRef, branch: string): Promise<BranchInfo | null>;
  /** The repository's default branch. */
  defaultBranch(repo: RepoRef): Promise<string>;
  /** How `head` relates to `base` (commit shas). */
  compareCommits(repo: RepoRef, base: string, head: string): Promise<CommitComparison>;
  /**
   * Move `branch` to `sha` only if that is a fast-forward — never a force. Resolves false when
   * the host refuses (not a fast-forward, protection, a ruleset); throws on anything else.
   */
  fastForwardBranch(repo: RepoRef, branch: string, sha: string): Promise<boolean>;
  /** Delete a branch; best-effort, resolves false when it could not. */
  deleteBranch(repo: RepoRef, branch: string): Promise<boolean>;
  /**
   * Create a comment on an issue or pull request, or update the existing one that carries
   * `marker` (a hidden HTML comment), so repeated reports on one PR edit one comment rather
   * than stacking new ones.
   */
  upsertMarkedComment(
    repo: RepoRef,
    issueNumber: number,
    marker: string,
    body: string
  ): Promise<{ htmlUrl: string; updated: boolean }>;
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
  /**
   * The pull request's review threads, bounded: at most 100 threads and 50 comments each.
   * Everything in them is untrusted host text — callers bound and screen before any of it
   * reaches a model.
   */
  listReviewThreads(repo: RepoRef, prNumber: number): Promise<ReviewThread[]>;
  /** A pull-request review, by its database id, or null when it does not exist. */
  getPullRequestReview(
    repo: RepoRef,
    prNumber: number,
    reviewId: string
  ): Promise<PullRequestReview | null>;
  /** An issue comment (a pull-request discussion comment), by its database id, or null. */
  getIssueComment(repo: RepoRef, commentId: string): Promise<IssueCommentInfo | null>;
  /** An inline review comment, by its database id, or null. */
  getReviewComment(repo: RepoRef, commentId: string): Promise<ReviewCommentInfo | null>;
  /**
   * Reply in a review thread, naming the thread's TOP-LEVEL comment database id.
   * Resolves the reply's URL.
   */
  replyToReviewComment(
    repo: RepoRef,
    prNumber: number,
    commentId: number,
    body: string
  ): Promise<{ htmlUrl: string }>;
  /**
   * Create `branch` at `sha`, never forcing: `exists_same` when it already points there (a
   * retry), `exists_other` when it exists elsewhere — which callers refuse non-retryably,
   * because silently moving another run's branch is worse than failing.
   */
  createBranch(repo: RepoRef, branch: string, sha: string): Promise<CreateBranchResult>;
  /** A pull request's details for evaluation, or null when it does not exist. */
  getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestDetails | null>;
  /**
   * The pull request's changed files, at most 3000 (the host's own limit) over a bounded number
   * of pages. `truncated` is set when the list may be partial. Status values the evaluator
   * cannot treat specially (`copied`, `changed`, `unchanged`) are reported as `modified`.
   */
  listPullRequestFiles(repo: RepoRef, prNumber: number): Promise<PullRequestFiles>;
  /** Every submitted review (bounded pages), newest last, skipping reviews by deleted accounts. */
  listPullRequestReviews(repo: RepoRef, prNumber: number): Promise<PullRequestReviewSummary[]>;
  /**
   * Set a commit status. Resolves `{ ok: false, reason }` when the host refuses (403, 422);
   * other errors propagate.
   */
  setCommitStatus(repo: RepoRef, sha: string, input: CommitStatusInput): Promise<ScmActionResult>;
  /**
   * What the host enforces on `branch`; `context` is the status context whose pinning to an App
   * is reported and `expectedAppId` is the platform's own GitHub App id it must be pinned to
   * (null: unknown, so pinning is reported `'unknown'`). Never throws on an API refusal; see {@link BranchRules}.
   */
  readBranchRules(
    repo: RepoRef,
    branch: string,
    context?: string,
    expectedAppId?: number | null
  ): Promise<BranchRules>;
  /**
   * Ask the host to merge the pull request once its own requirements are met, and only if the
   * head is still `expectedHeadSha` (sent as `expectedHeadOid`, so a push after evaluation is
   * refused by the host).
   *
   * It never merges immediately: the host merges when branch protection is satisfied. It is the
   * one merge-capable call the platform makes on purpose; `yarn invariants:check` is a tripwire
   * over source text that fails on a known immediate-merge spelling elsewhere (it does not see an
   * aliased client or a route built from pieces). Resolves `{ ok: false, reason }` on a refusal.
   */
  enableAutoMerge(
    repo: RepoRef,
    prNumber: number,
    input: { method: AutoMergeMethod; expectedHeadSha: string }
  ): Promise<ScmActionResult>;
  /** Cancel a pending auto-merge (a push invalidated the evaluation that enabled it). */
  disableAutoMerge(repo: RepoRef, prNumber: number): Promise<ScmActionResult>;
}
