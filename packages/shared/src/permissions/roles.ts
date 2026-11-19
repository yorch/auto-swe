/**
 * The values of the three stored role enums, as `as const` tuples for zod enums and request
 * validation. Callers build schemas from these instead of spelling role literals, so a rename
 * edits this file and the Prisma schema alone.
 *
 * These mirror the Prisma enums `PlatformRole`, `TeamRole` and `OrgRole`; `roles.test.ts` fails if
 * they drift.
 */

/** `users.role`: a person's standing on the platform. */
export const PLATFORM_ROLES = ['ADMIN', 'USER'] as const;

/** `team_memberships.role` and a TEAM-scope settings grant's role grantee, highest first. */
export const TEAM_ROLES = ['ADMIN', 'LEAD', 'MEMBER'] as const;

/** `organization_memberships.role`. */
export const ORG_ROLES = ['ADMIN', 'MEMBER'] as const;

export type PlatformRoleValue = (typeof PLATFORM_ROLES)[number];
export type TeamRoleValue = (typeof TEAM_ROLES)[number];
export type OrgRoleValue = (typeof ORG_ROLES)[number];
