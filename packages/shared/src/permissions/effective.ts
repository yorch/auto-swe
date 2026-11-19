import { decide } from './can.js';
import { CATALOG, type CapabilityKey } from './catalog/index.js';
import { loadStanding, type PermissionsDb } from './load.js';
import { isPlatformAdmin } from './standing.js';
import type { Actor, Authority, CapabilityDef, Resource } from './types.js';

/**
 * The caller's own effective permissions: what `GET /api/v1/me/permissions` answers. It is derived
 * from `loadStanding` and `decide`, so it cannot disagree with the checks the routes make.
 */

/** A capability the person holds, and the ground they hold it on. */
export interface HeldCapability {
  key: CapabilityKey;
  authority: Authority;
}

export interface EffectiveTeam {
  teamId: string;
  slug: string;
  name: string;
  orgId: string | null;
  /** The caller's stored team role, or `null` when they hold capabilities only through authority. */
  role: string | null;
  capabilities: HeldCapability[];
}

export interface EffectiveOrganization {
  orgId: string;
  name: string;
  role: string;
  capabilities: HeldCapability[];
}

export interface EffectivePermissions {
  platformRole: string;
  /** Platform-level capabilities the caller holds (all of them for a platform administrator). */
  platformCapabilities: CapabilityKey[];
  teams: EffectiveTeam[];
  organizations: EffectiveOrganization[];
}

/**
 * Why a narrowed answer was refused. Both reasons are one response to the caller: the team a
 * person has no standing on is not distinguishable from one that does not exist.
 */
export type EffectiveRefusal = 'NO_STANDING' | 'NOT_FOUND';

export type EffectiveResult =
  | { ok: true; value: EffectivePermissions }
  | { ok: false; reason: EffectiveRefusal };

const KEYS = (Object.keys(CATALOG) as CapabilityKey[]).sort();

function heldOn(
  standing: Awaited<ReturnType<typeof loadStanding>>,
  scope: 'org' | 'team',
  resource: Resource
): HeldCapability[] {
  const held: HeldCapability[] = [];
  for (const key of KEYS) {
    const def: CapabilityDef = CATALOG[key];
    if (def.scope !== scope) {
      continue;
    }
    const decision = decide(standing, key, resource);
    if (decision.allowed) {
      held.push({ authority: decision.authority, key });
    }
  }
  return held;
}

/**
 * The caller's effective permissions. For every team and organization the person is a member of it
 * lists the capabilities they hold, each tagged with its authority. With `teamId` it is narrowed to
 * that team, and includes the team when the person holds capabilities on it only through
 * organization or platform authority. A person with no standing on the named team (not a member, not
 * a member of its organization, not a platform administrator) is refused, and the refusal is the
 * same whether the team exists or not.
 */
export async function effectivePermissions(
  prisma: PermissionsDb,
  actor: Extract<Actor, { kind: 'user' }>,
  opts: { teamId?: string } = {}
): Promise<EffectiveResult> {
  const platformAdmin = isPlatformAdmin(actor);
  const [teamRows, orgRows] = await Promise.all([
    prisma.teamMembership.findMany({
      select: {
        role: true,
        team: { select: { id: true, name: true, orgId: true, slug: true } },
      },
      where: { userId: actor.id },
    }),
    prisma.organizationMembership.findMany({
      select: { organization: { select: { name: true } }, orgId: true, role: true },
      where: { userId: actor.id },
    }),
  ]);

  const teams = new Map<string, { role: string | null; row: (typeof teamRows)[number]['team'] }>();
  for (const m of teamRows) {
    teams.set(m.team.id, { role: m.role as string, row: m.team });
  }
  let orgs = orgRows;

  if (opts.teamId) {
    const named = await prisma.team.findUnique({
      select: { id: true, name: true, orgId: true, slug: true },
      where: { id: opts.teamId },
    });
    const memberOfOrg = named?.orgId ? orgRows.some((o) => o.orgId === named.orgId) : false;
    const member = teams.has(opts.teamId);
    if (!named) {
      return { ok: false, reason: platformAdmin ? 'NOT_FOUND' : 'NO_STANDING' };
    }
    if (!(member || memberOfOrg || platformAdmin)) {
      return { ok: false, reason: 'NO_STANDING' };
    }
    const mine = teams.get(named.id);
    teams.clear();
    teams.set(named.id, { role: mine?.role ?? null, row: named });
    orgs = orgRows.filter((o) => o.orgId === named.orgId);
  }

  const resource: Resource = {
    anyOf: [
      { anyTeam: true },
      ...[...teams.keys()].map((teamId) => ({ teamId })),
      ...orgs.map((o) => ({ orgId: o.orgId })),
    ],
  };
  const standing = await loadStanding(prisma, actor, resource);

  const platformCapabilities = KEYS.filter((key) => {
    const def: CapabilityDef = CATALOG[key];
    if (def.scope !== 'platform') {
      return false;
    }
    // A platform capability a team role also confers is a person-level question.
    return decide(standing, key, def.team ? { anyTeam: true } : undefined).allowed;
  });

  return {
    ok: true,
    value: {
      organizations: orgs
        .map((o) => ({
          capabilities: heldOn(standing, 'org', { orgId: o.orgId }),
          name: o.organization.name,
          orgId: o.orgId,
          role: o.role as string,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.orgId.localeCompare(b.orgId)),
      platformCapabilities,
      platformRole: actor.role,
      teams: [...teams.values()]
        .map(({ role, row }) => ({
          capabilities: heldOn(standing, 'team', { teamId: row.id }),
          name: row.name,
          orgId: row.orgId ?? null,
          role,
          slug: row.slug,
          teamId: row.id,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug) || a.teamId.localeCompare(b.teamId)),
    },
  };
}
