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

/**
 * Repositories (`Connection` rows) the actor may reach.
 *
 * This is the one function the GitHub permission gate extends, which is the
 * whole point of routing every repo-reachability question through it: team
 * membership and real GitHub access have to be checked together or the weaker
 * of the two wins somewhere.
 */
export function reachableConnections(actor: ScopeActor): Prisma.ConnectionWhereInput {
  return { team: memberTeams(actor) };
}
