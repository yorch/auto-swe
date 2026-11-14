# Team lead and team member UX restructure — Implementation Plan

Spec: docs/specs/2026-11-14-team-role-ux-restructure.md
Workspace: worktree: .claude/worktrees/team-roles-ia-restructure
Jira: N/A

Run the tasks in order and one at a time. Each task is one commit. The role tasks (1 to 5) form a
group that reverts alone, as the spec requires. The same holds for the navigation group (6 to 7) and
for each feature group after it.

Conventions for every task:

- Run `yarn typecheck`, `yarn test` for the touched files, and `yarn biome check` on explicit
  directories (the worktree caveat in `CLAUDE.md` §5 applies; `yarn lint` checks zero files here).
- A task that adds a route also adds its entry to `packages/gateway/src/lib/assistantPolicy.ts`.
- A task that changes the schema reads the `prisma-pgvector-hnsw` skill first and hand-checks the
  generated migration for dropped HNSW or CHECK DDL.
- The first task that adds a `*.pg.test.ts` file also names it on a `yarn test` line of
  `.github/workflows/ci.yml`. Later tasks extend that file.

## Progress

- [x] Task 1: Team-scoped team routes use the team role alone — `8183c368`
- [x] Task 2: Launch routes (epics, PRD runs, campaigns) drop the platform LEAD floor — `3be051fb`
- [x] Task 3: Repository dependency and onboarding routes drop the platform LEAD floor — `edbbdfa5`
- [ ] Task 4: Workflow template routes drop the platform LEAD floor
- [ ] Task 5: Web permissions use the team role alone, with explained disabled controls
- [ ] Task 6: Move Analytics, Reports and LLM usage to `/insights/*` with redirects
- [ ] Task 7: Move Automations and the Teams directory, then reorder the sidebar
- [ ] Task 8: Team overview returns a `mine` block
- [ ] Task 9: "My work" card and Start work links on the team Overview
- [ ] Task 10: Manage tab with Repositories, Budget and Service principals
- [ ] Task 11: Manage tab Schedules and Automations sections
- [ ] Task 12: Unowned failures list and `FailureAssignment` storage
- [ ] Task 13: Assign a failure and show it on the assignee's desk
- [ ] Task 14: Nudge a stale approval
- [ ] Task 15: Budget change requests
- [ ] Task 16: Attention section: failures and assignment
- [ ] Task 17: Attention section: stale approvals and nudge
- [ ] Task 18: Budget request UI
- [ ] Task 19: Docs, upgrade note and full quality gates

## Tasks

### Task 1: Team-scoped team routes use the team role alone

**What**: In `routes/teams.ts` (five routes) and `routes/servicePrincipals.ts`, change
`requiredRole: 'LEAD', requiredTeamRole: 'LEAD'` to `requiredTeamRole: 'LEAD'` with no platform
floor above `ENGINEER`. Platform `ADMIN` keeps its bypass in `plugins/auth.ts`. The privilege
escalation check stays as it is. Add a route-walk test that reads the `RBAC_OPTIONS` symbol of every
registered route and fails when a route sets `requiredTeamRole` and a `requiredRole` above `ENGINEER`.
**Files**: `packages/gateway/src/routes/teams.ts`, `packages/gateway/src/routes/servicePrincipals.ts`,
`packages/gateway/src/routes/teams.test.ts`, `packages/gateway/src/routes/teamRoleFloor.test.ts` (new)
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/teams.test.ts packages/gateway/src/routes/teamRoleFloor.test.ts`.
A platform `ENGINEER` who leads team T edits T and adds a member (2xx). A platform `LEAD` who is only
an `ENGINEER` in T gets 403 `Requires LEAD role in this team`. A platform `ADMIN` outside T succeeds.
A grant above the caller's own role gets 403 `PRIVILEGE_ESCALATION`. The route-walk test passes.

### Task 2: Launch routes (epics, PRD runs, campaigns) drop the platform LEAD floor

**What**: In `routes/epics.ts` (`POST /`), `routes/prdRuns.ts` and `routes/campaigns.ts` (`POST /`),
lower `requiredRole` from `LEAD` to `ENGINEER`. These handlers already enforce owning-team `LEAD`
(`authorizeLaunch` with `requireOwningTeamLead`, and `LEAD_ROLES` in campaigns). Do not weaken those
checks. Add one matrix test that runs each route three ways, as described in Verify.
**Files**: `packages/gateway/src/routes/epics.ts`, `packages/gateway/src/routes/prdRuns.ts`,
`packages/gateway/src/routes/campaigns.ts`, `packages/gateway/src/routes/teamLeadLaunch.test.ts` (new)
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/teamLeadLaunch.test.ts`. For each route:
platform `ENGINEER` + owning-team `LEAD` is allowed past the role gate; platform `LEAD` +
owning-team `ENGINEER` gets 403; platform `ENGINEER` + owning-team `ENGINEER` gets 403. Existing
epic, PRD and campaign suites still pass.

