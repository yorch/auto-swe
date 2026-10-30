/**
 * The approver App: a SECOND GitHub App whose only job is submitting an approving review on a
 * pull request the platform opened. It is never the platform App and never used for any other
 * call. The installation token it mints is scoped to one repository with `pull_requests: write`,
 * and is revoked after use (best effort; GitHub expires it on its own after an hour at most).
 *
 * This module is the GitHub-facing layer only. Whether to approve is decided elsewhere. It names
 * no merge endpoint and no way to take an approval back: withdrawing one is the platform
 * credential's job, so it does not depend on these credentials surviving. An approval is bound to
 * one commit, but GitHub keeps counting it after a later push unless the base branch's rule
 * "dismiss stale pull request approvals" is on; whether it is on is decided elsewhere.
 *
 * Nothing secret leaves this file: the App key, the App JWT and the installation token are held in
 * local variables, never logged, never returned, and never placed in a thrown error.
 */
import { createSign } from 'node:crypto';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { platformCredentialScope } from '@auto-swe/shared/lib/githubHostScope';
import {
  type ResolvedGitHubApproverAppConfig,
  resolveGitHubApproverAppConfig,
  resolveGitHubConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { RepoRef } from './types.js';

/** The slice of Octokit this module uses: a route-string request. */
export interface ApproverClient {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

/** The client that holds an installation token, which its owner must give back. */
export interface ApproverSession extends ApproverClient {
  /** Revoke the installation token. Best effort: never throws. */
  release(): Promise<void>;
}

/** Why no client was produced. Fixed strings: never the host's message. */
export type ApproverClientFailure =
  | 'not-configured'
  | 'host-not-allowed'
  | 'host-mismatch'
  | 'same-app-as-platform'
  | 'not-installed'
  | 'installation-too-broad'
  | 'slug-mismatch'
  | 'key-invalid';

export type ApproverClientResult =
  | { ok: true; client: ApproverSession }
  | { ok: false; reason: ApproverClientFailure };

export type ApproverActionFailure = 'refused' | 'not-found' | 'unprocessable' | 'invalid-input';

export interface ApproverDeps {
  loadApproverConfig(): Promise<ResolvedGitHubApproverAppConfig | null>;
  loadGitHubConfig(): Promise<{ apiUrl: string; appId?: string | null; baseUrl: string }>;
  hostsAllowed(repo: {
    githubApiUrl?: string | null;
    githubUrl?: string | null;
  }): Promise<{ ok: true } | { ok: false; url: string }>;
  createOctokit(opts: { auth: string; baseUrl?: string }): ApproverClient;
  now(): Date;
}

const defaultDeps: ApproverDeps = {
  createOctokit: ({ auth, baseUrl }) => {
    // Resolved lazily: `@octokit/rest` is ESM-heavy and few activities reach GitHub.
    let octokit: Promise<{ request: (r: string, p?: Record<string, unknown>) => Promise<unknown> }>;
    return {
      request: async (route, params) => {
        octokit ??= import('@octokit/rest').then(
          ({ Octokit }) => new Octokit({ auth, ...(baseUrl && { baseUrl }) })
        );
        return (await (await octokit).request(route, params)) as { data: unknown };
      },
    };
  },
  hostsAllowed: repositoryHostsAllowed,
  loadApproverConfig: resolveGitHubApproverAppConfig,
  loadGitHubConfig: resolveGitHubConfig,
  now: () => new Date(),
};

/** How GitHub names an App's review author: `<slug>[bot]`, lower-cased for comparison. */
export function approverBotLogin(config: { appSlug: string }): string {
  return `${config.appSlug}[bot]`.toLowerCase();
}

/** App JWT: RS256, issued 60 s in the past (clock skew), valid for 9 minutes (GitHub's cap is 10). */
function signAppJwt(appId: string, privateKey: string, now: Date): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: nowSec + 9 * 60, iat: nowSec - 60, iss: appId })
  ).toString('base64url');
  const signing = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  return `${signing}.${signer.sign(privateKey).toString('base64url')}`;
}

function statusOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

/** An error to throw upward: the status only, no cause, so no request detail can ride along. */
function sanitized(what: string, err: unknown): Error {
  const status = statusOf(err);
  return new Error(`${what}${status === null ? '' : ` (HTTP ${status})`}`);
}

/**
 * An installation holds no more than the approver needs: selected repositories only, and nothing
 * but pull requests (and the always-present read of metadata). A leaked key reaches no further.
 */
function installationIsNarrow(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { permissions, repository_selection: selection } = data as {
    permissions?: unknown;
    repository_selection?: unknown;
  };
  if (selection !== 'selected') {
    return false;
  }
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return false;
  }
  return Object.entries(permissions).every(
    ([name, level]) =>
      (name === 'pull_requests' && (level === 'read' || level === 'write')) ||
      (name === 'metadata' && level === 'read')
  );
}

/**
 * A ready Octokit for the approver App, scoped to `repo` alone with `pull_requests: write` only,
 * or the reason there is none. Nothing is cached: GitHub is asked who the App is on every call,
 * so a wrong or foreign slug is refused, and the caller revokes the token with `release()`.
 */
export async function getApproverClient(
  repo: RepoRef,
  deps: ApproverDeps = defaultDeps
): Promise<ApproverClientResult> {
  const config = await deps.loadApproverConfig();
  if (!config) {
    return { ok: false, reason: 'not-configured' };
  }
  const instance = await deps.loadGitHubConfig();
  // The approver App is registered on the instance's host only.
  if (platformCredentialScope(repo, instance) !== 'instance') {
    return { ok: false, reason: 'host-mismatch' };
  }
  const hosts = await deps.hostsAllowed({ githubApiUrl: repo.apiUrl, githubUrl: repo.baseUrl });
  if (!hosts.ok) {
    return { ok: false, reason: 'host-not-allowed' };
  }
  // Two identities: an approval from the App that opened the pull request would approve itself.
  if (instance.appId && instance.appId === config.appId) {
    return { ok: false, reason: 'same-app-as-platform' };
  }
  const baseUrl =
    repo.apiUrl ?? (instance.apiUrl !== 'https://api.github.com' ? instance.apiUrl : undefined);

  let jwt: string;
  try {
    jwt = signAppJwt(config.appId, config.privateKey, deps.now());
  } catch {
    // The signer's message can describe the key; say nothing of it.
    return { ok: false, reason: 'key-invalid' };
  }
  const asApp = deps.createOctokit({ auth: jwt, ...(baseUrl && { baseUrl }) });

  // The review author is `<slug>[bot]`; the slug is typed by an admin, so GitHub is asked which
  // slug this App really has. A wrong one would make every approval unrecognisable, and another
  // App's would make someone else's approval look like ours.
  try {
    const { data } = await asApp.request('GET /app');
    const slug = (data as { slug?: unknown } | null)?.slug;
    if (typeof slug !== 'string' || slug.toLowerCase() !== config.appSlug.toLowerCase()) {
      return { ok: false, reason: 'slug-mismatch' };
    }
  } catch (err) {
    if (statusOf(err) === 401 || statusOf(err) === 403) {
      return { ok: false, reason: 'key-invalid' };
    }
    throw sanitized('Approver App identity lookup failed', err);
  }

  let installationId: number;
  try {
    const { data } = await asApp.request('GET /repos/{owner}/{repo}/installation', {
      owner: repo.organizationName,
      repo: repo.repoName,
    });
    if (!installationIsNarrow(data)) {
      return { ok: false, reason: 'installation-too-broad' };
    }
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, reason: 'not-installed' };
    }
    installationId = id;
  } catch (err) {
    if (statusOf(err) === 404) {
      return { ok: false, reason: 'not-installed' };
    }
    throw sanitized('Approver App installation lookup failed', err);
  }

  let token: string;
  try {
    const { data } = await asApp.request(
      'POST /app/installations/{installation_id}/access_tokens',
      {
        installation_id: installationId,
        permissions: { pull_requests: 'write' },
        repositories: [repo.repoName],
      }
    );
    const value = (data as { token?: unknown } | null)?.token;
    if (typeof value !== 'string' || value === '') {
      throw new Error('Approver App installation token response had no token');
    }
    token = value;
  } catch (err) {
    if (statusOf(err) === 404) {
      return { ok: false, reason: 'not-installed' };
    }
    throw sanitized('Approver App installation token request failed', err);
  }
  const asInstallation = deps.createOctokit({ auth: token, ...(baseUrl && { baseUrl }) });
  const client: ApproverSession = {
    release: async () => {
      try {
        await asInstallation.request('DELETE /installation/token');
      } catch {
        // Best effort: the token expires on its own, and a failure here must change nothing.
      }
    },
    request: (route, params) => asInstallation.request(route, params),
  };
  return { client, ok: true };
}

