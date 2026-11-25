/**
 * How the three role vocabularies read in the dashboard. A role is a name for a person's standing
 * on one level (the platform, a team, an organization); what a person may DO is decided by the
 * server and read through `useCan`, never from these values. This is the only place the role
 * values are spelled out, together with the grant and member role selects that offer them.
 *
 * An unknown value (a historical audit row, a role a newer gateway added) reads as itself.
 */

const PLATFORM_ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Platform admin',
  USER: 'User',
};

const TEAM_ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Team admin',
  LEAD: 'Team lead',
  MEMBER: 'Team member',
};

const ORG_ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Org admin',
  MEMBER: 'Org member',
};

export function platformRoleLabel(role: string | null | undefined): string {
  return role ? (PLATFORM_ROLE_LABELS[role] ?? role) : '';
}

export function teamRoleLabel(role: string | null | undefined): string {
  return role ? (TEAM_ROLE_LABELS[role] ?? role) : '';
}

export function orgRoleLabel(role: string | null | undefined): string {
  return role ? (ORG_ROLE_LABELS[role] ?? role) : '';
}

/** Who may launch work that spans repositories (epics, PRD runs), as one phrase for notices. */
export const MULTI_REPO_LAUNCHERS =
  'a lead or admin of the team that owns the repositories, or a platform admin';

/** Who manages a repository: the owning team's leads and admins, the org's admins, platform admins. */
export function repoManagersPhrase(ownerTeamName: string | null | undefined): string {
  return `team leads and admins of ${ownerTeamName ?? 'the owning team'}, an admin of its organization or a platform admin`;
}

/** The platform roles a person can be given, lowest first. */
export const PLATFORM_ROLE_OPTIONS = [
  { label: PLATFORM_ROLE_LABELS.USER, value: 'USER' },
  { label: PLATFORM_ROLE_LABELS.ADMIN, value: 'ADMIN' },
] as const;

/** The team roles in rank order, lowest first; the grantable subset is decided by the server. */
export const TEAM_ROLE_OPTIONS = [
  { label: TEAM_ROLE_LABELS.MEMBER, value: 'MEMBER' },
  { label: TEAM_ROLE_LABELS.LEAD, value: 'LEAD' },
  { label: TEAM_ROLE_LABELS.ADMIN, value: 'ADMIN' },
] as const;

/** The organization roles, lowest first. */
export const ORG_ROLE_OPTIONS = [
  { label: ORG_ROLE_LABELS.MEMBER, value: 'MEMBER' },
  { label: ORG_ROLE_LABELS.ADMIN, value: 'ADMIN' },
] as const;

export type PlatformRoleValue = (typeof PLATFORM_ROLE_OPTIONS)[number]['value'];
export type TeamRoleValue = (typeof TEAM_ROLE_OPTIONS)[number]['value'];
export type OrgRoleValue = (typeof ORG_ROLE_OPTIONS)[number]['value'];

/** The role a new member, invitee or created user starts with. */
export const DEFAULT_TEAM_ROLE: TeamRoleValue = 'MEMBER';
export const DEFAULT_ORG_ROLE: OrgRoleValue = 'MEMBER';
export const DEFAULT_PLATFORM_ROLE: PlatformRoleValue = 'USER';

/** Who may write a setting: `'admin'` is platform admins only, `'grantable'` also a covering grant. */
export type WriteAccess = 'admin' | 'grantable';

export function writeAccessLabel(access: WriteAccess): string {
  return access === 'admin' ? 'platform admin' : 'platform admin or a grant';
}

/** The team role a new settings grant starts with. */
export const DEFAULT_GRANT_ROLE: TeamRoleValue = 'LEAD';

/** Position of a team role in rank order, lowest first; -1 for a role not offered. */
export function teamRoleRank(role: string): number {
  return TEAM_ROLE_OPTIONS.findIndex((o) => o.value === role);
}

const TEAM_ROLE_CONSEQUENCES: Record<string, string> = {
  ADMIN: 'able to manage everything a lead can, plus the team agent library, secrets and plugins',
  LEAD: 'able to manage its members, persona and callback endpoints',
};

/** What a team role adds over a member, for the confirmation before promoting someone. */
export function teamRoleConsequence(role: string): string {
  return TEAM_ROLE_CONSEQUENCES[role] ?? 'able to manage more of the team';
}

const PLATFORM_ROLE_CONSEQUENCES: Record<
  string,
  { confirmLabel: string; dangerous: boolean; effect: string }
> = {
  ADMIN: {
    confirmLabel: 'Make platform admin',
    dangerous: true,
    effect: 'every capability on every team, organization and platform setting',
  },
  USER: {
    confirmLabel: 'Change role',
    dangerous: false,
    effect: 'only what their team and organization roles grant',
  },
};

/** What a platform role means and how its confirmation reads, for the change-role dialog. */
export function platformRoleConsequence(role: string): {
  confirmLabel: string;
  dangerous: boolean;
  effect: string;
} {
  return (
    PLATFORM_ROLE_CONSEQUENCES[role] ?? {
      confirmLabel: 'Change role',
      dangerous: false,
      effect: 'a different level of access',
    }
  );
}

/** Position of an organization role in rank order, lowest first; -1 for a role not offered. */
export function orgRoleRank(role: string): number {
  return ORG_ROLE_OPTIONS.findIndex((o) => o.value === role);
}
