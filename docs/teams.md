# Teams and the personal desk

A person belongs to one or more teams, and the dashboard's Home is their **desk**: the teams they
are a member of and what is waiting on them across all of them. This document covers what the desk
contains, who sees what, and how its counts agree with the lists behind them.

---

## 1. My desk

`GET /api/v1/me/summary` (ENGINEER and above) returns the whole desk in one response:

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
| `failed_run` | The latest attempt of a request, when it failed or timed out **and the caller launched that attempt** | The person who launched it |
| `pr_merge` | A request the caller **requested** whose pull request is open and awaiting a human merge | The requester |

The due-soon window is the registry setting `workflow.approvalDueSoonHours` (default 24 hours,
GLOBAL scope). Due-soon approvals come first, soonest deadline first; everything else follows,
newest first. `dueAt` carries an approval's deadline whether or not it is due soon.

Approvals are exactly the steps `GET /api/v1/human-steps?actionable=true&mine=true` lists, built by
one function (`deskHumanStepWhere()` in `gateway/src/lib/meSummary.ts`, over `humanStepListWhere()`).
`mine=true` applies the same member-scope term as the desk: it keeps only steps on runs of the
caller's own teams' work (a repository one of their teams owns or is shared, or a template one of
their teams owns). For an ENGINEER it changes little; for a platform ADMIN it is what makes the list
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
| Owning team member | Steps on runs they control | Attempts they launched | Requests they made |
| Member of a team the repository is shared to | None on the owner's runs (visible, not controllable) unless they launched the run | Attempts they launched | Requests they made |
| Platform ADMIN | Only for teams they are a member of | Same | Same |

## 2. Team overview

`GET /api/v1/teams/:id/overview` (ENGINEER and above) is one team's landing page in one response.
The caller must be a **member** of the team or a platform ADMIN; anyone else, and any unknown id,
gets the same `404 TEAM_NOT_FOUND`. It is built by `buildTeamOverview()` in
`gateway/src/lib/teamOverview.ts`.

### The view is decided by the team role

`viewerLevel` comes from the caller's role **in this team**, never from the platform role:

| Team role | `viewerLevel` |
|---|---|
| `ADMIN` | `admin` |
| `LEAD` | `lead` |
| `ENGINEER` | `engineer` |
| none (platform ADMIN who is not a member) | `admin`, and `team.myRole` is `null` |

A platform LEAD (or ADMIN) whose role in the team is `ENGINEER` gets the `engineer` view. A platform
role of LEAD does not raise anything for a non-member: only the platform ADMIN is let in.

### What it contains

| Field | For | Meaning |
|---|---|---|
| `team` | everyone | `id`, `slug`, `name`, `orgId`, `orgName`, the caller's `myRole` |
| `needsYou.total` | everyone | The caller's own items on this team's work, by the desk's rules ([§1](#what-needs-you-contains)) scoped to this team. Its approvals are exactly `GET /api/v1/human-steps?actionable=true&teamId=<team>` |
| `running`, `queued` | everyone | Requests running on the team's work, split as the desk's team cards split them |
| `last7d` | everyone | `started`, `succeeded`, `failed`: requests whose latest attempt started in the last 7 days on repositories the team owns or that are shared to it |
| `pullRequests` | everyone | Last 30 days, owner-attributed: `opened`, `merged`, `closedUnmerged`, `mergeRate`, `timeToMergeP50Hours`. The same filters and summary as `GET /api/v1/pull-requests/outcomes?scope=TEAM&teamId=` (`teamPullRequestOutcomes()` in `gateway/src/lib/pullRequestOutcomesQuery.ts`) |
| `activity` | everyone | Up to 10 recent requests the caller may see on the team's work: `title`, `state` (`active`, `attention`, `success`, `failed`), repository, the launcher's **name**, time. Cancelled and skipped attempts are left out |
| `repos` | everyone | Active repositories the team owns or that are shared to it, that the caller may reach (membership and the access gate): `relation` is `owned` or `shared`, and a shared one names the owning team |
| `budget` | everyone | The budget that binds work on the team's repositories: `scope`, `state`, `percentUsed`, `alertThresholdPercent`. Percent only, for every viewer level ([the budget meter](#the-budget-meter)); `null` when neither the team nor its organization sets a cap |
| `lead` | `lead`, `admin` | `unownedFailures`, `staleApprovals`, `openPullRequests` |
| `repos[].canLaunch` | everyone | `false` when the repository is shared to the team view-only; always `true` for an owned one |
| `admin.monthCostUsdCents` | `admin` | This calendar month's spend (UTC) attributed to the team, in cents; `null` when it cannot be computed. Absent for a team ADMIN who is not an ORG_ADMIN when the binding cap is the organization's; present when the team's own cap binds |

`lead` and `admin` are **absent** from the JSON for a lower view, not `null`, and their queries are
not run. Other members' emails never appear: a launcher is a display name only.

Definitions:

