import {
  type ConfigGrant,
  canWriteAnySetting as grantsReachAnySetting,
} from '../config/permissions.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { PlatformRole } from '../generated/prisma/enums.js';
import { runUnscoped } from '../lib/tenantGuard.js';
import { decide } from './can.js';
import { CATALOG, type CapabilityKey } from './catalog/index.js';
import { loadStanding, type PermissionsDb } from './load.js';
import { isPlatformAdmin, orgIsAdmin } from './standing.js';
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
  /**
   * Whether the caller may change at least one registered setting somewhere: a platform
   * administrator, or a person a configuration grant covers for a setting a grant can reach. It is
   * the question behind the Platform settings entry, answered by the settings write rule itself.
   */
  canWriteAnySetting: boolean;
}

/** What the effective-permissions view reads: the standing tables plus the configuration grants. */
export type EffectivePermissionsDb = PermissionsDb & Pick<PrismaClient, 'configPermission'>;

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
 * The configuration grants that could apply to a person: their own, and the role grants of the
 * teams they are on. The one query both the effective-permissions view and the gateway's write
 * check use. The caller wraps it in `runUnscoped` where the tenant guard needs it.
 */
export async function loadGrantRows(
  prisma: Pick<PrismaClient, 'configPermission'>,
  userId: string,
  teamIds: string[]
): Promise<ConfigGrant[]> {
  const rows = await prisma.configPermission.findMany({
    select: { keyPattern: true, orgId: true, role: true, scope: true, teamId: true, userId: true },
    where: {
      OR: [
        { userId },
        ...(teamIds.length
          ? [{ scope: 'TEAM' as const, teamId: { in: teamIds }, userId: null }]
          : []),
      ],
    },
  });
  return rows as ConfigGrant[];
}

/**
 * The caller's effective permissions. For every team and organization the person is a member of it
 * lists the capabilities they hold, each tagged with its authority. With `teamId` it is narrowed to
 * that team, and includes the team when the person holds capabilities on it only through
 * organization or platform authority. A person with no standing on the named team (not a member, not
 * a member of its organization, not a platform administrator) is refused, and the refusal is the
 * same whether the team exists or not.
 */
async function effectivePermissionsUnscoped(
  prisma: EffectivePermissionsDb,
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
    // Only an organization ADMIN may name a team they are not on: any org role used to be enough, which
    // told a plain org member the name and slug of teams `GET /teams/:id` refuses them.
    const adminOfOrg = named?.orgId
      ? orgRows.some((o) => o.orgId === named.orgId && orgIsAdmin(o.role))
      : false;
    const member = teams.has(opts.teamId);
    if (!named) {
      return { ok: false, reason: platformAdmin ? 'NOT_FOUND' : 'NO_STANDING' };
    }
    if (!(member || adminOfOrg || platformAdmin)) {
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

  const canWriteAnySetting = platformAdmin
    ? true
    : grantsReachAnySetting(
        { id: actor.id, role: actor.role as PlatformRole },
        await loadGrantRows(
          prisma,
          actor.id,
          teamRows.map((m) => m.team.id)
        ),
        new Map(teamRows.map((m) => [m.team.id, m.role as string]))
      );

  return {
    ok: true,
    value: {
      canWriteAnySetting,
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

/** See {@link effectivePermissionsUnscoped}; the caller's own memberships span tenants by definition. */
export function effectivePermissions(
  prisma: EffectivePermissionsDb,
  actor: Extract<Actor, { kind: 'user' }>,
  opts: { teamId?: string } = {}
): Promise<EffectiveResult> {
  return runUnscoped(
    "the effective-permissions view reads the caller's own memberships",
    ['Team', 'TeamMembership', 'OrganizationMembership', 'ConfigPermission'],
    () => effectivePermissionsUnscoped(prisma, actor, opts)
  );
}