### Task 3: Repository dependency and onboarding routes drop the platform LEAD floor

**What**: In `routes/repoDependencies.ts` (four routes) lower `requiredRole` to `ENGINEER`; each
handler already calls `canManageTeamRepos`. In `routes/repositories.ts` lower the three
`Role.LEAD` gates (`test-pagerduty`, `test-pagerduty-events`, `onboarding-runs`), which also call
`canManageTeamRepos`. In `lib/repoOnboardingLaunch.ts` remove the redundant platform check; the
existing `canManageTeamRepos` and `isShellAuthor` checks decide. Leave `routes/humanErrorBaselines.ts`:
it decides by organization membership (decision D5). Extend the matrix test pattern of Task 2.
**Files**: `packages/gateway/src/routes/repoDependencies.ts`, `packages/gateway/src/routes/repositories.ts`,
`packages/gateway/src/lib/repoOnboardingLaunch.ts`, `packages/gateway/src/routes/repoDependencies.test.ts`,
`packages/gateway/src/routes/connectionTestRoutes.test.ts`, `packages/gateway/src/routes/repositoryOnboardingRuns.test.ts`
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/repoDependencies.test.ts packages/gateway/src/routes/connectionTestRoutes.test.ts packages/gateway/src/routes/repositoryOnboardingRuns.test.ts`.
The same three cases as Task 2 hold for a manual edge and for onboarding. A manual edge still needs
`LEAD` on both teams.

### Task 4: Workflow template routes drop the platform LEAD floor

**What**: `routes/workflowTemplates.ts` has 21 routes with `requiredRole: 'LEAD'`. Classify each by
reading its handler. A route whose handler filters with `templateWriteFilter` (or an equivalent
owning-team `LEAD` check) drops to `ENGINEER`. A route with no such check keeps the floor, and the
commit message lists it. A GLOBAL template stays admin-only. Record the classification as a table in
the test file header.
**Files**: `packages/gateway/src/routes/workflowTemplates.ts`,
`packages/gateway/src/routes/workflowTemplates.test.ts`
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/workflowTemplates.test.ts`. For one
representative route per handler family: platform `ENGINEER` + team `LEAD` succeeds on a team
template; platform `LEAD` + team `ENGINEER` gets 404 or 403 as the route did for non-owners; any
caller who is not platform `ADMIN` is refused on a GLOBAL template.

### Task 5: Web permissions use the team role alone, with explained disabled controls

