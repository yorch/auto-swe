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
import {
  type HostCredential,
  hostCredentialConfig,
  hostKeyOf,
  resolveHostCredential,
} from './githubHostCredential.js';
import { defaultApiUrlForHost, hostFamily } from './githubHostScope.js';
import { resolveGitHubToken } from './githubInstallation.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

/** Wall-clock cap. This runs inside a sweep, so it must not stall it. */
const LOOKUP_TIMEOUT_MS = 8_000;

/**
 * github.com's API, which answers about every account better-auth's built-in
 * `github` provider stored: it takes only a client id and secret and always
 * talks to github.com, so a bare numeric `accounts.account_id` is a github.com
 * id whatever the instance's own `apiUrl` is. Asking the instance's API about
 * one compares two different id spaces — which reads as a mismatch, and a
 * mismatch clears a valid login.
 */
export const GITHUB_ACCOUNT_API_URL = 'https://api.github.com';

/** Where, and with what credential, to ask about one stored GitHub account. */
export interface AccountTarget {
  apiUrl: string;
  /** Null: ask unauthenticated (rate-limited, so it usually reads as `unverifiable`). */
  token: string | null;
}

/** The ids behind a stored `accounts.account_id`. */
export function parseAccountId(accountId: string): { host: string; id: string } {
  const at = accountId.lastIndexOf(':');
  // A bare id comes from the built-in provider, which is github.com's.
  return at === -1
    ? { host: 'github.com', id: accountId }
    : { host: accountId.slice(0, at), id: accountId.slice(at + 1) };
}

/**
 * Resolves, per account, the host that owns its id space and the platform
 * credential that applies there.
 *
 * The id space is the account's own: a bare id is github.com's, and a GitHub
 * Enterprise sign-in stores `{host}:{id}`. The credential is the platform's for
 * THAT host (the instance's when the host is the instance's, else the one
 * configured for it under `GitHubHostCredential`) and never any other — sending
 * the instance's credential to github.com, or a host's to the instance, would
 * hand one host a credential that belongs to another. Where no credential
 * applies, a github.com account is asked unauthenticated and any other host is
 * not asked at all.
 */
export interface AccountTargets {
  /** Null: nothing may be asked about this account. */
  forAccount(accountId: string): Promise<AccountTarget | null>;
  /** Hosts asked without a credential so far, for the caller to report. */
  unauthenticatedHosts(): string[];
}

export function accountTargets(
  prisma: PrismaClient,
  config: ResolvedGitHubConfig,
  lookupHost: (host: string) => Promise<HostCredential | null> = resolveHostCredential
): AccountTargets {
  const cache = new Map<string, AccountTarget | null>();
  const unauthenticated = new Set<string>();
  const instanceHost = hostFamily(config.baseUrl);

  /** Any active installation on `host`, for an App-only host with no PAT. */
  const anyInstallation = async (installHost: string): Promise<string | null> =>
    (
      await prisma.gitHubInstallation.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { installationId: true },
        where: { host: installHost, isActive: true },
      })
    )?.installationId ?? null;

  const resolve = async (
    host: string
  ): Promise<{ target: AccountTarget | null; final: boolean }> => {
    let credentialConfig: ResolvedGitHubConfig | null = null;
    let lookupFailed = false;
    let installHost = '';
    let apiUrl: string;
    if (host === instanceHost) {
      credentialConfig = config;
      apiUrl = host === 'github.com' ? GITHUB_ACCOUNT_API_URL : config.apiUrl;
    } else {
      installHost = host;
      apiUrl = host === 'github.com' ? GITHUB_ACCOUNT_API_URL : defaultApiUrlForHost(host);
      // A row that cannot be read (undecryptable, a database error) must not
      // abort the sweep or a launch: this host is simply not askable now.
      try {
        const credential = await lookupHost(host);
        if (credential) {
          credentialConfig = hostCredentialConfig(credential, {
            apiUrl,
            baseUrl: `https://${host}`,
          });
        }
      } catch (err) {
        console.warn(
          `[repoAccess] could not load the platform credentials for ${host}; its logins are left unverified:`,
          err instanceof Error ? err.message : err
        );
        lookupFailed = true;
      }
    }
    let token: string | null = null;
    if (credentialConfig) {
      token = await resolveGitHubToken(credentialConfig).catch(() => null);
      if (!token && credentialConfig.appId && credentialConfig.appPrivateKey) {
        const installationId = await anyInstallation(installHost).catch(() => null);
        if (installationId) {
          token = await resolveGitHubToken(credentialConfig, { installationId }).catch(() => null);
        }
      }
    }
    // A failed lookup is not cached: the next account on this host retries it.
    const final = !lookupFailed;
    if (!token) {
      unauthenticated.add(host);
      // Only github.com has accounts anyone can look up without credentials,
      // and only its ids are ever asked about unauthenticated.
      return { final, target: host === 'github.com' ? { apiUrl, token: null } : null };
    }
    return { final, target: { apiUrl, token } };
  };

  return {
    async forAccount(accountId) {
      const host = hostKeyOf(parseAccountId(accountId).host);
      const hit = cache.get(host);
      if (hit) {
        return hit;
      }
      const { final, target } = await resolve(host);
      if (final) {
        cache.set(host, target);
      }
      return target;
    },
    unauthenticatedHosts: () => [...unauthenticated],
  };
}

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
    prisma.user.update({
      data: { githubLogin: null, githubLoginAccountId: null },
      where: { id: userId },
    }),
    prisma.repoAccess.deleteMany({ where: { userId } }),
  ]);
}

