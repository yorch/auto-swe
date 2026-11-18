import type { PrismaClient } from '@auto-swe/shared';
import type { TrackerLaunchTeam } from '@auto-swe/shared/lib/trackerSync';

/** The launcher whose contexts are recorded: a person, or the team a service principal belongs to. */
export type TrackerLaunchCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'service'; teamId: string };

/**
 * The tracker project-allowlist contexts a launch with no repository and no template team records
 * on its run (`RunInput.trackerScopeContexts`), computed once and used for both the brief lookup
 * and the stored value, so the worker and the gateway cannot disagree.
 *
 * - A person: each ACTIVE team they belong to (in an active organization) as `{ teamId, orgId }`,
 *   plus `{ orgId }` for each active organization they belong to where none of their listed teams
 *   is of that organization, so a member of an organization with no team of their own resolves at
 *   the organization rather than GLOBAL.
 * - A service principal: its own team `{ teamId, orgId }` when that team and its organization are
 *   active.
 * - Neither: an empty list, which is GLOBAL only.
 *
 * Throws on a database failure; the caller decides whether that refuses the launch.
 */
export async function loadLaunchTrackerContexts(
  prisma: PrismaClient,
  caller: TrackerLaunchCaller
): Promise<TrackerLaunchTeam[]> {
  if (caller.kind === 'service') {
    const team = await prisma.team.findUnique({
      select: {
        id: true,
        isActive: true,
        organization: { select: { isActive: true } },
        orgId: true,
      },
      where: { id: caller.teamId },
    });
    if (!team?.isActive || !team.organization?.isActive) {
      return [];
    }
    return [{ orgId: team.orgId, teamId: team.id }];
  }
  const memberships = await prisma.teamMembership.findMany({
    select: { team: { select: { orgId: true } }, teamId: true },
    where: {
      team: { isActive: true, organization: { isActive: true } },
      userId: caller.userId,
    },
  });
  const contexts: TrackerLaunchTeam[] = memberships.map((m) => ({
    orgId: m.team.orgId,
    teamId: m.teamId,
  }));
  const covered = new Set(contexts.map((c) => c.orgId));
  const orgMemberships = await prisma.organizationMembership.findMany({
    select: { orgId: true },
    where: { organization: { isActive: true }, userId: caller.userId },
  });
  for (const { orgId } of orgMemberships) {
    if (!covered.has(orgId)) {
      covered.add(orgId);
      contexts.push({ orgId });
    }
  }
  return contexts;
}
