# Team role UX restructure — decision log

## D1 — 2026-11-14 — Task 1: Team-scoped team routes use the team role alone

**Status**: Accepted
**Decision**: The route-walk test exempts exactly two routes from the "no platform floor above ENGINEER" rule: `PUT /api/v1/teams/:id/shell-image-allowlist` and `PUT /api/v1/teams/:id/egress-allowlist`.
**Reason**: Sandbox policy is platform ADMIN only by design, and the team check on those routes is redundant because a platform ADMIN bypasses it. The spec puts platform ADMIN semantics out of scope.
**Alternatives considered**: Exempting every `requiredRole: 'ADMIN'` route was rejected, because a new ADMIN-plus-team route would then pass without a conscious decision.

## D2 — 2026-11-14 — Task 1: A superseded test was replaced

**Status**: Accepted
**Decision**: In `servicePrincipals.test.ts`, the case "not a platform ENGINEER, whatever their team role" was replaced by two cases: a platform ENGINEER who leads the team is allowed, and a platform LEAD who is only a team ENGINEER is refused.
**Reason**: The old case asserted the platform-and-team conjunction that the approved spec removes. It was factually obsolete, not weakened to get green.
**Alternatives considered**: None. Keeping it would contradict acceptance criterion 1.

## D3 — 2026-11-14 — Task 1: A team LEAD may invite users

**Status**: Accepted
**Decision**: `POST /api/v1/teams/:id/members/invite` is open to any team LEAD, including one whose platform role is ENGINEER. The invite path still decides approval: an organization with `trustedInvites` on creates an active account, any other creates an inactive one.
**Reason**: The spec makes the team role the authority for team management, and inviting a member is member management. Both reviewers flagged this as the one place the change lets a team lead create identities without a platform LEAD or ADMIN.
**Alternatives considered**: Keeping a platform floor on the invite route alone was rejected, because it would bring back the two-axis surprise for the one action a lead most often needs. The upgrade note (Task 19) must name this widening.
