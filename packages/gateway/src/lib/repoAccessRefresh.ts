/**
 * Acting on an access invalidation: re-ask GitHub for the pairs a webhook made
 * stale, and record the answers.
 *
 * Refreshing rather than deleting is deliberate. Deleting the rows would make
 * every affected user look un-asked-about until the next sweep, and under
 * enforcement "un-asked-about" is indistinguishable from denied — so a routine
 * membership change would lock a team out for up to a sweep interval.
 */
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveUserCredentialPolicy } from '@auto-swe/shared/lib/connectionCredential';
import { recordRepoPermission } from '@auto-swe/shared/lib/repoAccessProjection';
import {
  allRepoMemberships,
  repoMembersSelect,
  repoMemberWhere,
} from '@auto-swe/shared/lib/repoMembership';
import {
  lookupPermissionViaUserCredential,
  lookupRepoPermission,
  PERMISSION_REPO_SELECT,
  verifiedGithubLoginFor,
} from '@auto-swe/shared/lib/repoPermission';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { AccessInvalidation } from './repoAccessWebhook.js';
import { webhookHostScope, webhookRepositoryWhere } from './repositoryHost.js';

export interface RefreshOutcome {
  /** Pairs GitHub answered for. */
  refreshed: number;
  /** Pairs whose lookup failed — their previous answers are left in place. */
  failed: number;
  /** Why nothing was done, when nothing was. */
  skipped?: string;
}

/**
 * The connection columns a refresh needs, plus everyone who reaches it: the
 * owning team's members and those of every team it is shared with.
 */
const REFRESH_SELECT = {
  ...PERMISSION_REPO_SELECT,
  credentials: { select: { userId: true } },
  id: true,
  ...repoMembersSelect(
    { user: { select: { githubLogin: true, id: true } } },
    { user: { isActive: true } }
  ),
} as const;

/**
 * Bound on how many pairs one webhook may refresh.
 *
 * A `user`-kind invalidation fans out across every repository that user can
 * reach, and GitHub can deliver these in bursts (a bulk team change emits one
 * per member). Without a cap, one organization edit could spend the API budget
 * for the hour. Anything above the cap is left to the scheduled sweep, which is
 * exactly the fallback the sweep exists to be.
 */
const MAX_PAIRS_PER_EVENT = 200;

/**
 * Re-ask GitHub about everything `invalidation` made stale.
 *
 * Returns counts rather than throwing: this runs on a webhook, and GitHub
 * retries a non-2xx delivery. Failing the response because one lookup timed out
 * would turn a transient hiccup into a redelivery storm, and the previous
 * answers are still in place either way.
 */
export async function refreshInvalidatedAccess(
  prisma: PrismaClient,
  invalidation: AccessInvalidation,
  verifiedHost: string | null
): Promise<RefreshOutcome> {
  if (invalidation.kind === 'ignored') {
    return { failed: 0, refreshed: 0, skipped: invalidation.reason };
  }

  // A webhook names a GitHub org/repo or login; which teams those map to is
  // exactly what we are here to find out, so the lookup spans tenants. A named
  // repository is matched on its host as well when the owner/name alone is
  // onboarded on more than one host — those are different repositories. Either
  // way the lookup is bound to the host the delivery's secret proved: a user
  // event names no repository, but it still may not reach another host's.
  let repoWhere: Prisma.ConnectionWhereInput;
  if (invalidation.kind === 'user') {
    const reachable = repoMemberWhere({ user: { githubLogin: invalidation.login } });
    repoWhere = { AND: [reachable, await webhookHostScope(prisma, verifiedHost, reachable)] };
  } else {
    repoWhere = await webhookRepositoryWhere(
      prisma,
      invalidation.org,
      invalidation.repo,
      invalidation.htmlUrl,
      verifiedHost
    );
  }
  const repos = await runUnscoped(
    'a webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: REFRESH_SELECT,
        where: { isActive: true, type: 'git_repo', ...repoWhere },
      })
  );

  if (repos.length === 0) {
    return { failed: 0, refreshed: 0, skipped: 'no configured repository matches this event' };
  }

  // For a `pair` or `user` event only the named login is affected; for a `repo`
  // event every member of the owning team is.
  const targetLogin = invalidation.kind === 'repo' ? null : invalidation.login;

  const outcome: RefreshOutcome = { failed: 0, refreshed: 0 };
  let budget = MAX_PAIRS_PER_EVENT;

  // Ownership is a fact about the user, so it is confirmed once per user across
  // the whole batch rather than once per pair. Without it this writer would
  // re-populate rows under a login that has been re-registered by someone else
  // — the sweep verifying is no use if the other two writers do not.
  const verifiedLogins = new Map<string, string | null>();
  async function loginFor(userId: string): Promise<string | null> {
    const cached = verifiedLogins.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const login = await verifiedGithubLoginFor(prisma, userId);
    verifiedLogins.set(userId, login);
    return login;
  }

  // Read once: with the feature off, a saved credential is inert and must not
  // pull its holder into the event's pair budget. Unreadable reads as off, so
  // the refresh falls back to the login-based lookup it always made.
  const credentialsOn = (await resolveUserCredentialPolicy().catch(() => null))?.enabled ?? false;

  for (const repo of repos) {
    const credentialHolders = new Set(repo.credentials.map((c) => c.userId));
    // Owning and shared teams can overlap; one pair is asked about once.
    const seen = new Set<string>();
    for (const { user } of allRepoMemberships(repo)) {
      if (seen.has(user.id)) {
        continue;
      }
      seen.add(user.id);
      const hasCredential = credentialsOn && credentialHolders.has(user.id);
      if (!(user.githubLogin || hasCredential)) {
        continue;
      }
      // A `pair` or `user` event names a login, so it can only be about a
      // member whose stored login it is — a credential holder without one is
      // covered by `repo` events and the sweep.
      if (targetLogin && user.githubLogin !== targetLogin) {
        continue;
      }
      if (budget-- <= 0) {
        outcome.skipped = `capped at ${MAX_PAIRS_PER_EVENT} pairs; the scheduled sweep covers the rest`;
        return outcome;
      }
      // A member who saved their own token runs as it, so that is the identity
      // asked about. Null (feature off, host not allowed) falls back to the
      // login, exactly as their runs fall back to the platform credential.
      let lookup = hasCredential
        ? await lookupPermissionViaUserCredential(prisma, repo, user.id)
        : null;
      if (!lookup) {
        const login = await loginFor(user.id);
        if (!login) {
          // No identity, or one that has just been cleared for naming somebody
          // else. Either way there is nothing to ask GitHub about.
          continue;
        }
        lookup = await lookupRepoPermission(repo, login);
      }
      const write = await recordRepoPermission(prisma, {
        connectionId: repo.id,
        lookup,
        userId: user.id,
      });
      if (write.written) {
        outcome.refreshed++;
      } else {
        outcome.failed++;
      }
    }
  }

  return outcome;
}
