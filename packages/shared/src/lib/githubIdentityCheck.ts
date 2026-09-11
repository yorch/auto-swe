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

/**
 * The host that answers about a GitHub *account*, as opposed to a repository.
 *
 * Fixed, not taken from configuration. `accounts.account_id` is written by
 * better-auth's built-in `github` social provider, which takes only a client id
 * and secret and always talks to github.com. The instance-wide `apiUrl` is
 * admin-settable to a GitHub Enterprise `/api/v3` base, and asking that host
 * about a github.com account id compares two different id spaces — which reads
 * as a mismatch, and a mismatch clears a valid login.
 *
 * A consequence worth stating: on a GitHub Enterprise deployment no login is
 * ever stored (the OAuth token 401s against the Enterprise API), so this check
 * has nothing to verify there rather than verifying it wrongly.
 */
export const GITHUB_ACCOUNT_API_URL = 'https://api.github.com';

export type LoginOwnershipResult =
  /** The login still resolves to this user's GitHub account. */
  | { status: 'ok' }
  /** The login now belongs to a different account. It has been cleared. */
  | { status: 'reassigned'; clearedLogin: string }
  /**
   * A login with no GitHub account behind it — an unlink whose hook failed.
   * Cleared, but deliberately distinct from `reassigned`: the caller raises an
   * alarm on a takeover, and a benign failed unlink must not trip it.
   */
  | { status: 'unlinked'; clearedLogin: string }
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

/**
 * Forget a user's GitHub identity, and the access that identity was backing.
 *
 * Dropping the login alone is not enough. Listing enforcement reads
 * `repo_access` by user id, never through the login, so rows already written
 * stay valid until they age past `repoAccess.viewStaleAfterHours` — three days
 * by default. On a takeover those rows are precisely the ones recorded from the
 * impostor's permissions, so leaving them is detecting the problem and then
 * doing nothing about it for three days.
 *
 * The rows are a cache, so deleting them costs only a re-ask: the next sweep
 * rebuilds whatever the user is genuinely entitled to, once they have an
 * identity again. Launching is unaffected either way, because it asks live.
 */
export async function clearGithubLogin(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ data: { githubLogin: null }, where: { id: userId } }),
    prisma.repoAccess.deleteMany({ where: { userId } }),
  ]);
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
    // No linked GitHub account, yet a login is recorded. The account-delete
    // hook handles the unlink and swallows its own failures, so this is the
    // safety net for one that slipped past — the login would otherwise back
    // repository access with nothing behind it. Reported as `unlinked` rather
    // than `reassigned` so a failed unlink does not raise the takeover alarm.
    await clearGithubLogin(prisma, args.userId);
    return { clearedLogin: args.login, status: 'unlinked' };
  }

  const currentOwner = await fetchGithubUserId(args.login, args.apiUrl, args.token);
  if (currentOwner === null) {
    return { reason: 'GitHub did not answer for this login', status: 'unverifiable' };
  }
  if (currentOwner === account.accountId) {
    return { status: 'ok' };
  }

  await clearGithubLogin(prisma, args.userId);
  await recordTakeover(prisma, args.userId, args.login, currentOwner, account.accountId);
  return { clearedLogin: args.login, status: 'reassigned' };
}

/**
 * Record a takeover in the governance audit log.
 *
 * A log line is where this was reported before, and a log line is gone by the
 * time anyone asks. This is durable, it sits at `/govern/audit` beside every
 * other governance change, and it survives the process — which matters for the
 * one event in this subsystem that says somebody's recorded identity was
 * claimed by a stranger.
 *
 * Written here rather than by the callers, so neither the sweep nor the launch
 * path can detect a takeover and forget to record it. `actorId` is null: this
 * is the system acting, not a person.
 *
 * Best-effort. A failure to write the audit row must not stop the clearing that
 * already happened — losing the record is bad, leaving the login in place is
 * worse.
 */
async function recordTakeover(
  prisma: PrismaClient,
  userId: string,
  clearedLogin: string,
  newOwnerAccountId: string,
  expectedAccountId: string
): Promise<void> {
  try {
    await prisma.configAuditLog.create({
      data: {
        action: 'UPDATE',
        actorId: null,
        afterJson: {
          githubLogin: null,
          // Both ids, so an operator can see what the name resolves to now and
          // what it used to. Neither is a secret.
          observedAccountId: newOwnerAccountId,
          reason: 'login-reassigned',
        },
        beforeJson: { accountId: expectedAccountId, githubLogin: clearedLogin },
        entityId: userId,
        entityType: 'User',
      },
    });
  } catch {
    // Swallowed deliberately — see the note above.
  }
}
