/**
 * Acting on an access invalidation: re-ask GitHub for the pairs a webhook made
 * stale, and record the answers.
 *
 * Refreshing rather than deleting is deliberate. Deleting the rows would make
 * every affected user look un-asked-about until the next sweep, and under
 * enforcement "un-asked-about" is indistinguishable from denied — so a routine
 * membership change would lock a team out for up to a sweep interval.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { recordRepoPermission } from '@auto-swe/shared/lib/repoAccessProjection';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { AccessInvalidation } from './repoAccessWebhook.js';
import { lookupRepoPermission, PERMISSION_REPO_SELECT } from './repoPermission.js';

export interface RefreshOutcome {
  /** Pairs GitHub answered for. */
  refreshed: number;
  /** Pairs whose lookup failed — their previous answers are left in place. */
  failed: number;
  /** Why nothing was done, when nothing was. */
  skipped?: string;
}

/** The connection columns a refresh needs, plus its team's members. */
const REFRESH_SELECT = {
  ...PERMISSION_REPO_SELECT,
  id: true,
  team: {
    select: {
      memberships: {
        select: { user: { select: { githubLogin: true, id: true } } },
        where: { user: { isActive: true } },
      },
    },
  },
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
  invalidation: AccessInvalidation
): Promise<RefreshOutcome> {
  if (invalidation.kind === 'ignored') {
    return { failed: 0, refreshed: 0, skipped: invalidation.reason };
  }

  // A webhook names a GitHub org/repo or login; which teams those map to is
  // exactly what we are here to find out, so the lookup spans tenants.
  const repos = await runUnscoped(
    'a webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: REFRESH_SELECT,
        where: {
          isActive: true,
          type: 'git_repo',
          ...(invalidation.kind === 'user'
            ? { team: { memberships: { some: { user: { githubLogin: invalidation.login } } } } }
            : { organizationName: invalidation.org, repoName: invalidation.repo }),
        },
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

  for (const repo of repos) {
    for (const { user } of repo.team.memberships) {
      if (!user.githubLogin) {
        continue;
      }
      if (targetLogin && user.githubLogin !== targetLogin) {
        continue;
      }
      if (budget-- <= 0) {
        outcome.skipped = `capped at ${MAX_PAIRS_PER_EVENT} pairs; the scheduled sweep covers the rest`;
        return outcome;
      }
      const lookup = await lookupRepoPermission(repo, user.githubLogin);
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