/**
 * {@link clearGithubLogin}, but only if the user still holds exactly the login
 * (and source account) that was verified. A sign-in can rewrite both while the
 * lookup is in flight; clearing unconditionally would wipe a login that was just
 * written, and the access rows with it. Returns whether it cleared.
 */
export async function clearGithubLoginIfUnchanged(
  prisma: PrismaClient,
  userId: string,
  login: string,
  accountId: string | null
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      data: { githubLogin: null, githubLoginAccountId: null },
      where: { githubLogin: login, githubLoginAccountId: accountId, id: userId },
    });
    if (count > 0) {
      await tx.repoAccess.deleteMany({ where: { userId } });
    }
    return count > 0;
  });
}

const CHANGED_MEANWHILE: LoginOwnershipResult = {
  reason: 'the login changed while it was being verified',
  status: 'unverifiable',
};

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
  args: { userId: string; login: string; targets: AccountTargets }
): Promise<LoginOwnershipResult> {
  const [accounts, owner] = await Promise.all([
    prisma.account.findMany({
      select: { accountId: true },
      where: { providerId: 'github', userId: args.userId },
    }),
    prisma.user.findUnique({
      select: { githubLoginAccountId: true },
      where: { id: args.userId },
    }),
  ]);
  // The account the login was read from, when that was recorded. A recorded
  // account that is no longer linked leaves the login with nothing behind it,
  // however many others are linked.
  const sourceId = owner?.githubLoginAccountId ?? null;
  const account = sourceId ? accounts.find((a) => a.accountId === sourceId) : accounts[0];
  if (!account?.accountId) {
    // No linked GitHub account, yet a login is recorded. The account-delete
    // hook handles the unlink and swallows its own failures, so this is the
    // safety net for one that slipped past — the login would otherwise back
    // repository access with nothing behind it. Reported as `unlinked` rather
    // than `reassigned` so a failed unlink does not raise the takeover alarm.
    return (await clearGithubLoginIfUnchanged(prisma, args.userId, args.login, sourceId))
      ? { clearedLogin: args.login, status: 'unlinked' }
      : CHANGED_MEANWHILE;
  }
  // A row written before the source account was recorded cannot say which of
  // several linked accounts the login came from, and a login is only comparable
  // with the id space of the host that issued it. Comparing against the wrong
  // one would clear a valid login and write a false takeover, so it is left
  // unverified.
  if (!sourceId && accounts.length > 1) {
    return {
      reason:
        'several GitHub accounts are linked and the login does not record which one it came from',
      status: 'unverifiable',
    };
  }

  // Ask the host the account's id belongs to, with that host's own credential.
  // A GitHub Enterprise id is `{host}:{id}` — that host's id space — so asking
  // any other host would read as a mismatch and clear a valid login, with a
  // false takeover audit. A host with no credential to ask with is
  // `unverifiable`, never a mismatch.
  const target = await args.targets.forAccount(account.accountId);
  if (!target) {
    return {
      reason: `no platform credential applies to ${parseAccountId(account.accountId).host}, so ownership is not verified`,
      status: 'unverifiable',
    };
  }
  const expectedId = parseAccountId(account.accountId).id;
  const currentOwner = await fetchGithubUserId(args.login, target.apiUrl, target.token);
  if (currentOwner === null) {
    return { reason: 'GitHub did not answer for this login', status: 'unverifiable' };
  }
  if (currentOwner === expectedId) {
    return { status: 'ok' };
  }

  if (!(await clearGithubLoginIfUnchanged(prisma, args.userId, args.login, sourceId))) {
    return CHANGED_MEANWHILE;
  }
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
  } catch (err) {
    // Swallowed, but never silently. In the sweep a failure here is survivable
    // because the caller logs the takeover separately; at launch time this row
    // is the ONLY record, so a permanently failing insert — a missing migration,
    // an exhausted pool — would be indistinguishable from no takeover ever
    // happening.
    console.warn(
      `[repoAccess] cleared a re-registered GitHub login for user ${userId} but could not write the audit record:`,
      err
    );
  }
}
