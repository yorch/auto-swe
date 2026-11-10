/**
 * Who belongs to a repository: members of its owning team, or of any team it
 * has been shared with (`ConnectionTeamShare`).
 *
 * One definition, because the question is asked in many places — listings, the
 * launch decision, the credential resolver, the permission sweep — and a place
 * that counted only the owning team would quietly leave shared-team members
 * unable to do there what they can do everywhere else. Management is a
 * different question (owning team only) and is not answered here.
 */
import type { Prisma } from '../index.js';

/** The membership rows a repository's owning team and shared teams carry. */
export interface RepoMembers<M> {
  team: { memberships: M[] };
  shares: Array<{ team: { memberships: M[] } }>;
}

/**
 * A Prisma `select` for the owning-team and shared-team memberships matching
 * `where` — pass `{ userId }` to ask about one user.
 */
export function repoMembersSelect<S extends Prisma.TeamMembershipSelect>(
  select: S,
  where?: Prisma.TeamMembershipWhereInput
) {
  const memberships = { select, ...(where ? { where } : {}) };
  return {
    shares: { select: { canLaunch: true, team: { select: { memberships } } } },
    team: { select: { memberships } },
  } as const;
}

/** Every membership row on the repository, owning team first. */
export function allRepoMemberships<M>(repo: RepoMembers<M>): M[] {
  return [...repo.team.memberships, ...repo.shares.flatMap((s) => s.team.memberships)];
}

/** Whether `userId` is a member of the owning team or a shared team. */
export function isRepoMember(repo: RepoMembers<{ userId: string }>, userId: string): boolean {
  return allRepoMemberships(repo).some((m) => m.userId === userId);
}

/**
 * A `Connection` predicate: repositories where some membership of the owning
 * team, or of a team they are shared with, matches `membership`.
 */
export function repoMemberWhere(
  membership: Prisma.TeamMembershipWhereInput
): Prisma.ConnectionWhereInput {
  return {
    OR: [
      { team: { memberships: { some: membership } } },
      { shares: { some: { team: { memberships: { some: membership } } } } },
    ],
  };
}

/**
 * May `userId` START work on the repository? A member of the owning team always may; a member of a
 * shared team only when that share is not view-only (`ConnectionTeamShare.canLaunch`). Seeing it is
 * {@link isRepoMember}, which a view-only share still satisfies.
 *
 * `canLaunch` is read as `!== false`, so a row loaded without the column behaves as the column's
 * default; production selects carry it (`repoMembersSelect`) and the type requires it.
 */
export function mayLaunchOnRepo(
  repo: {
    team: { memberships: Array<{ userId: string }> };
    shares: Array<{ canLaunch: boolean; team: { memberships: Array<{ userId: string }> } }>;
  },
  userId: string
): boolean {
  return (
    repo.team.memberships.some((m) => m.userId === userId) ||
    repo.shares.some(
      (s) => s.canLaunch !== false && s.team.memberships.some((m) => m.userId === userId)
    )
  );
}

/** The teams a repository belongs to: its owning team and every team it is shared with. */
export interface RepoTeams {
  teamId: string;
  shares: Array<{ teamId: string }>;
}

/**
 * Whether `teamId` owns the repository or has it shared with it — the team-level form of
 * {@link isRepoMember}, for a caller that is a team rather than a person (a service principal).
 */
export function isRepoTeam(repo: RepoTeams, teamId: string): boolean {
  return repo.teamId === teamId || repo.shares.some((s) => s.teamId === teamId);
}

/**
 * Whether a template may reference a connection.
 *
 * A team's template may reference only a connection that team owns or has had shared
 * with it. A global template has no team — only an ADMIN may author one
 * (`routes/workflowTemplates.ts` refuses everyone else) — and may reference any
 * connection. (An agent's `mcpConnectionId` is checked against a team instead —
 * `agentMayUseConnection` in the worker — because the Agent row, not the template's author,
 * chose it, and a GLOBAL Agent row applies to every team's runs.)
 *
 * A reference is a literal id written into the spec, so unlike a payload binding it
 * is fully known when the spec is saved; but the authority that matters is the one
 * the *run* is made under, so the check is made where the connection is used.
 */
export function templateReachesConnection(
  connection: RepoTeams,
  templateTeamId: string | null
): boolean {
  return templateTeamId === null || isRepoTeam(connection, templateTeamId);
}

/**
 * Whether `teamId` may START work on the repository: it owns it, or has it shared without the
 * view-only flag. The team-level form of {@link mayLaunchOnRepo}, for a service principal.
 */
export function canTeamLaunchOnRepo(
  repo: { teamId: string; shares: Array<{ teamId: string; canLaunch: boolean }> },
  teamId: string
): boolean {
  return (
    repo.teamId === teamId || repo.shares.some((s) => s.teamId === teamId && s.canLaunch !== false)
  );
}

/** A connection as {@link teamMayUseConnection} reads it. */
export interface UsableConnection {
  teamId: string;
  /** Only a git repository can be shared view-only; any other type is used or not at all. */
  type?: string;
  shares: Array<{ teamId: string; canLaunch?: boolean }>;
}

/**
 * Whether a TEAM may hand a run a connection it names as a secondary one (a declared input, a
 * step's `connectionRef`): the team owns it or has it shared. For a git repository a view-only
 * share does not count, as it does not for starting work on it ({@link canTeamLaunchOnRepo}) — a
 * run using the repository's credential is the owner's token and budget at work, whichever
 * field names it. `canLaunch` absent reads as the column's default, true.
 */
export function teamMayUseConnection(connection: UsableConnection, teamId: string): boolean {
  if (connection.type !== 'git_repo') {
    return isRepoTeam(connection, teamId);
  }
  return canTeamLaunchOnRepo(
    {
      shares: connection.shares.map((s) => ({
        canLaunch: s.canLaunch !== false,
        teamId: s.teamId,
      })),
      teamId: connection.teamId,
    },
    teamId
  );
}

/** {@link templateReachesConnection} with the view-only rule of {@link teamMayUseConnection}. */
export function templateMayUseConnection(
  connection: UsableConnection,
  templateTeamId: string | null
): boolean {
  return templateTeamId === null || teamMayUseConnection(connection, templateTeamId);
}