function failureFor(err: unknown): ApproverActionFailure | null {
  switch (statusOf(err)) {
    case 403:
      return 'refused';
    case 404:
      return 'not-found';
    case 422:
      return 'unprocessable';
    default:
      return null;
  }
}

const MAX_REVIEW_BODY_CHARS = 1000;

/**
 * Submit an APPROVE review bound to `headSha`, so it covers that commit and nothing pushed later.
 * The caller supplies a fixed template as `body`; it is truncated and never carries untrusted text.
 * Resolves `{ ok: false }` on 403, 404 and 422; other errors propagate.
 */
export async function submitApprovingReview(
  client: ApproverClient,
  repo: RepoRef,
  prNumber: number,
  input: { headSha: string; body: string }
): Promise<{ ok: true; reviewId: string } | { ok: false; reason: ApproverActionFailure }> {
  if (input.headSha.trim() === '') {
    return { ok: false, reason: 'invalid-input' };
  }
  try {
    const { data } = await client.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      {
        body: input.body.slice(0, MAX_REVIEW_BODY_CHARS),
        commit_id: input.headSha,
        event: 'APPROVE',
        owner: repo.organizationName,
        pull_number: prNumber,
        repo: repo.repoName,
      }
    );
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      return { ok: false, reason: 'unprocessable' };
    }
    return { ok: true, reviewId: String(id) };
  } catch (err) {
    const reason = failureFor(err);
    if (reason) {
      return { ok: false, reason };
    }
    throw err;
  }
}

/**
 * The approver's standing approval of `headSha`, from the platform provider's review listing
 * (oldest first), or null. Like `approvalState`, only a login's LATEST review counts: a later
 * dismissal, change request or comment, or a review of another commit, supersedes the approval.
 */
export function findOwnApproval<T extends { login: string; state: string; commitId: string }>(
  reviews: readonly T[],
  botLogin: string,
  headSha: string
): T | null {
  if (headSha.trim() === '') {
    return null;
  }
  const wanted = botLogin.toLowerCase();
  let latest: T | null = null;
  for (const review of reviews) {
    if (review.login.toLowerCase() === wanted) {
      latest = review;
    }
  }
  return latest && latest.state === 'APPROVED' && latest.commitId === headSha ? latest : null;
}

/**
 * Every approval of the approver that still stands, whatever commit it names: a review whose
 * latest state is APPROVED (a dismissed one reads DISMISSED). GitHub counts an approval of an
 * older commit unless the base branch dismisses stale reviews, so withdrawal covers all of them.
 */
export function ownApprovals<T extends { login: string; state: string }>(
  reviews: readonly T[],
  botLogin: string
): T[] {
  const wanted = botLogin.toLowerCase();
  return reviews.filter((r) => r.state === 'APPROVED' && r.login.toLowerCase() === wanted);
}
