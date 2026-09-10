/**
 * Capturing a platform user's GitHub username.
 *
 * The repository-permission projection asks GitHub "what access does <login>
 * have to <org>/<repo>", so it needs a login. better-auth records only the
 * provider's numeric id on `Account.accountId`, and GitHub exposes no supported
 * REST route from a numeric id back to a login — so the login has to be taken
 * at the one moment it is in hand: the OAuth callback, where the account's own
 * token will answer `GET /user`.
 *
 * Everything here is best-effort by construction. It runs on the sign-in path,
 * and a GitHub outage must not stop a user signing in — it only means their
 * permission rows cannot be resolved yet, which the advisory rollout is there
 * to surface.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { isUniqueConstraintError } from './prismaErrors.js';

/** Wall-clock cap: this sits on the sign-in path, so it must not hang it. */
const PROFILE_FETCH_TIMEOUT_MS = 5_000;

export interface GithubLoginSyncResult {
  /** The login written, or null when nothing was written. */
  login: string | null;
  /** Why nothing was written — for the caller's log line. */
  reason?: 'fetch-failed' | 'no-login' | 'claimed-by-another-user';
}

/**
 * Ask GitHub who owns `accessToken`.
 *
 * Returns null rather than throwing: every caller is on a path where failing
 * closed would break sign-in, and a missing login is recoverable by the
 * backfill or the user's next sign-in.
 */
export async function fetchGithubLogin(
  accessToken: string,
  apiUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || body.login.length === 0) {
      return null;
    }
    // Lower-cased on the way in. GitHub logins are case-insensitive — `Octocat`
    // and `octocat` are one account — but `users.github_login` is unique
    // byte-exact, so storing them as returned would let two platform users hold
    // what GitHub considers the same identity, which is precisely what that
    // index exists to prevent. Every lookup uses the stored value, and GitHub's
    // API is equally case-insensitive, so normalising costs nothing.
    return body.login.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Record `login` as `userId`'s GitHub identity.
 *
 * `users.github_login` is unique, so a login already held by a different user
 * makes this a no-op rather than a move. Stealing it would silently transfer
 * that user's repository access to this one, which is the exact failure the
 * uniqueness constraint exists to prevent — so the collision is reported and
 * left for an operator, not resolved by whoever signed in last.
 */
export async function storeGithubLogin(
  prisma: PrismaClient,
  userId: string,
  login: string
): Promise<GithubLoginSyncResult> {
  try {
    await prisma.user.update({ data: { githubLogin: login }, where: { id: userId } });
    return { login };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Clear rather than keep. Keeping would leave this user authenticating as
      // the account they just linked while the platform resolved their
      // repository permissions as the previous one — fail-closed for the other
      // user and fail-OPEN for this one. A null login denies under enforcement
      // and is visible to the operator, which is the right side to land on.
      await clearGithubLogin(prisma, userId);
      return { login: null, reason: 'claimed-by-another-user' };
    }
    throw err;
  }
}

/**
 * Forget a user's GitHub identity.
 *
 * Called when the GitHub account is unlinked and when a login turns out to be
 * held by someone else. A login left behind keeps backing repository access
 * with nothing standing behind it, and GitHub usernames are re-registrable
 * after release — so a stale one can eventually name a different person.
 */
export async function clearGithubLogin(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ data: { githubLogin: null }, where: { id: userId } });
}

/**
 * Resolve and store the GitHub login behind a freshly linked OAuth account.
 *
 * Called from the better-auth `account.create.after` hook, which fires both
 * when a GitHub sign-in creates a user and when an existing user links GitHub
 * — the two paths that need to end in the same place.
 */
export async function syncGithubLoginForAccount(
  prisma: PrismaClient,
  args: { userId: string; accessToken: string | null | undefined; apiUrl: string }
): Promise<GithubLoginSyncResult> {
  if (!args.accessToken) {
    return { login: null, reason: 'fetch-failed' };
  }
  const login = await fetchGithubLogin(args.accessToken, args.apiUrl);
  if (!login) {
    return { login: null, reason: 'no-login' };
  }
  return storeGithubLogin(prisma, args.userId, login);
}
