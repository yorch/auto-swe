/**
 * Confirming a stored GitHub login still belongs to the person it was stored for.
 *
 * `users.github_login` is captured when a GitHub account is linked and refreshed
 * on each sign-in. Between sign-ins it can go stale in a way that matters:
 * GitHub releases a username on rename and lets anyone re-register it, so a
 * login recorded months ago can end up naming a different person — and the
 * permission projection asks GitHub about that name.
 *
 * The fix is not to re-read the login (that only works while the user is
 * signing in) but to check the thing that cannot change. GitHub's numeric
 * account id is stable across renames, and better-auth already stores it on
 * `accounts.account_id`. Asking GitHub who owns the login today and comparing
 * ids catches exactly the dangerous case.
 *
 * A plain rename is deliberately NOT dangerous: GitHub redirects the old name
 * to the same account, so the id still matches and the stored login keeps
 * working. Only re-registration by someone else produces a mismatch.
 */
import type { PrismaClient } from '../index.js';

/** Wall-clock cap. This runs inside a sweep, so it must not stall it. */
const LOOKUP_TIMEOUT_MS = 8_000;

export type LoginOwnershipResult =
  /** The login still resolves to this user's GitHub account. */
  | { status: 'ok' }
  /** The login now belongs to a different account. It has been cleared. */
  | { status: 'reassigned'; clearedLogin: string }
  /** GitHub could not be asked. Nothing was changed. */
  | { status: 'unverifiable'; reason: string };

/**
 * Ask GitHub which account owns `login` today.
 *
 * Returns the numeric id as a string, matching how better-auth stores it.
 * Never throws: the caller is a sweep that must survive a bad answer.
 */
export async function fetchGithubUserId(
  login: string,
  apiUrl: string,
  token: string | null
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/users/${encodeURIComponent(login)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { id?: unknown };
    // GitHub returns a JSON number; better-auth stores the id as a string.
    return typeof body.id === 'number' || typeof body.id === 'string' ? String(body.id) : null;
  } catch {
    return null;
  }
}

/** Forget a user's GitHub identity. */
export async function clearGithubLogin(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ data: { githubLogin: null }, where: { id: userId } });
}

/**
 * Verify `login` still names `userId`'s GitHub account, and clear it if not.
 *
 * **Only a confirmed mismatch clears.** A failed lookup leaves the login alone:
 * an outage is not evidence that a name changed hands, and clearing on one
 * would revoke every unlucky user's access for a reason GitHub never gave. That
 * is the same rule the permission projection follows for the same reason.
 */
export async function verifyGithubLoginOwnership(
  prisma: PrismaClient,
  args: { userId: string; login: string; apiUrl: string; token: string | null }
): Promise<LoginOwnershipResult> {
  const account = await prisma.account.findFirst({
    select: { accountId: true },
    where: { providerId: 'github', userId: args.userId },
  });
  if (!account?.accountId) {
    // No linked GitHub account, yet a login is recorded. That is the unlink
    // case the account-delete hook is meant to handle; if one slipped past it,
    // the login is backing access with nothing behind it.
    await clearGithubLogin(prisma, args.userId);
    return { clearedLogin: args.login, status: 'reassigned' };
  }

  const currentOwner = await fetchGithubUserId(args.login, args.apiUrl, args.token);
  if (currentOwner === null) {
    return { reason: 'GitHub did not answer for this login', status: 'unverifiable' };
  }
  if (currentOwner === account.accountId) {
    return { status: 'ok' };
  }

  await clearGithubLogin(prisma, args.userId);
  return { clearedLogin: args.login, status: 'reassigned' };
}
