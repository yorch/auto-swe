/**
 * The membership predicates that decide which tenants' rows a caller may read.
 *
 * These were written out by hand at every call site — thirteen files spelling
 * `{ team: { memberships: { some: { userId } } } }` and its relatives. That was
 * fine while "may this user reach this repo" had exactly one answer. It stops
 * being fine the moment the answer gains a second term, because a term added in
 * twelve places and missed in the thirteenth is a silent hole, and the thing it
 * would leak is the repository list.
 *
 * So there is one definition of each predicate here, and the call sites nest it
 * under the relation they reach tenancy through.
 *
 * **Nest these; do not spread them.** `{ team: memberTeams(user) }` is right,
 * `{ ...memberTeams(user) }` is wrong, and the reason is not style.
 * `tenantGuard.coverage.test.ts` reads this repository's source through the
 * TypeScript parser and grades each `where` with the guard's own
 * `hasTenantPredicate`. It renders a call expression as an opaque placeholder,
 * which still reads as narrowing under a tenant key — but it drops spreads
 * entirely, because `{ ...(filter.teamId && { teamId }) }` really is `{}` when
 * the caller passes nothing. A spread here would therefore turn a filtered call
 * site into an unaccounted one.
 *
 * The platform-ADMIN branch stays at the call sites. Folding it in would mean
 * returning `{}` for an admin, and `{ team: {} }` is not "any team" on a
 * nullable relation — it excludes the rows with no team at all, which is
 * exactly how the GLOBAL workflow templates would vanish from an admin's list.
 */
import type { Prisma } from '@auto-swe/shared';

/** The subset of an authenticated caller these predicates read. */
export interface ScopeActor {
  /** User UUID — `JwtPayload.sub`. */
  sub: string;
}

/** Teams the actor is a member of. Nest under a `team` relation key. */
export function memberTeams(actor: ScopeActor): Prisma.TeamWhereInput {
  return { memberships: { some: { userId: actor.sub } } };
}

/** Organizations the actor is a member of. Nest under an `organization` key. */
export function memberOrgs(actor: ScopeActor): Prisma.OrganizationWhereInput {
  return { memberships: { some: { userId: actor.sub } } };
}

/** Levels that let a user see a repository at all. */
const VIEWABLE = ['READ', 'WRITE', 'ADMIN'] as const;

/**
 * How the GitHub permission gate is configured, as far as a filter cares.
 *
 * Passed in rather than resolved here so these stay pure and synchronous —
 * they are called inside `where` literals, and an async predicate would make
 * every call site await mid-expression.
 */
export interface ConnectionScopeGate {
  mode: 'off' | 'advisory' | 'enforce';
  staleAfterHours: number;
}

/**
 * Repositories (`Connection` rows) the actor may reach.
 *
 * This is the one function the GitHub permission gate extends, which is the
 * whole point of routing every repo-reachability question through it: team
 * membership and real GitHub access have to be checked together or the weaker
 * of the two wins somewhere.
 *
 * The two conditions are ANDed, so a permission row can only ever take access
 * away. Nobody reaches a repository whose team they do not belong to, whatever
 * GitHub says.
 *
 * Only `enforce` changes the filter. Under `advisory` a listing is unchanged,
 * because reporting what it would have hidden means running it twice on every
 * page render; the launch path carries the advisory signal instead.
 *
 * The staleness bound matters as much as the permission value. Without it a
 * repository whose answers stopped refreshing — a revoked credential, a paused
 * sweep, an installation pointed at the wrong account — would be served from a
 * cache nobody is updating, indefinitely.
 */
export function reachableConnections(
  actor: ScopeActor,
  gate?: ConnectionScopeGate
): Prisma.ConnectionWhereInput {
  const team = memberTeams(actor);
  if (gate?.mode !== 'enforce') {
    return { team };
  }
  return {
    repoAccess: {
      some: {
        checkedAt: { gte: staleCutoff(gate.staleAfterHours) },
        permission: { in: [...VIEWABLE] },
        userId: actor.sub,
      },
    },
    team,
  };
}

/** The oldest `checkedAt` a cached answer may carry and still count. */
export function staleCutoff(staleAfterHours: number): Date {
  return new Date(Date.now() - staleAfterHours * 60 * 60 * 1000);
}
