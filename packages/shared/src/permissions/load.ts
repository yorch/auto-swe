import type { PrismaClient } from '../generated/prisma/client.js';
import { decide, orgRuleApplies, platformAdminHolds, requiresActiveTeam } from './can.js';
import { CATALOG, type CapabilityKey } from './catalog/index.js';
import { isPlatformAdmin, orgRankMeets, orgRankOf, teamRankMeets, teamRankOf } from './standing.js';
import type {
  Actor,
  CapabilityDef,
  Decision,
  HeldScope,
  OrgStanding,
  Resource,
  Standing,
  TeamStanding,
} from './types.js';

/**
 * The database side: load what `decide` needs, then call it. The gateway and the worker both use
 * this, so a launch and a scheduled fire cannot disagree about the same person. A transaction
 * client works as well as the shared one.
 */
export type PermissionsDb = Pick<
  PrismaClient,
  'organizationMembership' | 'team' | 'teamMembership'
>;

interface Wanted {
  teamIds: Set<string>;
  orgIds: Set<string>;
  anyTeam: boolean;
}

function collect(resource: Resource, wanted: Wanted): void {
  if (!resource) {
    return;
  }
  if ('teamId' in resource) {
    wanted.teamIds.add(resource.teamId);
  } else if ('orgId' in resource) {
    wanted.orgIds.add(resource.orgId);
  } else if ('anyOf' in resource) {
    for (const r of resource.anyOf) {
      collect(r, wanted);
    }
  } else if ('allOf' in resource) {
    for (const r of resource.allOf) {
      collect(r, wanted);
    }
  } else if ('anyTeam' in resource) {
    wanted.anyTeam = true;
  }
}

/** The actor as `decide` takes it, from a request's user. */
export function userActor(user: { sub: string; role: string }): Actor {
  return { id: user.sub, kind: 'user', role: user.role };
}

/** Load the actor's standing on every team and organization `resource` names. */
export async function loadStanding(
  prisma: PermissionsDb,
  actor: Actor,
  resource?: Resource
): Promise<Standing> {
  const teams = new Map<string, TeamStanding>();
  const orgs = new Map<string, OrgStanding>();
  if (actor.kind === 'principal') {
    return { actor, orgs, platformAdmin: false, teams };
  }
  const platformAdmin = isPlatformAdmin(actor);
  const wanted: Wanted = { anyTeam: false, orgIds: new Set(), teamIds: new Set() };
  collect(resource, wanted);

  const teamIds = [...wanted.teamIds];
  const [teamRows, memberRows, allMemberRows] = await Promise.all([
    teamIds.length
      ? prisma.team.findMany({
          select: { id: true, isActive: true, orgId: true },
          where: { id: { in: teamIds } },
        })
      : Promise.resolve([]),
    teamIds.length
      ? prisma.teamMembership.findMany({
          select: { role: true, teamId: true },
          where: { teamId: { in: teamIds }, userId: actor.id },
        })
      : Promise.resolve([]),
    wanted.anyTeam
      ? prisma.teamMembership.findMany({
          select: { role: true, team: { select: { id: true, isActive: true, orgId: true } } },
          where: { userId: actor.id },
        })
      : Promise.resolve([]),
  ]);

  const roleByTeam = new Map(memberRows.map((m) => [m.teamId, m.role as string]));
  for (const t of teamRows) {
    const stored = roleByTeam.get(t.id) ?? null;
    teams.set(t.id, {
      isActive: t.isActive,
      orgId: t.orgId ?? null,
      rank: teamRankOf(stored),
      storedRole: stored,
      teamId: t.id,
    });
    if (t.orgId) {
      wanted.orgIds.add(t.orgId);
    }
  }
  const memberships: TeamStanding[] = allMemberRows.map((m) => ({
    isActive: m.team.isActive,
    orgId: m.team.orgId ?? null,
    rank: teamRankOf(m.role as string),
    storedRole: m.role as string,
    teamId: m.team.id,
  }));

  // An `anyTeam` question reads every organization the actor belongs to; a named resource only
  // the organizations it names or its teams belong to.
  const orgRows =
    wanted.orgIds.size > 0 || wanted.anyTeam
      ? await prisma.organizationMembership.findMany({
          select: { orgId: true, role: true },
          where: wanted.anyTeam
            ? { userId: actor.id }
            : { orgId: { in: [...wanted.orgIds] }, userId: actor.id },
        })
      : [];
  for (const orgId of wanted.orgIds) {
    orgs.set(orgId, { orgId, rank: null });
  }
  for (const row of orgRows) {
    orgs.set(row.orgId, { orgId: row.orgId, rank: orgRankOf(row.role as string) });
  }

  return {
    actor,
    ...(wanted.anyTeam ? { memberships } : {}),
    orgs,
    platformAdmin,
    teams,
  };
}

/** Whether `actor` holds `capability` on `resource`. */
export async function can(
  prisma: PermissionsDb,
  actor: Actor,
  capability: CapabilityKey,
  resource?: Resource
): Promise<Decision> {
  const standing = await loadStanding(prisma, actor, resource);
  return decide(standing, capability, resource);
}

/**
 * The set a list endpoint may filter by, so a list and the action behind it cannot disagree.
 *
 * One membership query (with each team's activity and organization), and, only when the capability
 * lets an organization role confer it, one organization-membership query and one lookup of those
 * organizations' teams. Nothing is asked per row.
 */
export async function heldScope(
  prisma: PermissionsDb,
  actor: Actor,
  capability: CapabilityKey
): Promise<HeldScope> {
  const def: CapabilityDef = CATALOG[capability];
  const none: HeldScope = { all: false, orgIds: [], teamIds: [] };
  if (actor.kind === 'principal') {
    return none;
  }
  if (isPlatformAdmin(actor) && platformAdminHolds(def)) {
    return { all: true, orgIds: [], teamIds: [] };
  }

  const needActive = requiresActiveTeam(def);
  const teamIds = new Set<string>();
  const orgIds = new Set<string>();

  if (def.scope === 'team' || (def.scope === 'platform' && def.team)) {
    if (def.team) {
      const rows = await prisma.teamMembership.findMany({
        select: { role: true, team: { select: { id: true, isActive: true } } },
        where: { userId: actor.id },
      });
      for (const row of rows) {
        if (
          (!needActive || row.team.isActive) &&
          teamRankMeets(teamRankOf(row.role as string), def.team)
        ) {
          teamIds.add(row.team.id);
        }
      }
    }
  }

  if (def.org && (def.scope === 'org' || orgRuleApplies(def))) {
    const rows = await prisma.organizationMembership.findMany({
      select: { orgId: true, role: true },
      where: { userId: actor.id },
    });
    for (const row of rows) {
      if (orgRankMeets(orgRankOf(row.role as string), def.org)) {
        orgIds.add(row.orgId);
      }
    }
    if (def.scope === 'team' && orgIds.size > 0) {
      const teams = await prisma.team.findMany({
        select: { id: true },
        where: { orgId: { in: [...orgIds] }, ...(needActive ? { isActive: true } : {}) },
      });
      for (const t of teams) {
        teamIds.add(t.id);
      }
    }
  }

  return { all: false, orgIds: [...orgIds], teamIds: [...teamIds] };
}
