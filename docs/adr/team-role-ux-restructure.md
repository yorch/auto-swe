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

## D4 — 2026-11-14 — Task 2: The launchers keep their handler checks and lose only the platform floor

**Status**: Accepted
**Decision**: `POST /epics`, `POST /prd-runs` and `POST /campaigns` change `requiredRole` from LEAD to ENGINEER and nothing else. Each handler already requires LEAD or ADMIN on the team that owns every repository (`requireOwningTeamLead`, `LEAD_ROLES`). The campaigns case "refuses an ENGINEER" was reworded to "refuses a platform ENGINEER who is only an ENGINEER on the owning team", because the old wording asserted the platform floor this task removes.
**Reason**: The handler check is the real authority. The platform floor only added a second qualification, so a team lead with the platform ENGINEER role was refused before the handler ran.
**Alternatives considered**: Adding a new owning-team check in the route was rejected: the handlers already enforce it, and a second copy could drift.

**Accepted residual (Task 2 security review, low):** any signed-in caller can now reach the repository-existence lookup of the three launch routes, so a `404` against a `403` tells them whether a UUID they hold names an active repository or team. The 404 body echoes only the ids the caller sent. Ids are random UUIDs, and the existence signal was already a deliberate choice in these handlers. `docs/campaigns.md` states it.

## D5 — 2026-11-14 — Task 3: The floor inventory missed `Role.LEAD`, and organization-scoped routes stay

**Status**: Accepted
**Decision**: Task 3 also lowers three `requiredRole: Role.LEAD` gates in `routes/repositories.ts` (`test-pagerduty`, `test-pagerduty-events`, `onboarding-runs`) and removes the platform check in `lib/repoOnboardingLaunch.ts`. The earlier inventory grepped for the string `'LEAD'` and missed this spelling. Each of these handlers already calls `canManageTeamRepos`, and onboarding also needs `isShellAuthor` (team ADMIN). The three `Role.LEAD` gates in `routes/humanErrorBaselines.ts` are left alone: they decide by organization membership, and organization roles are out of scope. In `repositoryOnboardingRuns.test.ts` the case "requires authentication and LEAD role" was narrowed to authentication, because its platform-ENGINEER half asserted the removed floor.
**Reason**: The team role is the authority wherever a handler reads a team membership. A route that reads an organization membership is a different axis.
**Alternatives considered**: Lowering the baseline routes too was rejected as a change to organization semantics the spec does not cover.

**Accepted residuals (Task 3 security review, low):** with the platform floor gone, any signed-in caller who already holds a UUID can tell from `404` against `403` or `400` whether a connection exists, what type it has, whether two repositories share an organization, and whether an edge exists. The same holds for onboarding. No response returns data, and the UUIDs are random. Same residual as D4. `canManageTeamRepos` also admits an ORG_ADMIN of the owning organization, so a platform ENGINEER who is an ORG_ADMIN now passes the PagerDuty test and dependency routes (onboarding still needs team ADMIN or platform ADMIN through `isShellAuthor`). The upgrade note (Task 19) names both.

**Open items for the user (found by the Task 3 review, not in the spec):**
- `GET /api/v1/users/lookup` (`routes/users.ts`) keeps `requiredRole: LEAD`. It is the exact-email lookup behind the team and organization "add member" pickers and a rate-limited enumeration oracle. A team lead with platform role ENGINEER can invite by email but cannot use the picker. Lowering it means choosing who may enumerate users (any team lead of any team?).
- `routes/slack/interactive.ts:220` gates approving a workflow from Slack with `hasRole(user.role, 'LEAD')`, a platform check on what is a team-scoped action.
