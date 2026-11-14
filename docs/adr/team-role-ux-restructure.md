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

## D6 — 2026-11-14 — Task 4: Template routes, and a team-lead gate on the generation poll

**Status**: Accepted
**Decision**: All 15 template routes that asked for platform LEAD now ask for ENGINEER (the plan said 21; 15 is the count). Eleven already decide in the handler by `templateWriteFilter`, `findTemplateAuthorMembership` or `resolveTemplateAuthScope`: create, validate, patch, refine, review, add version, promote, regenerate and delete webhook, the three signing-secret routes, and both generate routes. `GET /generate/jobs/:jobId` had no team check, so it gains one: a non-ADMIN caller must lead (LEAD or ADMIN) at least one active team, else 403 with the same refusal body as authoring.
**Reason**: The poll was guarded only by the platform floor, so dropping the floor alone would have let any signed-in user read a generated workflow by job id. The job records its creator (`createdById`) but the status call does not return it, so an ownership check is not available without a Temporal change.
**Alternatives considered**: Keeping the platform floor on the poll was rejected: a team lead with platform role ENGINEER could start a job and never read its result. Binding the job to its creator is the stronger fix and is left open.

**Hardened after the Task 4 security review:** the poll route also read the result of any Temporal workflow id the caller typed, so the job id param must now match `wfauthorjob-<32 hex>` (anything else is a 400), and `getWorkflowAuthorJobStatus` returns only `templateId`, `name`, `summary` and `attempts`. `POST /validate` with no team and no template, which runs cross-team agent and connection lookups, now needs the caller to lead an active team (403 otherwise); an ADMIN is exempt. Creator binding of the job (a Temporal memo compared with the caller on poll) is the open follow-up. Running LLM generation and refine now needs only a team LEAD: no per-route rate limit exists, and the exposure is bounded to team leads.

**Superseded tests (Task 4):** `workflowTemplates.signing.test.ts` "needs platform LEAD, like the token routes" and `workflowTemplates.validate.test.ts` "refuses an ENGINEER with 403" asserted the platform floor this task removes. They were replaced by cases that assert what now decides: the template write filter for the signing routes, and the team membership lookup for validate (a team lead may validate, a caller who leads no team is refused with 403, and a caller naming no team is judged as a global author).

## D7 — 2026-11-14 — Task 20: The user lookup is open to any team lead

**Status**: Accepted
**Decision**: `GET /api/v1/users/lookup` asks the platform role for ENGINEER. A non-ADMIN caller must hold LEAD or ADMIN membership of at least one active team, else 403. The rate limit (30 per minute per caller) and the response (`id`, `email`, `name`, no role) are unchanged. The user chose this over keeping the platform LEAD floor.
**Reason**: The add-member picker is for team leads. With the platform floor kept, a team lead whose platform role is ENGINEER could invite by email but not use the picker. The membership requirement keeps the endpoint away from people who lead no team.
**Alternatives considered**: Keeping the platform LEAD floor, and deferring. Any team lead of any team can now test whether an email belongs to an active user, rate-limited. That is the same exposure a platform LEAD had, and the invite flow already confirms an address once it is used.

## D8 — 2026-11-14 — Task 21: The Slack approve button needs LEAD on the run's owning team

**Status**: Accepted
**Decision**: The `approve_` action in `routes/slack/interactive.ts` no longer checks the platform role. A platform ADMIN passes. Anyone else must hold LEAD or ADMIN membership of an active team that owns the run (the team of its repository, of its work request's repository, or of its template). The check runs after the run-control lookup, so a refusal reveals nothing about a run the clicker cannot see. `retry_ci_` and the HITL buttons keep their checks. The user chose to include this.
**Reason**: Approving is a team-scoped action, and the platform LEAD check was the one place the Slack path still followed the old rule while the web path followed the team rule.
**Alternatives considered**: Deferring, which the user declined. Keeping the platform role as an extra requirement was rejected, because it would bring back the two-axis surprise for the Slack button.

**Accepted residuals (Tasks 20 and 21 reviews):**
- Lookup rate limit (D7): the route uses the global `rateLimitKey`, which keys a session or JWT caller by user and a personal-access-token caller by IP. A PAT caller therefore shares an IP bucket. This is how every route is limited and a platform LEAD had the same limit, so it is not changed here. Lookup rights spread by delegation only: an ordinary ENGINEER cannot create a team, so cannot grant themselves the right. Tighten with a minimum team size or a per-user limiter inside the handler if this becomes a concern.
- Slack approval (D8): the owning teams are exactly the run's repository team, its work request's repository team and its template team, which is narrower than every team that may control the run. A run controlled only through its launcher, a service principal's team, or a multi-repository `activeWorkflows` repository has no owning team, so only a platform ADMIN can approve it from Slack. A user who launched a run but leads no owning team, and a platform LEAD who is only a team ENGINEER, can no longer approve from Slack. The upgrade note (Task 19) names this.

## D9 — 2026-11-14 — Task 22: Two in-handler platform checks that no route-floor search finds

**Status**: Accepted
**Decision**: `scopeFor` in `routes/codeReview.ts` no longer requires platform LEAD before it checks the team membership for a write, and the `canManage` flag of a template webhook in `routes/automations.ts` no longer ANDs in the platform role. Both follow the team role, as the routes they describe now do.
**Reason**: The route-floor searches in Tasks 1 to 4 looked for `requiredRole`. These two used `roleMeets(user.role, 'LEAD')` inside the handler, so the web would have shown a team lead enabled controls the server then refused, or hidden controls the server allows. A search for `roleMeets(`, `hasRole(` and `role ===` over `routes`, `lib` and `plugins` now finds no other platform-LEAD check on a team-scoped action. The remaining hits are team-membership checks, the organization-scoped error baselines (D5), and the platform-wide pages.
**Alternatives considered**: None. Leaving them would reintroduce the two-axis surprise.