**What**: Remove the platform-`LEAD` conjunction from `teamPermissions()` and `canWriteTeamResource()`
(keep the platform `ADMIN` bypass). In `hooks/useTeams.ts` make `useTeamIdsWithRole` and its callers
look up led teams for any signed-in user, not only platform `LEAD`. In `StartWork.tsx` replace the
platform-`LEAD` test with led-team membership. A control that stays disabled for a missing team role
gets the title `Requires the LEAD role in this team` (or the role it needs). Reword
`CONTAINER_AUTHORING_RULE` in `components/workflow/containerNodes.ts`, which still says every save route
needs platform LEAD.
**Files**: `packages/web/src/lib/teamPermissions.ts`, `packages/web/src/hooks/useTeams.ts`,
`packages/web/src/components/workflow/containerNodes.ts`, `packages/web/src/components/requests/StartWork.tsx`,
`packages/web/src/components/teams/space/TeamMembersPanel.tsx`
**Depends on**: Task 1
**Verify**: `yarn vitest run packages/web/src/lib/teamPermissions.test.ts packages/web/src/components/teams`.
`teamPermissions('ENGINEER','LEAD')` returns `canManageMembers: true` and `grantableRoles` of
`['ENGINEER','LEAD']`. `teamPermissions('LEAD','ENGINEER')` returns `false` and `[]`. A disabled
control shows the title above.

### Task 6: Move Analytics, Reports and LLM usage to `/insights/*` with redirects

**What**: Move the three pages from `app/admin/{analytics,reports,usage}` to
`app/insights/{analytics,reports,usage}` with `git mv`. Each moved page keeps an equivalent role
guard (`RoleLayout`) because it leaves the admin layout. Add permanent redirects (308, query string
kept) from each old address in `next.config`. Update internal links and the page map entries in
`lib/navigation.ts`, `GovernanceGuide.tsx` and `lib/auditEntity.ts`. Keep `showsTeamSwitcher()` correct
for the new paths.
**Files**: `packages/web/src/app/admin/{analytics,reports,usage}/` → `packages/web/src/app/insights/`,
`packages/web/next.config.*`, `packages/web/src/lib/navigation.ts`,
`packages/web/src/components/setup/GovernanceGuide.tsx`
**Depends on**: none
**Verify**: `yarn workspace @auto-swe/web build` lists `/insights/analytics`, `/insights/reports`
and `/insights/usage`. A unit test of the redirect list asserts each old path maps to its new path.
`yarn vitest run packages/web/src/lib/navigation.test.ts` passes. `yarn docs:check` stays green.

### Task 7: Move Automations and the Teams directory, then reorder the sidebar

**What**: Move `app/admin/automations` to `app/automations` and the Teams list (`app/admin/teams/page.tsx`)
to `app/teams/page.tsx`. Leave `/admin/teams/[id]` where it is. Add 308 redirects for both old list
addresses. Then set the sidebar order to Home, My teams, All teams (the current Work group, renamed),
Teams and insights (Teams, Analytics, Reports, LLM usage, Automations), Build, Connect, Knowledge,
Admin. Hide the Admin entry when no Admin page remains visible to the caller. The command palette,
`tourSteps.ts` anchors and `detailParent()` read the same page map.
**Files**: `packages/web/src/app/automations/`, `packages/web/src/app/teams/page.tsx`,
`packages/web/src/lib/navigation.ts`, `packages/web/src/lib/tourSteps.ts`,
`packages/web/src/components/layout/Sidebar.tsx`
**Depends on**: Task 6
**Verify**: `yarn vitest run packages/web/src/lib/navigation.test.ts packages/web/src/components/layout`.
`visibleNavGroups('ENGINEER', false)` returns the group order above and no Admin entry. The palette
offers exactly the sidebar's pages. `yarn workspace @auto-swe/web build` succeeds.

### Task 8: Team overview returns a `mine` block

