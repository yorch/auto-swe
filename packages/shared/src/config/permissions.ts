import type { Role } from '../generated/prisma/enums.js';
import { isPlatformAdmin } from '../permissions/standing.js';
import { getSettingDefinition, isSettingKey, type SettingKey } from './registry.js';
import type { SettingScope } from './types.js';

/**
 * Who may change which settings, and where.
 *
 *   - A definition with `writeAccess: 'admin'` is writable by a platform admin
 *     only; no grant reaches it.
 *   - A definition with `writeAccess: 'grantable'` is writable by a platform
 *     admin or by an actor a grant covers. Grants are rows, not code, so
 *     widening who configures what is an admin action.
 *
 * A grant's grantee is a user, or a team role. A role grant is matched against
 * the actor's role in the grant's own team, never against a platform role.
 *
 * Platform admins bypass grants entirely: they can already write every
 * singleton config table, so requiring them to grant themselves access would be
 * ceremony that teaches operators to ignore the model.
 */

/// Matches a stored grant pattern against a setting key. Three forms, and no
/// others — `*` for everything, `group.*` for one subsystem, or an exact key.
/// Deliberately not a glob library: an operator reading a grant should be able
/// to tell what it covers without learning a matching syntax.
export function keyPatternMatches(pattern: string, key: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('.*')) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return pattern === key;
}

/// A grant as the checker needs to see it. The grantee is `userId` XOR `role`;
/// a role grant is only valid with `scope = 'TEAM'` and a `teamId`, and names
/// the role a member must hold in that team.
export interface ConfigGrant {
  keyPattern: string;
  userId: string | null;
  role: Role | null;
  scope: SettingScope;
  teamId: string | null;
  orgId: string | null;
}

/// The write being attempted, already resolved to the tenant it lands in.
/// `targetTeamId` / `targetOrgId` are the owning team and org of whatever the
/// override attaches to — for a CHANNEL override that is the channel's team and
/// org, not nulls — so a TEAM-scoped grant correctly covers a channel inside it.
export interface SettingWriteTarget {
  key: string;
  scope: SettingScope;
  targetTeamId?: string;
  targetOrgId?: string;
}

export interface ConfigActor {
  id: string;
  role: Role;
}

/// The actor's role in each team they belong to, keyed by team id.
export type ActorTeamRoles = ReadonlyMap<string, string>;

/// Does one grant authorise this write?
function grantCovers(
  grant: ConfigGrant,
  actor: ConfigActor,
  target: SettingWriteTarget,
  actorTeamRoles: ActorTeamRoles
): boolean {
  if (!keyPatternMatches(grant.keyPattern, target.key)) {
    return false;
  }
  if (grant.userId) {
    if (grant.userId !== actor.id) {
      return false;
    }
  } else {
    // A role grant means "holders of this role in the grant's team", so it has
    // no meaning outside a TEAM-scoped grant.
    if (!grant.role || grant.scope !== 'TEAM' || !grant.teamId) {
      return false;
    }
    if (actorTeamRoles.get(grant.teamId) !== grant.role) {
      return false;
    }
  }

  switch (grant.scope) {
    // Authority over the whole deployment covers any write.
    case 'GLOBAL':
      return true;
    // Authority over an org covers anything inside it, but never the GLOBAL
    // row — that is shared with every other tenant.
    case 'ORGANIZATION':
      return target.scope !== 'GLOBAL' && !!grant.orgId && grant.orgId === target.targetOrgId;
    // Authority over a team covers that team and the channels and templates
    // beneath it.
    case 'TEAM':
      return (
        target.scope !== 'GLOBAL' &&
        target.scope !== 'ORGANIZATION' &&
        !!grant.teamId &&
        grant.teamId === target.targetTeamId
      );
    default:
      return false;
  }
}

export type WriteDenial =
  | { allowed: true }
  | {
      allowed: false;
      code: 'UNKNOWN_SETTING' | 'SCOPE_NOT_ALLOWED' | 'ROLE_TOO_LOW' | 'NO_GRANT';
      message: string;
    };

/// The single authorisation rule for a settings write. Returns a code the API
/// can turn into a response, rather than a bare boolean, so an operator who is
/// denied learns which of the three gates stopped them.
export function checkSettingWrite(
  actor: ConfigActor,
  target: SettingWriteTarget,
  grants: readonly ConfigGrant[],
  actorTeamRoles: ActorTeamRoles = new Map()
): WriteDenial {
  if (!isSettingKey(target.key)) {
    return {
      allowed: false,
      code: 'UNKNOWN_SETTING',
      message: `'${target.key}' is not a known setting.`,
    };
  }
  const definition = getSettingDefinition(target.key as SettingKey);

  if (target.scope !== 'GLOBAL' && !definition.overridableAt.includes(target.scope)) {
    const allowed = definition.overridableAt.length
      ? `GLOBAL, ${definition.overridableAt.join(', ')}`
      : 'GLOBAL only';
    return {
      allowed: false,
      code: 'SCOPE_NOT_ALLOWED',
      message: `'${target.key}' cannot be overridden at ${target.scope} scope (allowed: ${allowed}).`,
    };
  }

  if (isPlatformAdmin(actor)) {
    return { allowed: true };
  }

  if (definition.writeAccess === 'admin') {
    return {
      allowed: false,
      code: 'ROLE_TOO_LOW',
      message: `'${target.key}' can only be changed by a platform admin.`,
    };
  }

  if (grants.some((grant) => grantCovers(grant, actor, target, actorTeamRoles))) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'NO_GRANT',
    message: `No configuration grant covers '${target.key}' at ${target.scope} scope.`,
  };
}
