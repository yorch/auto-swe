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
  /** Run-callback endpoints — team LEAD or ADMIN, or platform ADMIN. */
  canManageCallbacks: boolean;
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
 *  - Run-callback endpoints require team LEAD (platform ADMIN bypasses).
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
    canManageCallbacks: platformAdmin || hasRole(teamRole, 'LEAD'),
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

/**
 * Whether the caller may write code that runs in a team's workspaces — shell
 * steps, a template's gate commands, a repository's gate commands — mirroring
 * the gateway's `isShellAuthor` on top of the platform LEAD every such route
 * requires: a platform ADMIN always; otherwise ADMIN membership on the owning
 * team. Code for no team (a GLOBAL template) is ADMIN-only.
 *
 * `adminTeamIds` is the set of teams the caller is an ADMIN of; `null` while
 * loading, which answers false.
 */
export function canAuthorTeamCode(
  platformRole: string | null | undefined,
  teamId: string | null | undefined,
  adminTeamIds: ReadonlySet<string> | null
): boolean {
  if (hasRole(platformRole, 'ADMIN')) {
    return true;
  }
  if (!hasRole(platformRole, 'LEAD') || !teamId || !adminTeamIds) {
    return false;
  }
  return adminTeamIds.has(teamId);
}

/**
 * Whether the caller may manage a repository owned by `ownerTeamId` — edit, share, test access,
 * deactivate. The gateway's `canManageTeamRepos`: the owning team's LEAD/ADMIN, or a platform
 * ADMIN. A team the repository is only shared with confers nothing.
 */
export const canManageTeamRepos = canWriteTeamResource;

/** Why a repository control is unavailable; names the owner, which is not the caller's team. */
export function repoManageReason(ownerTeamName: string | null | undefined, action: string): string {
  return `Only leads of ${ownerTeamName ?? 'the owning team'} or an administrator can ${action} this repository.`;
}

/** Why a run control is unavailable: the owning team's members and the launcher may use it. */
export function runControlReason(ownerTeamName: string | null | undefined, action: string): string {
  return `Only members of ${ownerTeamName ?? 'the owning team'} or the launcher can ${action} this run.`;
}

/**
 * Whether the caller may read and set a team's own monthly budget: the team's ADMIN, an ORG_ADMIN
 * of the team's organization, or a platform ADMIN. The platform LEAD role confers nothing here,
 * and a team LEAD (below team ADMIN) is not enough: the dollar figures are an admin's to see.
 */
export function canManageTeamBudget(
  platformRole: string | null | undefined,
  teamRole: string | null | undefined,
  isOrgAdmin: boolean
): boolean {
  return hasRole(platformRole, 'ADMIN') || hasRole(teamRole, 'ADMIN') || isOrgAdmin;
}
