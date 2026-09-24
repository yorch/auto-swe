import type { Role } from '@auto-swe/shared';
import { hasRole, isRole } from '@/lib/roles';

const ROLES_LOW_TO_HIGH: Role[] = ['ENGINEER', 'LEAD', 'ADMIN'];

export interface TeamPermissions {
  /** Edit the team, its persona, and add / re-role / remove members. */
  canManageMembers: boolean;
  /** Team roles the caller may grant — never above their own. */
  grantableRoles: Role[];
  /** PUT shell-image and egress allowlists — platform ADMIN only. */
  canEditAllowlists: boolean;
  /** The team-owner agent library — team ADMIN, or platform ADMIN. */
  canManageTeamAgents: boolean;
}

/**
 * What the team detail page may offer, mirroring the gateway's team routes:
 *
 *  - Member ops and team edits are `requiredRole: 'LEAD', requiredTeamRole: 'LEAD'`
 *    — a platform LEAD must also lead *this* team; platform ADMIN bypasses the
 *    team check.
 *  - A grant above the actor's own role is refused (`PRIVILEGE_ESCALATION`);
 *    the actor's role is their team role, or ADMIN for a platform ADMIN.
 *  - The allowlist PUTs require platform ADMIN.
 *  - The team agent library requires team ADMIN (platform ADMIN bypasses).
 */
export function teamPermissions(
  platformRole: string | null | undefined,
  teamRole: string | null | undefined
): TeamPermissions {
  const platformAdmin = hasRole(platformRole, 'ADMIN');
  const canManageMembers =
    platformAdmin || (hasRole(platformRole, 'LEAD') && hasRole(teamRole, 'LEAD'));
  const actorRole: Role | null = platformAdmin ? 'ADMIN' : isRole(teamRole) ? teamRole : null;
  const grantableRoles =
    canManageMembers && actorRole ? ROLES_LOW_TO_HIGH.filter((r) => hasRole(actorRole, r)) : [];
  return {
    canEditAllowlists: platformAdmin,
    canManageMembers,
    canManageTeamAgents: platformAdmin || hasRole(teamRole, 'ADMIN'),
    grantableRoles,
  };
}

/**
 * Whether the caller may write a team-owned resource — a workflow template or
 * a connection — mirroring the gateway's `templateWriteFilter` and
 * `canManageTeamRepos`: a platform ADMIN always; otherwise platform LEAD
 * *and* LEAD/ADMIN membership on the owning (active) team. A resource with no
 * team (a GLOBAL template) is ADMIN-only.
 *
 * `ledTeamIds` is the set of active teams the caller leads; `null` while it is
 * still loading, which answers false rather than flashing controls that 403.
 */
export function canWriteTeamResource(
  platformRole: string | null | undefined,
  teamId: string | null | undefined,
  ledTeamIds: ReadonlySet<string> | null
): boolean {
  if (hasRole(platformRole, 'ADMIN')) {
    return true;
  }
  if (!hasRole(platformRole, 'LEAD') || !teamId || !ledTeamIds) {
    return false;
  }
  return ledTeamIds.has(teamId);
}