**What**: Extend `buildTeamOverview()` to add `mine: { running, failed, prsAwaitingMerge }` for every
viewer level. Reuse the desk's rules: a failure counts when the caller launched the latest attempt;
a pull request counts when the caller requested it and it awaits a human merge. Add the type to the
shared API types. Update the existing overview and desk tests to the new shape.
**Files**: `packages/gateway/src/lib/teamOverview.ts`, `packages/shared/src/types/api.ts`,
`packages/gateway/src/lib/teamOverview.test.ts`, `packages/gateway/src/lib/teamAttention.pg.test.ts` (new,
listed in `ci.yml`)
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/lib/teamOverview.test.ts` and the new pg test with its
flag set as `ci.yml` does. For an `ENGINEER` caller, `mine` counts only their own items and the `lead`
block is still absent.

### Task 9: "My work" card and Start work links on the team Overview

**What**: In `TeamOverviewView.tsx` render a "My work" card from `overview.mine` above the team
numbers and above the lead panel, for every viewer level. Add a **Start work** link to each
repository row where `canLaunch` is true. A view-only row keeps its badge and shows no link.
**Files**: `packages/web/src/components/teams/space/TeamOverviewView.tsx`,
`packages/web/src/components/teams/space/TeamOverviewView.test.tsx`
**Depends on**: Task 8
**Verify**: `yarn vitest run packages/web/src/components/teams/space/TeamOverviewView.test.tsx`.
"My work" appears before "Team numbers" for `engineer`, `lead` and `admin` levels. A `canLaunch: false`
row shows no Start work link.

### Task 10: Manage tab with Repositories, Budget and Service principals

**What**: Add `manage` to `TEAM_TABS`, a page at `app/teams/[slug]/manage/page.tsx`, and a
`TeamManagePanel`. The tab shows for a team `LEAD` or `ADMIN` and for a platform `ADMIN`; for anyone
else it is absent and its address renders the not-found page, as Settings does. Sections in this task:
Repositories (owned, shared, launch permission), Budget (the meter with a link to Settings, Budget
for those who may edit), and Service principals (moved out of the Settings tab).
**Files**: `packages/web/src/lib/teamSpace.ts`, `packages/web/src/app/teams/[slug]/layout.tsx`,
`packages/web/src/app/teams/[slug]/manage/page.tsx` (new),
`packages/web/src/components/teams/space/TeamManagePanel.tsx` (new),
`packages/web/src/components/teams/space/TeamSettingsPanel.tsx`
**Depends on**: Task 5
**Verify**: `yarn vitest run packages/web/src/components/teams packages/web/src/lib/teamSpace.test.ts`.
An `ENGINEER` sees no Manage tab and `/teams/<slug>/manage` renders not-found. A `LEAD` sees the three
sections. The Settings tab no longer lists Service principals.

### Task 11: Manage tab Schedules and Automations sections

**What**: Add two sections to `TeamManagePanel`. Each shows a compact list of the team's own items
(name, cadence or trigger, enabled state, last outcome) with an **Open** link to the existing editor
at `?team=<slug>`. Editing stays on the existing pages: this narrows the spec's word "editable", and
the plan records that choice. If the schedules list lacks a `teamId` filter, add it to
`GET /api/v1/scheduled-work-requests` with a query test.
**Files**: `packages/web/src/components/teams/space/TeamManagePanel.tsx`,
`packages/web/src/components/teams/space/TeamSchedulesSection.tsx` (new),
`packages/web/src/components/teams/space/TeamAutomationsSection.tsx` (new),
`packages/gateway/src/routes/scheduledWorkRequests.ts`
**Depends on**: Task 10
**Verify**: `yarn vitest run packages/web/src/components/teams packages/gateway/src/routes/scheduledWorkRequests.test.ts`.
The Manage tab lists only this team's schedules and automations. A schedule of another team never
appears.

### Task 12: Unowned failures list and `FailureAssignment` storage

**What**: Add a `FailureAssignment` model (`workflowRunId` unique, `assigneeId`, `assignedById`,
`createdAt`) with a migration. Add `GET /api/v1/teams/:id/attention/failures` (team `LEAD` or
`ADMIN`): request title, repository, failure time, former launcher's name, using the same
unowned-failure definition as the overview. Make `lead.unownedFailures` exclude assigned runs. Put
the new routes in `routes/teamAttention.ts` and register them in `routes/register.ts`.
**Files**: `packages/shared/src/prisma/schema.prisma`,
`packages/shared/src/prisma/migrations/<new>_failure_assignments/migration.sql`,
`packages/gateway/src/routes/teamAttention.ts` (new), `packages/gateway/src/lib/teamOverview.ts`,
`packages/gateway/src/lib/assistantPolicy.ts`
**Depends on**: Task 8
**Verify**: `yarn db:generate`, then `yarn vitest run packages/gateway/src/routes/teamAttention.test.ts`
and the pg test. The list returns an unowned failure. An `ENGINEER` gets 403. A run with a
`FailureAssignment` row is absent from the list and from `lead.unownedFailures`.
`assistantPolicy.test.ts` passes.

### Task 13: Assign a failure and show it on the assignee's desk

**What**: Add `POST /api/v1/teams/:id/failure-assignments` with `{ runId, assigneeId }`. Return 201 and
create the row. Return 409 `NOT_UNOWNED_FAILURE` when the run is not an unowned failure of the team's
work. Return 422 `ASSIGNEE_NOT_MEMBER` when the assignee is not a member of the owning team. Never
write `WorkflowRun.launchedById`. Write an audit entry. In `lib/meSummary.ts` (and the overview
`mine.failed` count) treat an assigned failure as the assignee's `failed_run` item.
**Files**: `packages/gateway/src/routes/teamAttention.ts`, `packages/gateway/src/lib/meSummary.ts`,
`packages/gateway/src/lib/auditLog.ts`, `packages/gateway/src/lib/assistantPolicy.ts`,
`packages/gateway/src/routes/teamAttention.test.ts`
**Depends on**: Task 12
**Verify**: `yarn vitest run packages/gateway/src/routes/teamAttention.test.ts packages/gateway/src/lib/meSummary.test.ts`.
The three status codes above hold. After assignment the assignee's `needsYou` has a `failed_run` item
and `launchedById` is unchanged. An audit row exists.

### Task 14: Nudge a stale approval

**What**: First check whether the worker's Slack announcement of a human step already mentions the
approvers (read `worker/src/lib/slackNotify.ts`) and record the finding in the commit message. Add a
`lastNudgedAt` column to `WorkflowHumanStep` with a migration. Add `POST /api/v1/human-steps/:id/nudge`
for a `LEAD` of the owning team: it posts one thread reply through `postSlackMessage` in
`gateway/src/lib/slack.ts` to the stored `slackMessage`. Return 429 `NUDGE_RATE_LIMITED` inside four
hours and 409 `NUDGE_UNAVAILABLE` without a stored message. The text has no broadcast mention and
passes the step title through `escapeSlackMrkdwn`. Write an audit entry.
**Files**: `packages/shared/src/prisma/schema.prisma`,
`packages/shared/src/prisma/migrations/<new>_human_step_nudge/migration.sql`,
`packages/gateway/src/routes/humanSteps.ts`, `packages/gateway/src/lib/assistantPolicy.ts`,
`packages/gateway/src/routes/humanSteps.test.ts`
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/humanSteps.test.ts` with a fake Slack writer.
One call posts once and sets `lastNudgedAt`. A second call inside four hours returns 429 and posts
nothing. A step with no stored message returns 409. A non-lead gets 403. The posted text matches no
`<!channel>`, `<!here>` or `<!everyone>`.

