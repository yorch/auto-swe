import {
  CATALOG,
  type CapabilityKey,
  type EffectivePermissions,
  orgRuleApplies,
} from '@auto-swe/shared/permissions/client';
import { TEAM_ROLE_OPTIONS, type TeamRoleValue } from '@/lib/roleLabels';

/**
 * Reading `GET /api/v1/me/permissions`. Everything here only READS what the server decided: the
 * dashboard never derives an allow from a role. The server stays the authority on every request;
 * this decides which controls to show.
 *
 * An unknown state (not loaded yet, a key the server did not list, a team it did not describe) is
 * `false`. A control that is not shown costs a reload; one that is shown and refused costs trust.
 */

/** The wire shape of the answer, narrowed to the one thing a platform-admin check reads. */
export type Permissions = EffectivePermissions;

/**
 * A capability only a platform administrator holds (it has no team or organization role that
 * confers it), so holding it is what "platform admin" means in the browser. Both
 * `usePlatformAdmin` and the server-side page gate read it from the same answer.
 */
export const PLATFORM_ADMIN_PROBE: CapabilityKey = 'platform.users.manage';

/** Where a capability is asked. Neither id: "anywhere" (any team, any organization). */
export interface CapabilityScope {
  teamId?: string | null;
  orgId?: string | null;
}

type Held = { key: string }[];

function includesKey(held: Held | undefined, key: string): boolean {
  return held?.some((h) => h.key === key) ?? false;
}

/** Whether the answer says the caller is a platform administrator. */
export function isPlatformAdminAnswer(perms: Permissions | null | undefined): boolean {
  return perms?.platformCapabilities?.includes(PLATFORM_ADMIN_PROBE) ?? false;
}

/**
 * Whether an organization role can confer `key` at all, so a person with no membership on a team
 * can still hold it there. When it cannot, the team's own entry in the answer is the whole story
 * and no per-team request is needed.
 */
export function orgCanConfer(key: CapabilityKey): boolean {
  const def = CATALOG[key];
  return def !== undefined && orgRuleApplies(def);
}

/**
 * Whether the person could hold something on a team they are not a member of through an
 * organization: only if they belong to the team's organization (`orgId`, when it is known) or to
 * any organization (when it is not). Used to skip a per-team request that could only be refused.
 */
export function mayHoldViaOrg(
  perms: Permissions | null | undefined,
  orgId: string | null | undefined
): boolean {
  if (!perms) {
    return false;
  }
  return orgId
    ? (perms.organizations?.some((o) => o.orgId === orgId) ?? false)
    : (perms.organizations?.length ?? 0) > 0;
}

/** The capabilities the caller holds on one team, from a team entry or a narrowed answer. */
export function teamEntry(
  perms: Permissions | null | undefined,
  teamId: string
): Permissions['teams'][number] | undefined {
  return perms?.teams?.find((t) => t.teamId === teamId);
}

/**
 * Whether `perms` says the caller holds `key`. `narrowed` is the answer of
 * `?teamId=<scope.teamId>`, consulted for a team the caller has no membership in (their authority
 * there comes from the organization or the platform).
 *
 * - a platform administrator holds everything;
 * - a platform key is read from `platformCapabilities`;
 * - a team key with a team is read from that team's entry, else from the narrowed answer;
 * - an organization key with an organization is read from that organization's entry;
 * - with no id, a team or organization key means "on any team / in any organization".
 */
export function holdsCapability(
  perms: Permissions | null | undefined,
  key: CapabilityKey,
  scope: CapabilityScope = {},
  narrowed?: Permissions | null
): boolean {
  if (!perms) {
    return false;
  }
  if (isPlatformAdminAnswer(perms)) {
    return true;
  }
  if (key.startsWith('platform.')) {
    return perms.platformCapabilities?.includes(key) ?? false;
  }
  if (key.startsWith('org.')) {
    if (scope.orgId) {
      return includesKey(
        perms.organizations?.find((o) => o.orgId === scope.orgId)?.capabilities,
        key
      );
    }
    return perms.organizations?.some((o) => includesKey(o.capabilities, key)) ?? false;
  }
  if (scope.teamId) {
    const member = teamEntry(perms, scope.teamId);
    if (member && includesKey(member.capabilities, key)) {
      return true;
    }
    return includesKey(teamEntry(narrowed, scope.teamId)?.capabilities, key);
  }
  return perms.teams?.some((t) => includesKey(t.capabilities, key)) ?? false;
}

/** The ids of the teams the caller is a member of on which they hold `key`. */
export function teamIdsHolding(
  perms: Permissions | null | undefined,
  key: CapabilityKey
): string[] {
  if (!perms) {
    return [];
  }
  return (perms.teams ?? []).filter((t) => includesKey(t.capabilities, key)).map((t) => t.teamId);
}

/** The organizations in which the caller holds `key`. */
export function orgIdsHolding(perms: Permissions | null | undefined, key: CapabilityKey): string[] {
  if (!perms) {
    return [];
  }
  return (perms.organizations ?? [])
    .filter((o) => includesKey(o.capabilities, key))
    .map((o) => o.orgId);
}

/**
 * The team roles the caller may give on a team, lowest first, up to their effective rank: all of
 * them for authority held through the organization or the platform, the caller's own role and
 * below for authority held through a team role. Empty without `team.members.manage` there. The
 * server enforces the same rank rule; this only keeps the select from offering a refusal.
 */
export function grantableTeamRoles(
  perms: Permissions | null | undefined,
  teamId: string,
  narrowed?: Permissions | null
): TeamRoleValue[] {
  const all = TEAM_ROLE_OPTIONS.map((o) => o.value);
  if (!perms) {
    return [];
  }
  if (isPlatformAdminAnswer(perms)) {
    return all;
  }
  const entry = teamEntry(perms, teamId) ?? teamEntry(narrowed, teamId);
  const held = entry?.capabilities.find((c) => c.key === 'team.members.manage');
  if (!(entry && held)) {
    return [];
  }
  if (held.authority !== 'team-role') {
    return all;
  }
  // Authority through a team role, with no role in the answer: grant nothing rather than guess.
  if (!entry.role) {
    return [];
  }
  const own = all.indexOf(entry.role as TeamRoleValue);
  return own < 0 ? [] : all.slice(0, own + 1);
}

/**
 * What a page or navigation entry needs: any signed-in person (`'any'`, the API narrows what the
 * page shows), a platform administrator, or a capability of the catalog held anywhere.
 */
export type Access = 'any' | 'platform-admin' | CapabilityKey;

/** Whether `perms` meets `access`. Not loaded is `false` for everything but `'any'`. */
export function holdsAccess(perms: Permissions | null | undefined, access: Access): boolean {
  if (access === 'any') {
    return true;
  }
  if (access === 'platform-admin') {
    return isPlatformAdminAnswer(perms);
  }
  return holdsCapability(perms, access);
}
