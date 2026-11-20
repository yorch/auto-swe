/**
 * The part of the permissions module a browser bundle may import.
 *
 * The main entry (`./index.ts`) also exports the database loader and the effective-permissions
 * builder, which import the tenant guard, which uses Node's `AsyncLocalStorage`
 * (`node:async_hooks`). A client component that imports the main entry pulls that into the browser
 * bundle and `next build` fails ("does not support external modules"). Nothing here imports the
 * database client or a `node:` module; `client.test.ts` walks this file's imports to keep it so.
 */
export { orgRuleApplies, platformAdminHolds, requiresActiveTeam } from './can.js';
export { CATALOG, type CapabilityKey, isCapabilityKey } from './catalog/index.js';
export type {
  EffectiveOrganization,
  EffectivePermissions,
  EffectiveRefusal,
  EffectiveResult,
  EffectiveTeam,
  HeldCapability,
} from './effective.js';
export {
  ORG_ROLES,
  type OrgRoleValue,
  PLATFORM_ROLES,
  type PlatformRoleValue,
  TEAM_ROLES,
  type TeamRoleValue,
} from './roles.js';
export {
  isPlatformAdminRole,
  orgIsAdmin,
  orgRankMeets,
  orgRankOf,
  TEAM_ROLE_RANK,
  teamRankMeets,
  teamRankOf,
} from './standing.js';
export type {
  Actor,
  Authority,
  CapabilityClass,
  CapabilityDef,
  CapabilityScope,
  Decision,
} from './types.js';