- **Unowned failure.** A request on the team's work (last 30 days, as visible to the caller) whose
  latest attempt failed or timed out and whose launcher is no longer a member of the team or is
  unknown. A multi-repository request counts each failed repository.
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
role: dollars are read by an ORG_ADMIN (or platform ADMIN) at `GET /api/v1/platform/organizations/:orgId/budget`.
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
| Overview | `/teams/<slug>` | every member, and a platform ADMIN | The overview of [§2](#2-team-overview): the numbers, the lead and admin panels the server sent, recent activity and repositories |
| Work | `/teams/<slug>/work` | every member | One team's requests, pull requests, tickets and epics, through the same lists as the global pages, narrowed to the team |
| Automations, Reports, Knowledge | `/teams/<slug>/automations`, `…/reports`, `…/knowledge` | every member | A short panel with a link to the existing page, which reads `?team=<slug>` and narrows itself |
| Members | `/teams/<slug>/members` | every member | The team's membership |
| Settings | `/teams/<slug>/settings` | a team `LEAD` or `ADMIN`, and a platform ADMIN | The team's configuration: general details, service principals, automation and the sandbox |

The Settings tab is hidden from everyone else and its address answers not found. Which sections of
the Overview appear is decided by the server from the team role ([§2](#the-view-is-decided-by-the-team-role)),
never by the tabs.

A platform ADMIN may open the space of a team they are not a member of by its address. The overview
answers for them (`team.myRole` is `null`) and the global pages' `?team=` filter resolves the team
for them ([§4](#4-the-team-filter-on-global-pages)). That does not put the team in their navigation:
the switcher, the sidebar and the badges list only the teams they belong to.

### Navigation

- **Team switcher.** The top bar holds a switcher that lists **All my teams** first and then the teams
  the caller is a member of, sorted by name, each with the caller's role in it and a badge with what
  is waiting on them there (the team's `needsYou` from `GET /api/v1/me/summary`). Choosing a team
  opens its space on the tab the caller is already on. The switcher is for moving around; it narrows
  nothing. It appears on Home, work lists, Start work and team spaces, plus the team-aware Workflow
  library, Knowledge, Automations and Reports pages. Other configuration, account, Docs and Admin
  pages, and focused editor/run/diff routes, omit both the top-bar switcher and its mobile strip.
  The Home page title remains **My desk**.
- **Sidebar Teams group.** The sidebar lists the member teams as links to their spaces, each with the
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
| `GET /api/v1/teams/:id/budget` | team `ADMIN`, `ORG_ADMIN` of the team's organization, platform `ADMIN` | The cap, the alert threshold (1 to 100) and this month's spend in cents |
| `PATCH /api/v1/teams/:id/budget` | the same | Set or clear (`null`) either; the cap is a whole number of cents from 0 up, and 0 refuses every launch. Audited |
| `GET /api/v1/teams/:id/budget/status` | any member of the team, and the same three roles | The binding status, percent and state only |

A team `LEAD` and a platform `LEAD` are refused the first two (`403`). A caller with no standing on
the team gets the `404 TEAM_NOT_FOUND` an unknown team gets. The responses are wrapped in `data`.
The team ADMIN reads the team's own spend in dollars here because the cap is theirs; the
organization's cap and spend stay an ORG_ADMIN's.

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

## Limitations

- Organization admins manage linked GitHub installations from **Admin → Organizations → the
  organization → GitHub**. Connect authorizes a new installation of the instance App, and Retire
  prevents new runs through it. Existing runs continue. Only platform admins can reactivate,
  unlink or relink installations. Self-service does not support per-host Apps or claiming an
  installation already registered; see [GitHub App setup](./github-app-setup.md#connecting-an-organization).

- **Engineers see failures only for runs they launched.** A lead does not see a failure on a
  teammate's run in the desk, and a run the caller controls but did not launch is excluded.
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
- **A team ADMIN can lift a cap an ORG_ADMIN set.** `PATCH /teams/:id/budget` lets a team ADMIN
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
  the dollars are an ORG_ADMIN's to read, so on its own it gives pace and state, not an allowance.
  Someone who also sees a dollar figure of the organization's spend elsewhere could work the cap
  out. The team overview therefore leaves `admin.monthCostUsdCents` out for a team ADMIN who is not
  an ORG_ADMIN of a capped organization, and an organization report digest carries dollars only
  when its creator is an ORG_ADMIN and every target is an email to an ORG_ADMIN. A team's own spend
  is not the organization's, so this narrows the channels and does not prove the cap secret.
- **Shared-repository pull requests count in a sharee's list, not in its outcomes.** The overview's
  `openPullRequests` includes pull requests on a repository shared to the team, while `pullRequests`
  (opened, merged, merge rate) counts only runs the team owns, so a shared repository is counted
  once, by its owner.
- **Unowned failures are a launcher test, not an ownership record.** A failure counts when its
  launcher left the team or is unknown (a run launched by automation or a deleted account); nobody is
  assigned it, and a failure older than 30 days is not read.
- **`last7d` counts requests by their latest attempt.** A request first started earlier and retried
  inside the window counts as started; one started inside the window and retried later is judged on
  the retry.
- **Cost is an attribution in the organization's currency units, not an invoice.** `monthCostUsdCents`
  sums the cost accrued on runs attributed to the team since the start of the UTC month, as the
  platform priced them; it is not a billing statement and a shared repository's runs are the owner's.
- **The overview refreshes only when read.** It carries no event stream and is as current as the
  request that built it.
- **Repositories are capped at 200** on the overview; the repository list is the complete view.
