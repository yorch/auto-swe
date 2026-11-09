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
| `lead` | `lead`, `admin` | `unownedFailures`, `staleApprovals`, `openPullRequests` |
| `admin.monthCostUsdCents` | `admin` | This calendar month's spend (UTC) attributed to the team, in cents; `null` when it cannot be computed |

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

Both overview endpoints are read by the dashboard, and they wrap differently: the overview returns
`{ "data": { … } }`, while `GET /api/v1/me/summary` returns the desk bare, with no `data` envelope.
A client unwraps each as its own shape.

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

- **Team switcher.** The top bar holds a switcher that lists **My desk** first and then the teams
  the caller is a member of, sorted by name, each with the caller's role in it and a badge with what
  is waiting on them there (the team's `needsYou` from `GET /api/v1/me/summary`). Choosing a team
  opens its space on the tab the caller is already on. The switcher is for moving around; it narrows
  nothing.
- **Sidebar Teams group.** The sidebar lists the member teams as links to their spaces, each with the
  same badge: the teams the user pinned first, in pin order, else the member teams up to a limit.
- **Preferences.** `PATCH /api/v1/me/preferences` stores two per-user hints beside the run-detail
  layout. `lastTeamSlug` is the last member team space the user opened. `pinnedTeamSlugs` is an
  ordered list of up to 20 slugs that the sidebar shows. Neither is checked against existing teams or
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

---

## Limitations

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
- **`lastTeamSlug` is stored, not acted on.** The dashboard records the last team space opened but
  does not yet use it to choose where to land.
- **Pins have no control in the dashboard.** `pinnedTeamSlugs` is read by the sidebar and set through
  `PATCH /api/v1/me/preferences`; there is no pin button.
- **Knowledge is not narrowed by `?team=`.** On the knowledge page the parameter preselects the team
  for new items; the list itself is not filtered.
- **Overview of a deactivated team.** The overview endpoint answers for a deactivated team to a
  member; the dashboard's team lists leave deactivated teams out.
- **The desk refreshes by polling.** It re-reads every 20 seconds and after the caller answers an
  approval, cancels, retries or launches work; the approvals event stream does not refresh it.
- **`queued` is a ledger state, not a scheduler queue.** The platform has no run queue; a run is
  counted as queued while its ledger row is still `STARTING`.
- **No per-team override of the due-soon window.** `workflow.approvalDueSoonHours` is GLOBAL only.
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
