/**
 * The gateway's side of "what access does this user have to this repository".
 *
 * The worker asks the same question through the `ScmProvider` seam. Both end up
 * in `@auto-swe/shared/lib/githubPermission`; what differs is only how each
 * process gets from a `Connection` row to a credential, and the gateway is the
 * side that has the row in hand.
 */
import type { PrismaClient } from '../index.js';
import {
  repositoryHostsAllowed,
  resolveUserCredential,
  resolveUserCredentialPolicy,
} from './connectionCredential.js';
import { GITHUB_ACCOUNT_API_URL, verifyGithubLoginOwnership } from './githubIdentityCheck.js';
import { resolveGitHubToken } from './githubInstallation.js';
import {
  fetchOwnRepoPermission,
  fetchRepoPermission,
  type PermissionLookup,
} from './githubPermission.js';
import { resolveGitHubConfig } from './systemConfig.js';

/** The `Connection` columns a permission lookup needs. */
export interface PermissionRepo {
  organizationName: string | null;
  repoName: string | null;
  githubApiUrl?: string | null;
  installation: { installationId: string } | null;
}

/** Select exactly the columns `lookupRepoPermission` reads. */
export const PERMISSION_REPO_SELECT = {
  githubApiUrl: true,
  installation: { select: { installationId: true } },
  organizationName: true,
  repoName: true,
} as const;

/**
 * Ask GitHub what `username` may do with `repo`.
 *
 * Returns a typed failure rather than throwing, and never resolves a failure to
 * a verdict — a caller has to decide what an unanswered question means, and
 * that decision differs between launching (fail closed) and viewing (serve what
 * is already known).
 */
export async function lookupRepoPermission(
  repo: PermissionRepo,
  username: string
): Promise<PermissionLookup> {
  if (!(repo.organizationName && repo.repoName)) {
    // A non-git connection has no repository to ask about. This is a caller
    // error rather than a denial, so it is not reported as `none`.
    return { failure: 'repo-not-found', ok: false };
  }
  // The platform token goes to this API host. An unapproved per-repository
  // override gets no token — "could not ask", never a denial.
  if (!(await repositoryHostsAllowed({ githubApiUrl: repo.githubApiUrl })).ok) {
    return { failure: 'credential-rejected', ok: false };
  }
  const ghConfig = await resolveGitHubConfig();
  const apiUrl = repo.githubApiUrl ?? ghConfig.apiUrl;
  let token: string;
  try {
    token = await resolveGitHubToken(ghConfig, {
      apiUrl,
      installationId: repo.installation?.installationId ?? null,
    });
  } catch {
    return { failure: 'credential-rejected', ok: false };
  }
  return fetchRepoPermission({
    apiUrl,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
    token,
    username,
  });
}

/**
 * Ask GitHub what `userId` may do with `repo`, using the token they saved for
 * it — or null when they have no usable one.
 *
 * Preferred over {@link lookupRepoPermission} wherever both apply: when a user
 * has a credential, that credential is the identity their runs act as, so it is
 * the identity whose access matters. It needs no stored login, and it answers
 * on a GitHub Enterprise host, where the github.com login means nothing.
 *
 * Null covers every reason {@link resolveUserCredential} gives for a token not
 * being usable: in each of them the user's runs fall back to the platform
 * credential, so the caller falls back to the login-based question too. The
 * two use one resolver, so the identity this decides about is exactly the
 * identity the run will act as.
 *
 * A failure to read or decrypt the row is reported as `unavailable` rather than
 * thrown. This is a lookup, and every caller already treats an unanswered
 * lookup correctly — the launch fails closed, the sweep and the webhook refresh
 * keep the previous answer and move on to the next pair — whereas a throw would
 * let one bad row stop the sweep for everyone.
 */
export async function lookupPermissionViaUserCredential(
  prisma: PrismaClient,
  repo: PermissionRepo & { id: string },
  userId: string
): Promise<PermissionLookup | null> {
  if (!(repo.organizationName && repo.repoName)) {
    return null;
  }
  // An unreadable policy falls through to the login-based question, which is
  // exactly what every caller asked before this feature existed — so a settings
  // hiccup in the new code cannot refuse a launch for someone who never saved a
  // token. The gate itself still applies; only this shortcut into it is skipped.
  const policy = await resolveUserCredentialPolicy().catch(() => null);
  if (!policy?.enabled) {
    return null;
  }
  let credential: Awaited<ReturnType<typeof resolveUserCredential>>;
  try {
    credential = await resolveUserCredential(prisma, { connectionId: repo.id, userId });
  } catch {
    return { failure: 'unavailable', ok: false };
  }
  if (!credential) {
    return null;
  }
  return fetchOwnRepoPermission({
    apiUrl: credential.apiUrl,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
    token: credential.token,
  });
}

/**
 * Resolve a platform user's GitHub login.
 *
 * Null means the user has never linked a GitHub identity, which is a different
 * condition from having no access: there is nobody to ask GitHub about. The
 * advisory rollout exists so these users are found before enforcement makes
 * them undeniable.
 */
export async function githubLoginFor(prisma: PrismaClient, userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    select: { githubLogin: true },
    where: { id: userId },
  });
  return user?.githubLogin ?? null;
}

/**
 * The user's GitHub login, confirmed to still name their account.
 *
 * Three places write permission answers: the worker's sweep, this process's
 * launch path, and the webhook refresh. Only the sweep verified ownership,
 * which meant the other two kept re-populating rows under a login that had been
 * re-registered by someone else, in between sweeps — the exact condition the
 * verification exists to end. A check that one of three writers performs is not
 * a check.
 *
 * Returns null when there is no login, or when the login no longer belongs to
 * this user; `verifyGithubLoginOwnership` has already cleared it in the second
 * case. A caller cannot tell the two apart and does not need to: both mean
 * there is no identity to ask GitHub about.
 *
 * A lookup that cannot be made leaves the login in place and returns it — the
 * same "an outage is not evidence" rule the rest of this subsystem follows.
 */
export async function verifiedGithubLoginFor(
  prisma: PrismaClient,
  userId: string
): Promise<string | null> {
  const login = await githubLoginFor(prisma, userId);
  if (!login) {
    return null;
  }
  const ghConfig = await resolveGitHubConfig();
  const token = await resolveGitHubToken(ghConfig).catch(() => null);
  const ownership = await verifyGithubLoginOwnership(prisma, {
    // A fixed github.com base: the stored account id comes from better-auth's
    // built-in `github` provider, which always talks to github.com, while the
    // instance `apiUrl` is admin-settable to a GitHub Enterprise base.
    apiUrl: GITHUB_ACCOUNT_API_URL,
    login,
    token,
    userId,
  });
  return ownership.status === 'reassigned' ? null : login;
}
