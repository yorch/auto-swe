/**
 * Asking GitHub what access a user has to a repository.
 *
 * The platform holds one credential per installation and asks on the user's
 * behalf, rather than holding a token per user. That is the whole reason this
 * design needs only a GitHub username: no user tokens to store, refresh, expire,
 * or encrypt, and no second copy of anyone's credentials.
 *
 * The exception is a user who has chosen to save their own token for a
 * repository (`ConnectionCredential`). That token is their identity, so their
 * access is asked about with it directly — see {@link fetchOwnRepoPermission}.
 *
 * The endpoint answers with a level rather than a boolean, which is what lets
 * "may launch a run" and "may look at one" be different questions with one
 * lookup.
 */

/** GitHub's collaborator permission levels, weakest first. */
export const REPO_PERMISSIONS = ['none', 'read', 'write', 'admin'] as const;

export type RepoPermission = (typeof REPO_PERMISSIONS)[number];

const RANK: Record<RepoPermission, number> = { admin: 3, none: 0, read: 1, write: 2 };

/** Does `actual` reach at least `required`? */
export function permissionMeets(actual: RepoPermission, required: RepoPermission): boolean {
  return RANK[actual] >= RANK[required];
}

/**
 * Why a lookup produced no answer.
 *
 * A failure is deliberately distinct from a `none` verdict. `none` is GitHub
 * saying the user has no access; a failure is GitHub not saying anything, and
 * the two must not be written to the projection as the same thing — one is a
 * fact with a shelf life, the other is an outage.
 */
export type PermissionLookupFailure =
  | 'repo-not-found'
  | 'credential-rejected'
  /**
   * The repository is on a host the platform's credential may not go to (or its
   * web and API hosts disagree). Standing configuration: retrying cannot help.
   */
  | 'host-mismatch'
  | 'rate-limited'
  | 'unavailable';

export type PermissionLookup =
  | { ok: true; permission: RepoPermission }
  | { ok: false; failure: PermissionLookupFailure };

export interface RepoPermissionQuery {
  apiUrl: string;
  token: string;
  organizationName: string;
  repoName: string;
  /** The GitHub login, not a platform user id. */
  username: string;
}

/** Wall-clock cap. The launch path awaits this, so it must not hang a request. */
const LOOKUP_TIMEOUT_MS = 8_000;

function isRepoPermission(value: unknown): value is RepoPermission {
  return (
    typeof value === 'string' && (REPO_PERMISSIONS as readonly string[]).includes(value as string)
  );
}

/**
 * Ask GitHub for one user's permission on one repository.
 *
 * Never throws: every caller is either a scan that must not abort or a request
 * that must produce a decision, and both need to tell "no access" apart from
 * "could not ask". The failure taxonomy is the return value, not an exception.
 *
 * A 404 here is genuinely ambiguous — GitHub returns it both when the user is
 * not a collaborator and when the *credential* cannot see the repository at
 * all. It is reported as `repo-not-found` rather than resolved to `none`,
 * because the second case means this installation is the wrong one for this
 * repository, which is an operator error and not a statement about the user.
 */
export async function fetchRepoPermission(query: RepoPermissionQuery): Promise<PermissionLookup> {
  const { apiUrl, token, organizationName, repoName, username } = query;
  const url =
    `${repoApiPath(apiUrl, organizationName, repoName)}` +
    `/collaborators/${encodeURIComponent(username)}/permission`;
  const result = await getJson(url, token);
  if (!result.ok) {
    return result;
  }
  const permission = (result.body as { permission?: unknown }).permission;
  if (!isRepoPermission(permission)) {
    // An unrecognised level must not silently become `none`, which would read
    // as a decision GitHub did not make.
    return { failure: 'unavailable', ok: false };
  }
  return { ok: true, permission };
}

/** The repository coordinates and the token whose own access is being asked about. */
export type OwnRepoPermissionQuery = Omit<RepoPermissionQuery, 'username'>;

/**
 * Ask GitHub what the *token's owner* may do with a repository.
 *
 * Used for a user's own credential, where the token is the identity: there is
 * no platform credential to ask with, and no stored login is needed, because
 * GitHub already knows whose token it is. That also makes it work on a GitHub
 * Enterprise host, whose usernames the github.com-linked login does not name.
 *
 * The answer is the owner's role on the repository, not what the token's scopes
 * allow — a fine-grained token restricted to read still reports its owner's
 * `admin`. It answers "who is this", like the collaborator endpoint does; a
 * token too narrow to push fails at push time, loudly.
 *
 * Same failure taxonomy as {@link fetchRepoPermission}: a 404 is
 * `repo-not-found`, never `none`, because a token without the scope to see a
 * private repository gets the same 404 as a user without access.
 */
export async function fetchOwnRepoPermission(
  query: OwnRepoPermissionQuery
): Promise<PermissionLookup> {
  const result = await getJson(
    repoApiPath(query.apiUrl, query.organizationName, query.repoName),
    query.token
  );
  if (!result.ok) {
    return result;
  }
  const flags = (result.body as { permissions?: unknown }).permissions;
  if (typeof flags !== 'object' || flags === null) {
    // No `permissions` object means GitHub did not answer the question asked —
    // it is not evidence of `none`.
    return { failure: 'unavailable', ok: false };
  }
  const f = flags as Record<string, unknown>;
  if (f.admin === true) {
    return { ok: true, permission: 'admin' };
  }
  if (f.maintain === true || f.push === true) {
    return { ok: true, permission: 'write' };
  }
  if (f.triage === true || f.pull === true) {
    return { ok: true, permission: 'read' };
  }
  return { ok: true, permission: 'none' };
}

function repoApiPath(apiUrl: string, organizationName: string, repoName: string): string {
  return (
    `${apiUrl.replace(/\/$/, '')}/repos/` +
    `${encodeURIComponent(organizationName)}/${encodeURIComponent(repoName)}`
  );
}

/**
 * GET a GitHub REST resource and classify every way it can fail to answer.
 *
 * Never throws, for the reason {@link fetchRepoPermission} gives.
 */
async function getJson(
  url: string,
  token: string
): Promise<{ ok: true; body: unknown } | { ok: false; failure: PermissionLookupFailure }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { failure: 'unavailable', ok: false };
  }

  if (res.status === 404) {
    return { failure: 'repo-not-found', ok: false };
  }
  if (res.status === 401) {
    return { failure: 'credential-rejected', ok: false };
  }
  if (res.status === 403) {
    // GitHub reports both "forbidden" and "rate limited" as 403; the remaining
    // quota header is what separates them. They need different handling: a
    // rate limit is transient and worth retrying, a 403 is not.
    const remaining = res.headers.get('x-ratelimit-remaining');
    return { failure: remaining === '0' ? 'rate-limited' : 'credential-rejected', ok: false };
  }
  if (res.status === 429) {
    return { failure: 'rate-limited', ok: false };
  }
  if (!res.ok) {
    return { failure: 'unavailable', ok: false };
  }

  try {
    return { body: await res.json(), ok: true };
  } catch {
    return { failure: 'unavailable', ok: false };
  }
}
