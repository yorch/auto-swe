# Teams and the personal desk

A person belongs to one or more teams, and the dashboard's Home is their **desk**: the teams they
are a member of and what is waiting on them across all of them. This document covers what the desk
contains, who sees what, and how its counts agree with the lists behind them.

---

## 1. My desk

`GET /api/v1/me/summary` (any signed-in user) returns the whole desk in one response:

| Field | Meaning |
|---|---|
| `teams` | Every active team the caller is a **member** of, each with their role (`myRole`), the organization, `needsYou` (items on this team's work), `running` and `queued` |
| `needsYou.items` | Up to 25 things waiting on the caller, most urgent first |
| `needsYou.total` | How many there were before the 25-item cap |

My desk's header offers **Take the tour**, **Browse workflows** and **Start work**. Its In flight
and Recent results sections span the page width. Member team spaces are reachable through the
sidebar and team switcher ([§3](#navigation)); Home remains a cross-team desk.

A platform ADMIN's desk is member-scoped like anyone's: it lists only the teams they belong to and
only the work of those teams. Their visibility and control filters are unrestricted, so every desk
query ANDs an extra member-scope term (`memberRunScope()` in `gateway/src/lib/runTeamScope.ts`)
beside them. It narrows; it grants nothing.

### What Needs you contains

Three sources, merged and de-duplicated by `key`:

| Kind | Source | Who it is for |
|---|---|---|
| `approval` | A pending human step the caller can answer: on a run they control, not yet answered by them, not expired | The caller, as an approver |
| `approval_due_soon` | The same, with a deadline within the due-soon window | The caller, as an approver |
| `failed_run` | The latest attempt of a request, when it failed or timed out **and the caller launched that attempt, or a lead assigned it to the caller** ([§3, Manage](#manage)) | The person who launched it, or the assignee |
| `pr_merge` | A request the caller **requested** whose pull request is open and awaiting a human merge | The requester |

The due-soon window is the registry setting `workflow.approvalDueSoonHours` (default 24 hours,
GLOBAL scope). Due-soon approvals come first, soonest deadline first; everything else follows,
newest first. `dueAt` carries an approval's deadline whether or not it is due soon.

Approvals are exactly the steps `GET /api/v1/human-steps?actionable=true&mine=true` lists, built by
one function (`deskHumanStepWhere()` in `gateway/src/lib/meSummary.ts`, over `humanStepListWhere()`).
`mine=true` applies the same member-scope term as the desk: it keeps only steps on runs of the
caller's own teams' work (a repository one of their teams owns or is shared, or a template one of
their teams owns). For a signed-in user it changes little; for a platform ADMIN it is what makes the list
total equal the desk's approval count.

A failed attempt counts only while it is the **latest** attempt of its request: a retry that
succeeded clears the failure. The latest attempt is chosen among all attempts the caller can see on
their teams' work, before the launcher is considered, so someone else's successful retry also
clears it. A multi-repository request has one latest attempt per repository; each failed one the
caller launched is its own item, and each one awaiting a merge on a request the caller made is too,
placed under its own repository's team.

### Team counts

`running` plus `queued` is the `total` of `GET /api/v1/workflow-runs/requests?scope=TEAM&state=active&teamId=<team>`
for that team: requests (not runs) whose latest visible attempt is running, on a repository the team
owns or that is shared to it, or on a template it owns, excluding channel assistant and channel task
runs and runs without a request. A multi-repository request counts once. It is `queued` while the
ledger row of its running execution is still `STARTING` (accepted, no work started) and `running`
otherwise. A request on a repository shared to two of the caller's teams counts for both. `needsYou` on a team counts the
items in the list above whose run sits under that team by the same rule, so the sum across teams can
exceed `needsYou.total`.

Each item names the team that **owns** the repository (or the template). That team can be one the
caller is not a member of: a sharee sees the owner's name on a shared repository's work. Titles come
from fields the caller can already read: the step's title, or the request's title, description or
ticket id.

### Who sees what

| Person | Approvals | Failed runs | Merges |
|---|---|---|---|
| Owning team member | Steps on runs they control | Attempts they launched, and failures a lead assigned to them | Requests they made |
| Member of a team the repository is shared to | None on the owner's runs (visible, not controllable) unless they launched the run | Attempts they launched, and failures a lead assigned to them | Requests they made |
| Platform ADMIN | Only for teams they are a member of | Same | Same |

## 2. Team overview

`GET /api/v1/teams/:id/overview` (any signed-in user) is one team's landing page in one response.
The caller must be a **member** of the team or a platform ADMIN; anyone else, and any unknown id,
gets the same `404 TEAM_NOT_FOUND`. It is built by `buildTeamOverview()` in
`gateway/src/lib/teamOverview.ts`.

### The view is decided by the team role

`viewerLevel` comes from the caller's role **in this team**, never from the platform role:

| Team role | `viewerLevel` |
|---|---|
| `ADMIN` | `admin` |
| `LEAD` | `lead` |
| `MEMBER` | `member` |
| none (platform ADMIN who is not a member) | `admin`, and `team.myRole` is `null` |

A platform `ADMIN` whose role in the team is `MEMBER` gets the `member` view. A platform
`USER` who is not a member gets nothing: only the platform ADMIN is let in.

### What it contains

| Field | For | Meaning |
|---|---|---|
| `team` | everyone | `id`, `slug`, `name`, `orgId`, `orgName`, the caller's `myRole` |
| `needsYou.total` | everyone | The caller's own items on this team's work, by the desk's rules ([§1](#what-needs-you-contains)) scoped to this team. Its approvals are exactly `GET /api/v1/human-steps?actionable=true&teamId=<team>` |
| `mine` | everyone | The caller's own work on this team: `running` (requests they launched that are running, counted as `running` is), `failed` (failed attempts they launched or a lead assigned to them) and `prsAwaitingMerge` (pull requests of their requests that await a human merge). The last two are the desk's own `failed_run` and `pr_merge` items, so the team page and the desk agree |
| `running`, `queued` | everyone | Requests running on the team's work, split as the desk's team cards split them |
| `last7d` | everyone | `started`, `succeeded`, `failed`: requests whose latest attempt started in the last 7 days on repositories the team owns or that are shared to it |
| `pullRequests` | everyone | Last 30 days, owner-attributed: `opened`, `merged`, `closedUnmerged`, `mergeRate`, `timeToMergeP50Hours`. The same filters and summary as `GET /api/v1/pull-requests/outcomes?scope=TEAM&teamId=` (`teamPullRequestOutcomes()` in `gateway/src/lib/pullRequestOutcomesQuery.ts`) |
| `activity` | everyone | Up to 10 recent requests the caller may see on the team's work: `title`, `state` (`active`, `attention`, `success`, `failed`), repository, the launcher's **name**, time. Cancelled and skipped attempts are left out |
| `repos` | everyone | Active repositories the team owns or that are shared to it, that the caller may reach (membership and the access gate): `relation` is `owned` or `shared`, and a shared one names the owning team |
| `budget` | everyone | The budget that binds work on the team's repositories: `scope`, `state`, `percentUsed`, `alertThresholdPercent`. Percent only, for every viewer level ([the budget meter](#the-budget-meter)); `null` when neither the team nor its organization sets a cap |
| `lead` | `lead`, `admin` | `unownedFailures`, `staleApprovals`, `openPullRequests` |
| `needsAdmin` | viewers holding `team.members.manage` on the team | `true` when the team has no ADMIN, which an organization removal can leave. Absent otherwise, never `false`; appoint one through the members tab |
| `repos[].canLaunch` | everyone | `false` when the repository is shared to the team view-only; always `true` for an owned one |
| `admin.monthCostUsdCents` | `admin` | This calendar month's spend (UTC) attributed to the team, in cents; `null` when it cannot be computed. Absent for a team ADMIN who is not an organization ADMIN when the binding cap is the organization's; present when the team's own cap binds |

`lead`, `admin` and `needsAdmin` are **absent** from the JSON for a lower view, not `null`, and their queries are
not run. The `activity` feed names a launcher by display name only. The feed's name is the run's credential launcher (`launchedById`), so it can differ from a run's initiator. Run lists are different: a run's
initiator is shown with name and email to anyone who can see the run ([run-provenance.md](./run-provenance.md)).

The **My work** card sits above the team numbers on the overview and shows `mine`, with the same rules
as the personal desk ([§1](#what-needs-you-contains)):

- **Running**: requests whose latest attempt the caller launched and that are running. Queued
  requests are not counted.
- **Failed**: failed attempts in the last 30 days that the caller launched or a lead assigned to them.
- **PRs awaiting merge**: the caller's requests whose pull request awaits a human merge.

Each figure links to a browsable list filtered by who requested the work, so the number and the list
can differ ([Limitations](#limitations)). The lead panel follows the card for a lead or admin.

Definitions:

- **Unowned failure.** A failed or timed-out latest attempt, within the last 30 days and visible to
  the caller, on a run that belongs to a repository or template the team **owns**. A repository only
  shared to the team does not count. The failure is unowned when its launcher is unknown, is not an
  active member of the team, or the run was launched by automation. It stops being unowned when a
  lead assigns it to an active member of the team ([Manage](#manage)). A multi-repository request
  counts each failed repository.
- **Stale approval.** A pending human step on a run the caller may see whose deadline has passed:
  `GET /api/v1/human-steps?overdue=true&teamId=<team>`.
- **Open pull requests.** Open pull requests on repositories the team owns or that are shared to it,
  the total of `GET /api/v1/pull-requests?state=OPEN&scope=TEAM&teamId=<team>`.

The same `teamId` parameter narrows `GET /human-steps`, `GET /workflow-runs` and
`GET /repositories` ([work-views.md](./work-views.md#teamid-semantics)).

### The budget meter

`budget` is on each team of `GET /api/v1/me/summary` and on the team overview. It is the status of
the cap that binds the team's work: the **tighter** of the team's own cap and its organization's, by
the share of its cap already used ([§5](#5-team-budgets)). `scope` says which: `team` when the team's
cap binds, `org` otherwise. The organization's cap refuses a launch with `402 ORG_BUDGET_EXCEEDED`,
the team's with `402 TEAM_BUDGET_EXCEEDED`.

| Field | Meaning |
|---|---|
| `state` | `ok`; `alert` (month-to-date spend is at or past the alert threshold); `projected_over` (the month's pace would pass the cap); `over` (spend has reached the cap, which is when launches are refused). `no_cap` appears only on the status endpoint |
| `percentUsed` | Month-to-date spend as a share of the cap, one decimal, 100 or more once over |
| `alertThresholdPercent` | The alert threshold of the cap `scope` names: the team's own when `scope` is `team`, the organization's otherwise; `null` when that cap sets none |

The state is the budget report's forecast ([reporting.md](./reporting.md#budget)), with `over`
defined as the launch gate defines it. The spend is the one the cap is compared against
(`orgMonthSpend` for the organization, `teamMonthSpend` for the team). A tie in the share used goes
to the more severe state, then to the team. A response never carries the cap or the spend in dollars, whatever the viewer's
role: dollars are read by an organization ADMIN (or platform ADMIN) at `GET /api/v1/platform/organizations/:orgId/budget`.
Any member of an organization reads the same percentage-only status at
`GET /api/v1/platform/organizations/:orgId/budget/status`. The desk reads every team's organization
and team with one read of each and one spend read per capped organization or team, not one per team,
and a caller only ever receives the budgets of teams they belong to (the overview: of the team they
ask about).

A team's weekly report digest carries the same status as one line, state and percent only, naming
whose cap it is ([reporting.md](./reporting.md#weekly-digests)).

#### The cap a launch is held to

A launch on a shared repository spends the **owning** team's cap, not the sharee's ([§5](#who-pays)),
so a sharee's own `budget` can read fine while the launch is refused. `launchBudget` is the status
of the cap that does bind it: the owning team's, as the tighter of that team's own cap and its
organization's, in the same percent-and-state shape as `budget` and with no amount.

- **On the team overview**, each entry of `repos` carries `launchBudget`: `null` for a repository
  the team owns (its status is the team's own `budget`), for a shared one whose owner has no cap,
  and for a view-only share; it is the owner's status for a shared **launchable** one.
- **On `GET /api/v1/repositories`**, each item carries `launchBudget` for a repository the caller can
  start work on (a member of the owning team, or of a team it is shared to without the view-only
  flag; a platform ADMIN for any). It is `null` for the rest, and where no cap is set. A view-only
  repository carries none, because the caller cannot launch there.
- It is read with the same batched reads as `budget` (one read of the teams, one of the
  organizations, one spend read per capped team or organization), grouped by owning team and never
  per repository. It adds nothing to who sees what: both responses were already limited to
  repositories the caller may see, and the status names no team and carries no cap or spend.

Both overview endpoints are read by the dashboard, and they wrap differently: the overview returns
`{ "data": { … } }`, while `GET /api/v1/me/summary` returns the desk bare, with no `data` envelope.
A client unwraps each as its own shape.

### Seeing a run versus controlling it

A member of a team a repository is shared to sees the owning team's runs, and cannot steer them:
answering a run's human steps, cancelling it and retrying a review fix need control of the run
(the owning team's members and whoever launched it; a platform ADMIN for any).

- `GET /api/v1/human-steps` and `GET /api/v1/human-steps/:id` mark each step `canAnswer`: `true` when the caller may answer it now.
  It is the `actionable=true` predicate (pending, not expired, not already answered by the caller,
  on a RUNNING run the caller controls), defined once in `humanStepActionableWhere()` and read by the list
  filter and by this flag, so `canAnswer` is `true` for exactly the steps `actionable=true` returns
  to a person. A service-principal token is refused when it answers a step, so `canAnswer` is
  always `false` for one.
  It is computed with one query over the page's step ids.
- `GET /api/v1/workflow-runs/:id` carries `ownerTeam` (`id`, `name`, `slug`): the team that owns the
  run's repository, or `null` when the run has none. It is the owner a caller who sees the
  repository already sees in the repository list.
- In the `review` block, `canControl` is `false` for a viewer who does not control the run, and then
  `fixRetry.allowed` is `false` too, with a reason that names the owning team. A retry
  already queued stays reported as queued.

## 3. The team space

Each team has its own place in the dashboard at `/teams/<slug>`, reached through the team's slug.
Its header names the organization and the caller's role in the team. The tabs are:

| Tab | Address | Who sees it | What it holds |
|---|---|---|---|
| Overview | `/teams/<slug>` | every member, and a platform ADMIN | The overview of [§2](#2-team-overview): the My work card, the numbers, the lead and admin panels the server sent, recent activity and repositories |
| Work | `/teams/<slug>/work` | every member | One team's requests, pull requests, tickets and epics, through the same lists as the global pages, narrowed to the team |
| Automations, Reports, Knowledge | `/teams/<slug>/automations`, `…/reports`, `…/knowledge` | every member | A short panel with a link to the existing page, which reads `?team=<slug>` and narrows itself |
| Members | `/teams/<slug>/members` | every member | The team's membership |
| Manage | `/teams/<slug>/manage` | whoever holds `team.attention.read` on the team (a team `LEAD` or `ADMIN`), and a platform admin | The team's running: Attention, Repositories, Schedules, Automations, Budget and Service principals ([§3, Manage](#manage)) |
| Settings | `/teams/<slug>/settings` | whoever holds `team.settings.manage` on the team (a team `LEAD` or `ADMIN`, an organization `ADMIN` of its organization), and a platform admin | The team's configuration: general details, the budget cap for those who may edit it, automation, secrets and the sandbox policy |

The Manage and Settings tabs are hidden from everyone else, and their addresses answer not found.
Which sections of the Overview appear is decided by the server from the team role ([§2](#the-view-is-decided-by-the-team-role)),
never by the tabs.

### Manage

The Manage tab is where a team's lead runs the team. It is offered to whoever holds
`team.attention.read` on the team (a team `LEAD` or `ADMIN`) and to a platform admin, and no one else. Editing a cap or a configuration stays in Settings;
Manage holds the work that a lead acts on and the sections that edit the team's own resources.

| Section | What it holds |
|---|---|
| Attention | Unowned failures, stale approvals and open pull requests, each with the action it takes |
| Repositories | The team's owned and shared repositories, with shares and launch permission |
| Schedules, Automations | Read-only lists of the team's schedules and automations, each with an **Open** link. Schedules open the unfiltered schedules page; automations open `/automations?team=<slug>` |
| Budget | The meter, and **Request a change** for a lead who cannot edit the cap |
| Service principals | The team's machine identities, moved here from Settings ([service-principals.md](./service-principals.md#6-managing-principals-and-tokens)) |

**Attention.**

- **Unowned failures.** `GET /api/v1/teams/:id/attention/failures` lists them, newest first, with the
  request title, the repository, the failure time and the former launcher's name. A lead assigns one
  with `POST /api/v1/teams/:id/failure-assignments` and `{ runId, assigneeId }`. The assignee must
  be a member of the team (`422 ASSIGNEE_NOT_MEMBER`), and the run must still be an unowned failure
  (`409 NOT_UNOWNED_FAILURE`). The assignment stores a `FailureAssignment` row and is audited. It
  never changes `WorkflowRun.launchedById`: that field is the key a per-user GitHub credential is
  resolved by, so later work on the request keeps running under the same credential, and the
  assignee does not inherit the former launcher's. The assignee sees the failure as their own
  `failed_run` item in the desk and in `mine.failed`, and it leaves the team's unowned count. An
  assignment counts only while the assignee is still an active member of the team. When the assignee
  leaves the team or is deactivated, the assignment lapses: the failure is unowned again and a lead
  can assign it to another member.
- **Stale approvals.** The lead lists overdue pending steps with
  `GET /api/v1/human-steps?overdue=true&teamId=<team>`, which includes work shared to the team as
  well as work it owns. Each row says whether the step has a Slack thread (`hasSlackThread`). The
  **Nudge** button appears only where the server's `canNudge` is true: the step is pending, overdue
  and has a Slack thread, and the caller is a `LEAD` or `ADMIN` of an active team that owns the run,
  or a platform ADMIN.
- **Open pull requests.** The count links to the team's open pull requests.

**The nudge.** `POST /api/v1/human-steps/:id/nudge` posts a reminder for one overdue step. The
caller must be a platform ADMIN or a `LEAD` or `ADMIN` of a team that owns the run; anyone else gets
`403`, and a step the caller cannot see gets `404`. The step must be pending, past its deadline and
announced in Slack; otherwise the answer is `409 NUDGE_UNAVAILABLE`.

- **Rate.** A step is nudged at most once every four hours (`429 NUDGE_RATE_LIMITED` before then).
  The slot is claimed before the post, and a post that fails releases it and answers
  `502 SLACK_POST_FAILED`.
- **Reach.** The reminder is one plain reply in the thread of the step's Slack announcement, not a
  broadcast to the channel. The announcement does not address the approvers by name, so the reply
  reaches the people following that thread. It creates no in-app notification. The text is fixed
  and carries only the step title, escaped, and the date the step was requested.
- The response is `{ data: { nudgedAt } }`. The action is audited as an update of the step.

**Budget requests.** A team `LEAD` who is not an organization admin sees **Request a change** on the
Budget section and asks for a change with `POST /api/v1/teams/:id/budget-requests` and `{ reason }`. The reason is 1 to 500 characters after
trimming. A request carries no amount. A team has one pending request at a time; a second one
answers `409 REQUEST_PENDING`. The request is audited with the reason's length, not the reason.
The team ADMIN, an organization ADMIN of the organization and a platform ADMIN list the pending requests
with `GET /api/v1/teams/:id/budget-requests`, oldest first, and see them in Settings, Budget. Nobody
is notified of a request. A `PATCH /api/v1/teams/:id/budget` whose body names
`monthlyBudgetUsdCents` resolves every pending request in the same transaction, whether it raises,
clears or keeps the cap. A threshold-only save leaves them pending. An admin who declines a request
dismisses it with `POST /api/v1/teams/:id/budget-requests/:requestId/dismiss`, which needs the same
permission as saving the cap, answers `404 BUDGET_REQUEST_NOT_FOUND` for a request that is not
pending in that team, and is audited.

**Other sections.** Repositories use the existing repository routes. Schedules use
`GET /api/v1/scheduled-work-requests?teamId=<team>`, which narrows the list to the schedules the team
owns and keeps the caller's visibility.

### The team role decides

Every action on a team's work asks for the caller's role **in that team**, whatever their platform
role. A platform `USER` who leads a team manages its members and settings, invites people, edits
its repositories and templates, and launches epics, PRD runs and campaigns on its repositories. A
platform `USER` who is only a `MEMBER` of a team has none of that on it. A platform `ADMIN` passes
every team check. Settings that no team owns are written by a platform `ADMIN`, or by a user a settings grant covers. The global review presets are platform `ADMIN` only. Organization-scoped pages
(the error baselines) decide by organization membership. The route test `teamRoleFloor.test.ts` fails when a route that names a team role also asks
for a platform role above `USER`; the two sandbox allowlist routes, which are platform `ADMIN` only
by design, are the named exceptions.

A platform ADMIN may open the space of a team they are not a member of by its address. The overview
answers for them (`team.myRole` is `null`) and the global pages' `?team=` filter resolves the team
for them ([§4](#4-the-team-filter-on-global-pages)). That does not put the team in their navigation:
the switcher, the sidebar and the badges list only the teams they belong to.

### Team setup checklist

The Overview shows **Team setup** to team LEAD/ADMIN and platform ADMIN while any setup item
is incomplete: another member besides the first admin, at least one active owned or shared
repository, and a team budget. Each item links to Members, Connections, or Settings → Budget.
A zero-dollar budget counts as set and refuses launches. A team or organization admin sets the
budget; a team lead who cannot edit it asks one of those admins. The checklist reads the existing
team detail and disappears when every item is complete. It does not check model readiness:
models resolve per agent through the configuration cascade rather than a single team setting.

### Navigation

- **Team switcher.** The top bar holds a switcher that lists **All my teams** first and then the teams
  the caller is a member of, sorted by name, each with the caller's role in it and a badge with what
  is waiting on them there (the team's `needsYou` from `GET /api/v1/me/summary`). Choosing a team
  opens its space on the tab the caller is already on. The switcher is for moving around; it narrows
  nothing. It appears on Home, work lists, Start work and team spaces, plus the team-aware Workflow
  library, Knowledge, Automations and Reports pages. Other configuration, account, Docs and Admin
  pages, and focused editor/run/diff routes, omit both the top-bar switcher and its mobile strip.
  The Home page title remains **My desk**.
- **Sidebar My teams group.** The sidebar lists the member teams as links to their spaces, each with the
  same badge: the teams the user pinned first, in pin order, else the member teams up to a limit.
- **Preferences.** `PATCH /api/v1/me/preferences` stores two per-user hints beside the run-detail
  layout. `lastTeamSlug` records the last member team space the user opened; it does not redirect
  Home. `pinnedTeamSlugs` is an ordered list of up to 20 slugs that the sidebar shows, set
  by the pin toggle beside each team in the team switcher menu (a new pin goes last; the toggle is
  disabled at 20). The sidebar shows every pinned team and caps only its default list. Neither is checked against existing teams or
  the caller's membership: the dashboard resolves a slug through the member team list, so a stale or
  foreign one resolves to nothing and grants nothing.
- **Sidebar approvals badge.** The badge on Approvals counts the steps waiting on the caller across
  every team; a team's own number is the badge on that team.

## 4. The team filter on global pages

The global list pages take `?team=<slug>`: requests, runs, pull requests, tickets, epics,
approvals, the workflow library, reports, automations and knowledge. The team spaces link to them
this way. The slug is resolved to a team in the browser, then the page passes its id as `teamId` to
the list it reads ([work-views.md](./work-views.md#teamid-semantics)).

- **Member teams only.** The slug is looked up among the teams the caller belongs to. A slug that
  names no such team, a team that does not exist and a team the caller is not in are all ignored in
  the same way: the page shows every team's rows, with no chip and no error, so a slug confirms
  nothing about a team. A platform ADMIN is the exception: the slug also resolves through the full
  team list, so the pages narrow to a team they are not in.
- **A chip says so.** A page narrowed to a team shows a chip with the team's name; removing it drops
  the parameter and the page offset.
- **Never all teams by accident.** While the team list is loading the page waits and shows its
  loading state. If the team list cannot be read, the page shows an error with a retry rather than
  every team's rows under a URL that names one team.
- **Needs you opens the same set.** The Overview's "Needs you" links to
  `/approvals?team=<slug>&actionable=1`. `actionable=1` limits the approvals page to the steps the
  caller can answer, the set the number counts; without it the page lists every pending step the
  caller may see. The page offers a way back to the wider list.
- **The Pending count follows the filter.** With a team filter the Approvals page's Pending tab
  counts that team's steps. The sidebar badge is unaffected.
- **Row chips.** In lists that mix teams, a request row names the team that owns its repository, and
  a pull request row names the owner of its repository (`ownerTeam`). A repository shared to a team
  does not add that team to a row.
- **Automations.** With `?team=`, the automations page lists the automations the team owns, those on
  its own repositories and, read-only, those on repositories shared with it.

A service principal that names a `teamId` on `GET /api/v1/workflow-runs` skips the membership check;
it has no memberships, and the filter still only narrows what its token may see.

## 5. Team budgets

A team may hold its own monthly cap in addition to its organization's. It is a column on the team's
own row (`monthlyBudgetUsdCents`, `budgetAlertThresholdPercent`), not a registry setting: the launch
gate and the mid-run guard read it from the row, and nothing resolves it through the scope cascade.

### Who sets it

| Route | Who | Does |
|---|---|---|
| `GET /api/v1/teams/:id/budget` | team `ADMIN`, organization `ADMIN` of the team's organization, platform `ADMIN` | The cap, the alert threshold (1 to 100) and this month's spend in cents |
| `PATCH /api/v1/teams/:id/budget` | the same | Set or clear (`null`) either; the cap is a whole number of cents from 0 up, and 0 refuses every launch. Audited |
| `GET /api/v1/teams/:id/budget/status` | any member of the team, and the same three roles | The binding status, percent and state only |

A team `LEAD` is refused the first two (`403`). A caller with no standing on
the team gets the `404 TEAM_NOT_FOUND` an unknown team gets. The responses are wrapped in `data`.
The team ADMIN reads the team's own spend in dollars here because the cap is theirs; the
organization's cap and spend stay an organization ADMIN's.

### Who pays

The **owning team** pays for a run on a repository, also when another team launched it through a
share: the owner's provider credentials, its cap and its spend. `teamMonthSpend` counts a run under
`WorkflowRun.attributedTeamId` — the owner of the run's repository, and only for a run with no
repository the channel's, the service principal's or the template's team, and last the team its
connection-less launch was held to (`RunInput.billingTeamId`, stamped beside `billingOrgId` by every
launch that applies the cap with no repository: an automation fire on a global template, a template
run or webhook, a service principal's run, a re-run). The launch gate, the spend and the mid-run
guard therefore name one team. A launch is refused with
`402 TEAM_BUDGET_EXCEEDED` when that owner has reached its cap, after the organization's check. The
body names no amount, and names the team only to one of its members; a sharee is told that the team
owning the repository is over budget. A platform ADMIN is not exempt.

Spend is the month's finalized runs (by the month they ended in, UTC), plus what in-flight runs have
accrued so far, plus runless workflows stamped with the team. Read in one snapshot, a finalizing run
is on exactly one side. The cap is checked at every launch path that checks the organization's
([launch paths](#launch-paths-and-the-team-cap)), and again before each model call of a running run,
which stops with a non-retryable `BUDGET_EXCEEDED` once its owner team is at the cap. A cap of 0 is
at the cap with nothing spent, so it refuses every launch and also stops every in-flight run of the
team at its next model call.

The in-app assistant is subject to the cap for a user who is a member of exactly one active team:
its calls count toward that team's month spend and stop at the cap (a cap of 0 stops them
immediately), and when the team has a cap an assistant model with no catalog price is refused.
A user in several teams is attributed to the organization only; their assistant calls are not gated
by any team cap.

### Budget notifications

A team is told when its spend crosses the cap's thresholds, without waiting for a report digest.
The mid-run guard reads the team's month spend once per cache window (about 30 s) per worker
process; each read evaluates two levels:

- `WARNING`, when spend reaches `budgetAlertThresholdPercent` of the cap. A team with no threshold
  has no warning.
- `CAP_REACHED`, when spend reaches the cap (a cap of 0 is reached at once). New runs are blocked
  from this point.

Each level is sent at most once per team per UTC calendar month, to the team's Slack notify
channel (`Team.slackNotifyChannel`, the channel step-failure notices use). The message names the
team (escaped), the month, the percent used, and spend and cap in dollars, and links to the team
settings page where the budget is managed. It is a message to a channel the team chose, so it
carries dollars; the channel is not checked against who may read the cap.

The dedupe is durable: a `TeamBudgetNotice` row keyed `(team, month, level)` is claimed by an
insert before the post, and a unique violation means another evaluation, in this or another
worker, already holds the notice. The claim is taken only when the team has a channel and a bot
token resolves, so a channel configured later in the month still gets that month's notice. It is
released if the post fails transiently (a rate limit, a 5xx, a network error), so the next
evaluation retries; a permanent Slack failure (`channel_not_found`, `not_in_channel`,
`is_archived`, `invalid_auth`, `account_inactive`, and similar token errors) keeps the claim and is
logged once, so the notice is not retried for the rest of the month. Evaluation runs in the guard's activity
path, not awaited and never inside the workflow isolate; any failure is logged and dropped and
cannot fail or delay a model call. There is no setting to turn it off; a team with no notify
channel gets none.

### View-only shares

A share carries `canLaunch` (default `true`). A share with `canLaunch` `false` lets the sharing
team's members see the repository, its runs and lessons, and refuses their launches with
`403 REPOSITORY_VIEW_ONLY`. The owning team and a platform ADMIN are never view-only, and steering a
run that is already going is not a launch. A schedule or automation owned by a team the repository
is shared with view-only is refused at fire time (`share-view-only` for a schedule, a recorded
suppression for an automation). The check is on that team, not on the acting user, so a user who also
belongs to the owning team does not lift it; the owning team's own schedules are unaffected. A git
repository shared view-only is not usable either as a secondary connection of a run (a declared
input, a step's `connectionRef`) by that team. Set it per share with `PATCH /api/v1/repositories/:id/shares/:teamId`
([repositories.md](./repositories.md#3-sharing-with-other-teams)).

### Launch paths and the team cap

Every path that applies the organization's cap applies the owning team's: work requests and
re-runs, template runs and webhooks (connection-less runs against the template's team), epics, PRD
runs, schedules and their fires, the Slack run modal, automations, service principals, and the
review and review-fix launches. The channel-assistant code task and the children of an epic or PRD
run have no launch-time check of their own, as for the organization; the mid-run guard covers them.
Pull-request evaluation starts and eval screens check neither cap at launch either, and are held
only by the mid-run guard.

---

## 6. Team secrets

A team can hold named secrets that its repositories' setup steps and app previews use. They are
stored once on the team and reach a repository only when a team admin grants them to it. A team
admin is a team `ADMIN` or a platform `ADMIN`; a team `LEAD` and an organization admin do not manage
them. The **Team secrets** panel on the team page is the editor, and the routes below are the same
operations.

### Storing a secret

A team secret (`TeamSecret`) is encrypted with the same AES-256-GCM envelope as repository setup
secrets and is write-only. Nothing returns a value once it is saved.

- Its name follows the setup-secret rule: an upper-case environment-variable name. These names are
  refused: `PATH`, `HOME`, `USER`, `SHELL`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`,
  `CONTAINER_STEP_INPUT`, `NO_PROXY`, and any name that starts with `LD_`, `GIT_`, `SSL_CERT_` or
  `ASW_` or ends with `_PROXY`.
- Its value is at least 8 characters, since a shorter one matches unrelated files by chance in the
  [secret scan](./repositories.md#workspace-setup).
- A team holds at most 50.

| Route | Does |
|---|---|
| `GET /api/v1/teams/:teamId/secrets` | Lists each secret's name, its last four characters, when it changed, and the ids of the repositories it is granted to. |
| `PUT /api/v1/teams/:teamId/secrets/:name` | Sets or replaces the value. |
| `DELETE /api/v1/teams/:teamId/secrets/:name` | Removes the secret and its grants. |
| `PUT /api/v1/teams/:teamId/secrets/:name/grants` | Takes `connectionIds` and replaces the whole grant set for that secret. |

Saving, deleting and changing grants are written to the audit log under the entity type
`TeamSecret`, with the secret's name only. The in-app assistant cannot call these routes.

### Granting to repositories

Nothing is inherited. A team secret reaches a repository only when a team admin has granted it to
that repository. Only repositories the team **owns** are eligible; a repository merely shared to the
team cannot be granted a secret.

A setup definition or app preview definition names a team secret under `secrets:` exactly as it
names a repository secret (see [setup secrets](./repositories.md#workspace-setup)). For each name, a
run resolves it in this order:

1. the repository's own setup secret of that name, which wins;
2. otherwise a team secret granted to the repository by its current owning team, if that team is
   active;
3. otherwise the run fails with the `missing_secret` blocker, whose text reads "not set on the
   repository or granted from its team".

`GET /api/v1/repositories/:id/setup/secrets` lists the granted team secrets beside the repository's
own, with `source: 'team'`. A team secret that a repository secret of the same name shadows carries
`shadowed: true`, so the list shows which value is not in use.

### Where values go

A team secret's value reaches setup steps and app previews, as secret environment, and nowhere else.
It never reaches the agent, a container step or a shell workflow step. The post-setup leak scan and
the output redaction that apply to repository secrets apply to team secrets too. Evaluation runs never
receive team secrets.

### Moves and deactivation

Moving a repository to another team deletes its grants. Any grant that is left over is ignored
anyway, because resolution only considers the repository's current owning team. Deactivating a team
stops the secrets it holds from resolving for the repositories it owns.

## Creating teams and managing membership

On `/teams`, **New team** is available to platform ADMINs and anyone who administers an
organization. Organization admins choose among their administered organizations (the picker is
omitted for a single organization). The optional **First team admin** lists that organization's
members and defaults to the creator. The organization detail page at `/admin/organizations/:orgId`
offers the same action for its admins and platform ADMINs. Name/slug conflicts and first-admin
organization-membership errors stay in the dialog with guidance.

The team space's **Members** tab offers **Add member** and **Invite by email** to platform ADMINs
and team leads and admins, whatever their platform role. Add-member lists organization members;
platform ADMINs can choose any active user. A team `LEAD` or `ADMIN`, whatever their platform role,
can also add someone they can name by exact email through `GET /api/v1/users/lookup` (`403` for
someone who leads no active team; rate-limited to 30 a minute). Both forms restrict team roles to
the caller's own role or below. An invitation reports the response's active or waiting-for-approval state. The
organization's invite form also offers an optional team from that organization and a team role.

An organization's organization `ADMIN` creates a team with
`POST /api/v1/platform/organizations/:orgId/teams` (also available under
`/api/v1/admin/organizations/:orgId/teams`). Platform `ADMIN` can create in any organization.
`POST /api/v1/teams` remains platform-ADMIN-only and accepts an optional `orgId`, falling back
to the default organization. Team names and slugs are globally unique.

Both routes accept `name`, `slug`, optional `description` and optional `adminUserId`. The creator
becomes the first team `ADMIN` unless `adminUserId` selects another existing organization member.
An out-of-organization selection returns `400 organization MEMBERSHIP_REQUIRED`. A platform ADMIN creating
a team without selecting someone else receives an organization `MEMBER` membership if needed. Team creation,
the first team membership and any automatic organization membership commit together with audits.

Adding a member through `POST /api/v1/teams/:id/members` requires that user to belong to the team's
organization (`400 organization MEMBERSHIP_REQUIRED` otherwise). A platform ADMIN can add a non-member;
the gateway creates an audited organization `MEMBER` membership in the same transaction. The add
takes the organization's row lock before the team's and reads the organization membership under it,
so a concurrent organization removal cannot leave a user on a team without belonging to its
organization.

### Leaving an organization

Removing an organization membership (`DELETE /api/v1/platform/organizations/:orgId/members/:userId`,
also under the admin prefix) removes the user's memberships in every team of that organization in the
same transaction, with one audit row for each, carrying the `authority` of the decision. A role
change is not a removal and cascades nothing. The transaction locks the organization first, then the
affected teams in ascending id order, the order every membership write takes them in.

- Removing the organization's last organization `ADMIN` is refused with `409 LAST_ORG_ADMIN`, unless the
  actor is a platform ADMIN.
- The cascade may leave a team with no ADMIN only when the actor holds organization or platform
  authority; the team's overview then carries `needsAdmin` for those who can appoint one. A
  team-level removal of the last ADMIN is still refused with `409 LAST_TEAM_ADMIN`.

`GET /api/v1/me/permissions` answers what the signed-in person may do, from the same resolver the
routes use: `platformRole`, `platformCapabilities`, and for each team and organization they belong to
the `role` and the `capabilities`, each as `{ key, authority }`. With `?teamId=` it is narrowed to that
team and includes it when the person holds capabilities there only through organization or platform
authority (`role` is then `null`). A team the person has no standing on answers `403 FORBIDDEN`
whether or not it exists.

Sign-up and platform user invitations enroll the user in the default team's organization as
organization `MEMBER` and in the default team as `MEMBER` in one audited transaction. Existing organization
and team roles are preserved; repeated enrollment creates neither duplicate memberships nor audits.
Enrollment failures are logged without failing account creation, and neither membership is committed
if that enrollment transaction fails.

### Inviting someone directly into a team

`POST /api/v1/teams/:id/members/invite` accepts `email` and an optional team `role`
(`ADMIN`, `LEAD`, or `MEMBER`, default `MEMBER`). A team `LEAD` or `ADMIN` can invite, but
cannot grant a role above their own. Platform ADMIN can invite into any team. The account's
platform role is `USER`; the supplied role applies only to the team.
Inviting follows the same team-role rule as member-add.

Organization admins can also supply optional `teamId` and `teamRole` on
`POST /api/v1/platform/organizations/:orgId/members/invite` (including its admin-prefix alias).
The team must belong to that organization (`400 TEAM_ORG_MISMATCH` otherwise); `teamRole`
defaults to `MEMBER` and is separate from the invite's `orgRole`.

Both invitation routes create the account, organization membership and any team membership in one
audited transaction, then send a magic link. Team invitations grant organization `MEMBER` in the team's
organization. Existing email addresses return `409 USER_EXISTS`; use member-add for existing users.
Platform ADMIN invitations approve the account immediately (`admin`). Other team invitations approve
only in an active organization with `trustedInvites` enabled (`team_lead`); otherwise the account waits
in the approval queue. See [invited users](./oauth-setup.md#invited-users) for the trust policy.

## Team directory and join requests

Every signed-in user can browse the team directory, ask to join a team and follow that request in the
app. Team managers decide. A request to a team in another organization also needs an administrator of
that organization. The web app's **Directory** view is reached from the teams navigation, and the CLI
has `auto-swe teams directory`, `teams request`, `teams requests` and `orgs requests`.

### The directory

`GET /api/v1/teams/directory?q=&orgId=&limit=&cursor=` lists active teams with their public fields only:
name, slug, description, organization, member count, and the caller's `relationship` to the team, which
is `MEMBER`, `REQUESTED` (with the open `requestId`) or `NONE`. The member count covers active users
only. A team of a deactivated organization is not listed. The response also carries `creatableOrgs`,
the organizations where the caller may create a team now.

`teams.directoryScope` decides which teams appear, and it is resolved for each organization. A team is
listed to a viewer when its own organization's value is `platform`, or when the viewer belongs to that
organization. An organization with no value of its own uses the GLOBAL value, which is `platform` by
default. The team's own organization decides: no other organization's value applies to it. A request
may go only to a team the caller can see, and the same rule gates creating one. The response's
`organizations` lists the organizations with at least one team the caller may see, sorted by name and
capped at 500; `organizationsTruncated` is `true` when more exist, and the organization filter then
offers only the first 500. The human `teams directory` table does not print the list. The response's `scope` is only the deployment-wide
(GLOBAL) value of `teams.directoryScope`. It does not describe what the caller is shown once organizations
override the setting: a viewer may see the teams of an organization whose value is `platform` while `scope`
reads `organization`, and the reverse. Each team's own organization decides.

The `platform` default shows every active team's name, slug, description, organization and member count
to every signed-in user, and any listed team accepts a request. An operator keeps teams private to an
organization by setting `organization` at GLOBAL scope or for that organization.

### Requesting to join

`POST /api/v1/teams/:id/join-requests` opens a request with an optional `message` of up to 500
characters. Any active team the caller can see in the directory accepts one. The gateway refuses a
request with:

- `404 TEAM_NOT_FOUND` when the team is unknown, inactive, belongs to a deactivated organization or is
  outside the caller's scope;
- `409 ALREADY_MEMBER` when the caller is already a member;
- `409 REQUEST_PENDING` when the caller already has an open request to that team;
- `429 JOIN_REQUEST_COOLDOWN` when the caller's last request to that team was rejected within
  `teams.joinRequestCooldownHours` (default 72; `0` disables the wait), or was withdrawn within
  `teams.withdrawCooldownHours` (default 1; `0` disables the wait). The error's `details.reason` is
  `rejected` or `withdrawn`. Only a request a person decided or withdrew starts a cooldown; a request
  closed by a deactivation does not;
- `429 TOO_MANY_OPEN_REQUESTS` when the caller has `teams.maxOpenJoinRequests` open requests across all
  teams (default 5).

A request is `PENDING_TEAM` until its first decision. It then becomes `APPROVED`, `REJECTED` or
`WITHDRAWN`, or `PENDING_ORG` when the organization step applies. Final statuses never change.
`GET /api/v1/me/join-requests` lists the caller's own requests, newest first, with team and organization
names, up to the newest 200. The response's `meta.truncated` is true when the caller has more. Every
request view carries `closeReason`: `null` when a person decided or withdrew the request, otherwise the
reason a deactivation closed it. `POST /api/v1/me/join-requests/:requestId/withdraw` withdraws an open
request of the caller's. A withdrawal starts the withdrawal cooldown for that team.

### Deciding a request

The people who decide are the people who already manage membership.

- **Team step.** A holder of `team.members.manage` for the team decides: a team `LEAD` or `ADMIN`, an
  organization `ADMIN` of the team's organization, or a platform `ADMIN`. The approve route is
  `POST /api/v1/teams/:id/join-requests/:requestId/approve` with an optional `role` and `note`; the reject
  route is `.../reject` with an optional `note`. The granted role is `MEMBER` unless the approver names
  another. An approver cannot grant a role above their own rank, as with member-add. The team step
  records the chosen role on the request.
- **Organization step.** This applies only when the requester is not a member of the team's organization
  (`requiresOrgApproval`). Approving at the team step then moves the request to `PENDING_ORG` instead of
  approving it. A holder of `org.members.manage` for that organization approves or rejects it with
  `POST /api/v1/platform/organizations/:orgId/join-requests/:requestId/approve` or `.../reject`, also
  under the admin prefix. Approval creates the organization `MEMBER` membership and the team membership
  with the role the team step recorded, in one audited transaction. The organization step re-checks the
  team approver's standing before it applies that role, as described below.

A same-organization request has one decision, and approving it creates the team membership.

**Combined approval.** When the team step approves a request that needs the organization step, the
requester is not yet a member of the team, and the approver also holds `org.members.manage` for the
team's organization, one transaction records both
decisions. The request becomes `APPROVED`, the organization `MEMBER` membership and the team membership
are created, and the audit rows name both steps. The response is the reviewer view with status
`APPROVED`. Otherwise the request moves to `PENDING_ORG`, as described above.

**Organization-step re-check.** An organization-step approval first re-reads the team step's decider. If
that person is no longer active, no longer holds `team.members.manage` for the team, or is ranked below the
recorded role, the granted role becomes `MEMBER`. A team approver may grant a role up to their own rank, so
the check is against that rank. The `TeamJoinRequest` audit row of every organization-step approval carries
a `clamp` object with `clamped` (true or false), `from` (the role the team approver chose) and `to` (the
role applied), whether or not the role changed. When the requester already holds the team membership, the
approval creates no second one, the role they already hold is the granted role, `clamp.from` and
`clamp.to` are both that role, and `clamp.clamped` is false. The approval is never refused for this.

A decision is a conditional update on the status the reviewer saw, so two reviewers cannot both decide
the same request. The two approval paths lock the organization row and then the team's, the order the
other membership writes use (workflow launch locks a team before its organization; see Limitations).
Under those locks they re-read the approver's standing, the requester's organization and team
membership, and refuse an approver who no longer holds the capability, a requester who is no longer
active or a team that is no longer active. The audit rows record the authority read under the lock. A
rejection and a withdrawal take neither lock, and the conditional update alone decides them. Creating a
request takes a per-user advisory lock instead, so two requests by one person cannot both pass the
open-request cap, and under it re-reads that the requester and the team are still active; a user
deactivation takes the same lock before it closes that person's requests, so a request cannot
slip in after the close. Every write records `ConfigAuditLog` rows for the request and for any membership it
creates. Approving a request, at either step, whose requester already holds the team membership completes
the request without creating a duplicate and records the role they already hold as the granted role.

Reviewers see the queue in the Requests panel on the team space's Members tab, where the tab shows the
pending count. The same count is `pendingJoinRequests` in the team overview, for callers who hold
`team.members.manage`. The API is `GET /api/v1/teams/:id/join-requests?status=`. Organization admins see
requests awaiting the organization step in the Approvals panel on the organization page, from
`GET /api/v1/platform/organizations/:orgId/join-requests?status=`.

The in-app assistant may read the directory and the caller's own requests. It may create and withdraw a
request only after the user confirms, and it may not decide any request.

### Closing requests on deactivation

Deactivating a user or a team closes that scope's open join requests in the same transaction, and writes
an audit row for each one. A request of a deactivated requester becomes `WITHDRAWN` with `closeReason`
`REQUESTER_DEACTIVATED`. A request to a deactivated team becomes `REJECTED` with `TEAM_DEACTIVATED`, at
either step. Each closed request carries a decision note that names the reason. A close starts no cooldown.
Reactivating the user or team reopens nothing: the closed requests stay closed, and the person asks again.

The close helper also supports an organization scope (`REJECTED` with `ORGANIZATION_DEACTIVATED`), but
no deactivation path calls it: no route sets an organization inactive, so nothing closes requests on
that ground today.

### Notifications

Three notifications go out, all best effort. The module is `joinRequestNotifier.ts`, and it is called after
the transaction that caused the event commits.

| Event | Recipient | Channel |
|---|---|---|
| A request is created | The team's `slackNotifyChannel`, when it is set and Slack is configured | Slack post |
| A request is decided as `APPROVED` or `REJECTED` | The requester | Email |
| A request moves to `PENDING_ORG` | The requester, and the organization's active `ADMIN` members | Email |

Nothing is sent when `teams.joinRequestNotifications` is `false`, and a deactivation close sends nothing.
The Slack post names the requester and the team, and carries the request's message. The message is escaped
and Slack broadcast mentions are neutralized. The post links to the team's members page for review, and it
never includes the requester's email address. The emails are escaped in HTML, carry the decision note, and
link to the web app. No token or credential appears in any of them. Email uses the SMTP or Resend transport
that sign-in emails use. When neither is configured, the sends are skipped and the gateway process logs one
warning (in development and test it logs the recipient count instead). A failed send is logged and dropped;
the request and its decision stand. A request closed by a deactivation, or whose team or organization is
inactive when the notifier runs, sends nothing. The organization admins' email reaches at most the first 20
active admins and links to the organization's admin page. The Slack post needs the Slack bot token for the
channel; without one nothing is posted.

### Creating teams

Team creation is off by default. `teams.selfServiceCreation` lets any member of an active organization
create a team in it, and a platform `ADMIN` sets it. Organization administrators with `org.teams.create`
can always create one, without the limit below. The route is
`POST /api/v1/platform/organizations/:orgId/teams`. A self-service creator cannot name another person as
the team's admin.

The creator becomes the team's `ADMIN`. An operator enabling `teams.selfServiceCreation` therefore gives
every member of the organization the ability to:

- onboard repositories into the team, as long as the creator can read the repository on GitHub
  themselves (see [repositories.md](./repositories.md#who-may-onboard)), which the platform credential
  then reaches for the team's runs;
- invite people into the organization through the team's invitation route, and where the organization
  has `trustedInvites` enabled the invited accounts become active at once (see
  [inviting someone directly into a team](#inviting-someone-directly-into-a-team));
- manage the team's credentials and members.

`teams.maxCreatedPerUser` (default 3) bounds how many teams one user has created. The count covers the
creator's active teams across all organizations, while the limit applied is the one resolved for the
organization being created in. A creation past the limit is refused with `409 TEAM_LIMIT_REACHED`. Only
the self-service path records `createdById`, so a team an administrator created, or one that existed
before the feature, counts toward no one's limit. Only a platform `ADMIN` can deactivate a team, which is
why the count covers active teams only: a creator cannot free a slot by deactivating a team.

### Settings

The keys are declared in the setting registry and edited at `/admin/platform-settings`. None is run-pinned.

| Key | Default | Scopes | Meaning |
|---|---|---|---|
| `teams.directoryScope` | `platform` | GLOBAL, ORGANIZATION | Which teams the directory lists: `platform` or `organization`. An organization's own value decides its teams; an organization with none uses the GLOBAL value. |
| `teams.selfServiceCreation` | `false` | GLOBAL, ORGANIZATION | Whether members may create teams in the organization. |
| `teams.maxCreatedPerUser` | `3` | GLOBAL, ORGANIZATION | Active teams one user may have created through self-service creation, across organizations (1 to 100). |
| `teams.maxOpenJoinRequests` | `5` | GLOBAL | Open join requests one user may hold across all teams (1 to 50). |
| `teams.joinRequestCooldownHours` | `72` | GLOBAL | Hours after a rejection before the same team accepts a new request (0 to 720). |
| `teams.withdrawCooldownHours` | `1` | GLOBAL | Hours after a person withdraws a request before that team accepts a new one from them (0 to 720). |
| `teams.joinRequestNotifications` | `true` | GLOBAL | Whether join-request notifications are sent: the requester's decision email, the Slack post on a new request, and the organization admins' email. `false` sends none. |

## Limitations

- **Workflow launch and a join-request approval can deadlock.** An approval locks the organization row
  and then the team's, as the other membership writes do; workflow launch locks a team and then its
  organization, and also locks the launching user's row, which an approval's membership insert needs
  a share lock on. A launch and an approval on the same team that overlap can make Postgres abort one
  of them (`deadlock detected`), which the caller sees as a server error and can retry.
- **The directory lists at most 500 organizations in its filter.** `organizationsTruncated` says when
  more exist; the team list itself is paged and unaffected.
- **Team secrets are not usable by agents, shell steps or container steps.** They reach only setup
  steps and app previews, so a credential an agent needs must come from somewhere else.
- **Rotating a team secret does not warn about shadowing.** When a repository secret of the same
  name wins, the only signal is the `shadowed` flag on the repository's setup-secrets listing.
- **Team secrets have no CLI commands.** They are managed through the API and the Team secrets panel
  only.
- **A repository whose setup comes from its checkout is open to anyone who can push to it.** Granting
  a team secret to such a repository lets whoever can push a branch and launch a run name that
  secret and run steps with it. Grant team secrets only to repositories whose contributors the team
  trusts, or store the setup definition on the repository so that only shell authors can change it;
  see [repositories](./repositories.md#limitations).

- Organization admins manage linked GitHub installations from **Admin → Organizations → the
  organization → GitHub**. Connect authorizes a new installation of the instance App, and Retire
  prevents new runs through it. Existing runs continue. Only platform admins can reactivate,
  unlink or relink installations. Self-service does not support per-host Apps or claiming an
  installation already registered; see [GitHub App setup](./github-app-setup.md#connecting-an-organization).

- Team invitations require a new email address; existing users are added through the member-add
  route. A failed invitation email does not roll back the account or memberships.

- **Engineers see failures only for runs they launched, or that a lead assigned to them.** A lead
  does not see a failure on a teammate's run in the desk, and a run the caller controls but did not
  launch is excluded unless it was assigned.
- **Expired approvals are not in Needs you.** An expired step cannot be answered, so the actionable
  filter drops it, and the desk has no separate place for it.
- **The caps and the counts differ.** `items` stops at 25; a team's `needsYou` and the `total` count
  everything, so a team badge can exceed what the list shows.
- **Attention is computed in memory.** The latest-attempt and running-request queries load every
  visible matching row and bucket it by team in the gateway, so a caller with very many requests
  pays for all of them on each read. The running-request query reads every request on the
  caller's teams that has a running attempt, not only the caller's own.
- **Old failures and merges age out.** Only attempts started in the last 30 days
  (`ATTEMPT_WINDOW_DAYS` in `gateway/src/lib/meSummary.ts`) are read, plus any attempt still
  running, so a failure older than that is not listed. Approvals have no such bound.
- **Deactivated teams are left out.** A team that is not active has no card, and work that sits
  only under it is in neither the list nor the counts, nor in `mine=true`.
- **Platform ADMIN approvals are wider elsewhere.** The approvals page and the sidebar badge are
  platform-wide for an ADMIN; the desk is member-scoped, so the two totals differ for them.
- **`lastTeamSlug` does not choose the landing page.** The dashboard lands on My desk, not the last
  team space opened.
- **Overview of a deactivated team.** The overview endpoint answers for a deactivated team to a
  member; the dashboard's team lists leave deactivated teams out.
- **The desk refreshes by polling.** It re-reads every 20 seconds and after the caller answers an
  approval, cancels, retries or launches work; the approvals event stream does not refresh it.
- **`queued` is a ledger state, not a scheduler queue.** The platform has no run queue; a run is
  counted as queued while its ledger row is still `STARTING`.
- **No per-team override of the due-soon window.** `workflow.approvalDueSoonHours` is GLOBAL only.
- **`launchBudget` is the status of one cap, not of a launch.** It reads the owning team's cap and
  its organization's at the time of the request; a launch can still be refused for a reason it does
  not show (access, a view-only share). A repository the caller cannot start work on carries none.
- **`ownerTeam` names the repository's owner only.** A run with no repository (a template run
  against a team, a channel run) has `ownerTeam` `null` even when a team is attributed its spend.
- **`canAnswer` covers human steps, not every control.** Cancelling a run is guarded by the same
  control rule, but run detail exposes it only for the review fix retry (`canControl`).
- **A team ADMIN can lift a cap an organization ADMIN set.** `PATCH /teams/:id/budget` lets a team ADMIN
  clear or raise the team's cap whoever set it, so the team cap is a self-imposed limit, not an
  organization control. It does not check that the team is active.
- **Two month-spend figures.** The overview's `admin.monthCostUsdCents` sums runs by the month they
  started in, over the runs the caller may see; `teamMonthSpend`, which the cap and
  `GET /teams/:id/budget` read, counts by the month a run ended in and adds in-flight and runless
  spend. They differ around month boundaries and for runs the caller cannot see.
- **Cancelling a run without its workflow finalizing drops its ledger spend.** The cancel path that
  ends a run before the workflow finalizes it (`workflowFinalizes` false) sets `endedAt` without
  `costUsdAccrued`, so the run's ledger spend leaves both the organization's and the team's totals.
- **Evaluation and PR-evaluation starts are covered only mid-run.** See
  [launch paths](#launch-paths-and-the-team-cap).
- **The team cap is best-effort under concurrency**, exactly like the organization's. Spend is
  recorded after a launch returns, so launches that arrive together read the same total, and a
  running run can spend past the cap until the mid-run guard's cache window (about 30 s) catches up.
- **Budget notifications are best-effort and Slack only.** A team without `slackNotifyChannel`, or a
  deployment without a Slack bot token, gets none, and a post that fails is retried only at the next
  evaluation (a model call after the cache window), so a team that stops running may never be told.
  A notice is not evaluated by the launch gate: a team whose spend crosses a level with no run in
  flight hears of it at the next run's first model call.
- **A permanent post failure suppresses that level for the month.** After one, fixing the channel
  or the token sends nothing until the next month.
- **The claim can outlive a failed send, or a send can repeat.** A worker that dies between taking
  the claim and posting leaves the claim held, so that level is never sent that month. A post that
  succeeds on Slack's side but throws locally (a timeout reading the response) releases the claim,
  so the next evaluation sends the notice again.
- **A level is sent once per month even if the cap changes.** Raising the cap after `CAP_REACHED`
  and reaching it again in the same month sends nothing further, and a team that jumps past its
  threshold to the cap in one window gets the cap notice and no warning.
- **Runs without an owning team count against no team cap.** A run with no `attributedTeamId` (a
  row from before the column, or a run no team can be derived for) is in the organization's spend
  and in no team's.
- **There is no per-sharee spend split.** A sharee's launches add to the owner's spend with no
  breakdown by launching team; the launcher's name is on the run.
- **A run is billed whole to the month it ends in**, for the team as for the organization, so a run
  that crosses a month boundary lands entirely in the later month.
- **Dollars are team ADMIN's by design.** `GET /teams/:id/budget` returns the team's own month spend
  in dollars to a team ADMIN even when the organization has a cap they cannot read, because the
  team's spend is a slice of the organization's and the cap itself is not revealed. In an
  organization with a single team that slice is the whole spend, and with the organization meter's
  percentage it gives the cap away: the overview's withholding rule narrows the channels and does
  not seal the organization's cap there.
- **The meter is not a secrecy boundary for the cap.** The percentage is rounded to one decimal and
  the dollars are an organization ADMIN's to read, so on its own it gives pace and state, not an allowance.
  Someone who also sees a dollar figure of the organization's spend elsewhere could work the cap
  out. The team overview therefore leaves `admin.monthCostUsdCents` out for a team ADMIN who is not
  an organization ADMIN of a capped organization, and an organization report digest carries dollars only
  when its creator is an organization ADMIN and every target is an email to an organization ADMIN. A team's own spend
  is not the organization's, so this narrows the channels and does not prove the cap secret.
- **Shared-repository pull requests count in a sharee's list, not in its outcomes.** The overview's
  `openPullRequests` includes pull requests on a repository shared to the team, while `pullRequests`
  (opened, merged, merge rate) counts only runs the team owns, so a shared repository is counted
  once, by its owner.
- **Unowned failures are a launcher test until a lead assigns one.** A failure counts when its
  launcher left the team or is unknown (a run launched by automation or a deleted account). An
  assignment records who takes it over and moves no credential. A failure older than 30 days is not
  read.
- **My work numbers and their links can differ.** The figures follow the desk's rules (launched or
  assigned, requested by the caller), while the links open lists filtered by who requested the work.
  A matching list filter for the My work counts does not exist, so a link cannot show the figure's rows.
- **The Start work link cannot name a repository.** It carries the team only (`/start?team=<slug>`),
  so a repository's own Start work link cannot preselect it.
- **The nudge reaches only the thread's followers.** It is a plain thread reply, so it notifies the
  people following that thread, not the approvers by name and not the channel. A step whose
  announcement was not posted to Slack cannot be nudged at all. No in-app reminder exists.
- **No notification of a budget request.** A pending request reaches the team's admins only when they
  open Settings, Budget or call the list; nothing pages or messages them.
- **The failure list holds at most 100 items.** `GET /api/v1/teams/:id/attention/failures` returns the
  newest 100 without a total, while the lead panel's `unownedFailures` counts every one of them, so
  the count can exceed the list.
- **`last7d` counts requests by their latest attempt.** A request first started earlier and retried
  inside the window counts as started; one started inside the window and retried later is judged on
  the retry.
- **Cost is an attribution in the organization's currency units, not an invoice.** `monthCostUsdCents`
  sums the cost accrued on runs attributed to the team since the start of the UTC month, as the
  platform priced them; it is not a billing statement and a shared repository's runs are the owner's.
- **The overview refreshes only when read.** It carries no event stream and is as current as the
  request that built it.
- **Repositories are capped at 200** on the overview; the repository list is the complete view.
- **A request asks for a team, not a role.** The requester cannot ask for a role; the approver chooses it
  when approving.
- **The requester's own list shows the newest 200 requests.** `meta.truncated` says when older requests
  exist, and there is no way to list them.
- **The default `teams.directoryScope` exposes the directory platform-wide.** Until an operator sets
  `organization`, at GLOBAL scope or for an organization, every signed-in user sees every active team's
  name, slug, description, organization and member count, and can ask to join any of them.
- **Notification delivery is not retried and not recorded.** A failed send is only logged.
- **A team with no `slackNotifyChannel` posts nothing on a new request**, so its reviewers rely on the queue.
- **Reactivating a user or team does not reopen requests that were closed by the deactivation.**
- **An organization deactivated outside the API keeps its join requests open.** No route deactivates an
  organization, so nothing closes its requests when one is deactivated by other means (for example
  directly in the database). The requests stay open, keep counting toward each requester's open-request
  cap, and the approval paths do not check the organization's active flag.
- **The organization-admin email reaches the first 20 active organization admins.** A larger organization's
  remaining admins are not emailed, and the omission is logged.
