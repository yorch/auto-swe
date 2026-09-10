/**
 * The gateway's side of "what access does this user have to this repository".
 *
 * The worker asks the same question through the `ScmProvider` seam. Both end up
 * in `@auto-swe/shared/lib/githubPermission`; what differs is only how each
 * process gets from a `Connection` row to a credential, and the gateway is the
 * side that has the row in hand.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  GITHUB_ACCOUNT_API_URL,
  verifyGithubLoginOwnership,
} from '@auto-swe/shared/lib/githubIdentityCheck';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { fetchRepoPermission, type PermissionLookup } from '@auto-swe/shared/lib/githubPermission';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';

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
