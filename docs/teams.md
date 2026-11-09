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
- **The desk refreshes by polling.** It re-reads every 20 seconds and after the caller answers an
  approval, cancels, retries or launches work; the approvals event stream does not refresh it.
- **`queued` is a ledger state, not a scheduler queue.** The platform has no run queue; a run is
  counted as queued while its ledger row is still `STARTING`.
- **No per-team override of the due-soon window.** `workflow.approvalDueSoonHours` is GLOBAL only.