### Task 15: Budget change requests

**What**: Add a `TeamBudgetRequest` model (`teamId`, `requestedById`, `reason`, `createdAt`,
`resolvedAt`) with a migration and a partial unique index on pending rows per team. Add
`POST /api/v1/teams/:id/budget-requests` (team `LEAD`; reason 1 to 500 characters; 201; 409
`REQUEST_PENDING`; no amount in any response) and `GET` for team admins and organization admins. When
a team's cap is saved, set `resolvedAt` on its pending rows. Write an audit entry.
**Files**: `packages/shared/src/prisma/schema.prisma`,
`packages/shared/src/prisma/migrations/<new>_team_budget_requests/migration.sql`,
`packages/gateway/src/routes/teamBudgetRequests.ts` (new),
`packages/gateway/src/lib/teamBudgetAccess.ts`, `packages/gateway/src/lib/assistantPolicy.ts`
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/routes/teamBudgetRequests.test.ts` and the pg test
for the pending-uniqueness rule. A lead creates a request (201). A second one returns 409. An admin
saving the cap resolves it. An `ENGINEER` gets 403. No response body contains a dollar amount.

### Task 16: Attention section: failures and assignment

**What**: Add an Attention section to `TeamManagePanel` for the unowned-failures list with an
**Assign** control that lists team members and calls the Task 13 route. After success the item leaves
the list and the overview count refreshes. Show the "Open pull requests" count as a link to the
existing list.
**Files**: `packages/web/src/components/teams/space/TeamAttentionSection.tsx` (new),
`packages/web/src/hooks/useTeamAttention.ts` (new),
`packages/web/src/components/teams/space/TeamManagePanel.tsx`
**Depends on**: Task 10, Task 13
**Verify**: `yarn vitest run packages/web/src/components/teams/space/TeamAttentionSection.test.tsx`.
The list renders. Assigning calls the route with `{ runId, assigneeId }` and removes the row. A 409
shows an error without removing the row.

### Task 17: Attention section: stale approvals and nudge

**What**: Add the stale-approvals list to the Attention section from
`GET /human-steps?overdue=true&teamId=`. Each row has a **Nudge** button that calls the Task 14 route.
Hide the button when the step has no Slack message. Show "Nudged <time> ago" after a success and a
clear message on 429.
**Files**: `packages/web/src/components/teams/space/TeamAttentionSection.tsx`,
`packages/web/src/hooks/useTeamAttention.ts`,
`packages/web/src/components/teams/space/TeamAttentionSection.test.tsx`
**Depends on**: Task 14, Task 16
**Verify**: `yarn vitest run packages/web/src/components/teams/space/TeamAttentionSection.test.tsx`.
Nudge calls the route once, shows the timestamp and disables itself. A 429 shows the rate-limit
message.

### Task 18: Budget request UI

**What**: In the Manage Budget section show **Request a change** to a lead who cannot edit the cap. It
opens a dialog with a reason field (1 to 500 characters) and calls the Task 15 route; a 409 shows that
a request is already pending. In Settings, Budget show pending requests (reason, requester, date) to
team admins and organization admins.
**Files**: `packages/web/src/components/teams/space/TeamBudgetRequestDialog.tsx` (new),
`packages/web/src/components/teams/space/TeamManagePanel.tsx`,
`packages/web/src/components/teams/space/TeamSettingsPanel.tsx`,
`packages/web/src/hooks/useTeamBudgetRequests.ts` (new)
**Depends on**: Task 10, Task 15
**Verify**: `yarn vitest run packages/web/src/components/teams`. A lead who cannot edit sees the button
and a successful request closes the dialog. An editor sees no button and sees the pending list. A 409
shows the pending message.

### Task 19: Docs, upgrade note and full quality gates

**What**: Update `docs/teams.md` (role rule, the "My work" panel, the `mine` block, the Manage tab,
attention actions, and a `## Limitations` entry for nudge reach and approver resolution). Add one
`docs/upgrade-notes.md` entry that names both affected groups, names that a team `LEAD` may now
invite users (gated by the organization's `trustedInvites`, decision D3), names the existence-signal widening and the ORG_ADMIN reach (D4, D5), and gives a query that lists them;
follow the existing entry format and fixing-commit convention. Update `docs/work-views.md` or other
docs only where a moved address appears. Run every gate in `CLAUDE.md` §5.
**Files**: `docs/teams.md`, `docs/upgrade-notes.md`, other `docs/*.md` where a moved address appears
**Depends on**: Task 1, Task 7, Task 11, Task 13, Task 14, Task 15, Task 18
**Verify**: `yarn install --immutable`, `yarn typecheck`, `yarn biome check <explicit directories>`,
`yarn test`, `yarn build`, `yarn docs:check`, `yarn invariants:check`,
`yarn workspace @auto-swe/site build`, the matching `*.pg.test.ts` suites with Postgres up, and the
three `docker build` commands. Report each gate's result. Report plainly any gate that could not run.
