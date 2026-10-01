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
    shares: { select: { team: { select: { memberships } } } },
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
