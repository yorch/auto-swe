# Pull requests and tickets

Two dashboard views answer questions the request list does not: *which pull requests are open, and
where do they stand?* and *what happened under this ticket?* Both read from what the platform
already records. This document covers the recorded pull-request lifecycle, the two list APIs, and
how visibility is applied to every row and every aggregate.

---

## 1. Pull-request lifecycle

Every pull request the platform opens has one `PullRequest` row, created when the host accepts the
PR: by the `createOrUpdatePullRequest` activity for a workflow's PR step, and by `runAgentTask` for
the draft PR of an Agent Run with `deliver=draft_pr`. The row links to a ledger row
(`ActiveWorkflow`): the workflow step prefers the row of its own execution and falls back to any
ledger row of the same request when the execution keeps none; the Agent Run step requires its own
row (it refuses to run without one) and links that. The row records:

| Column | Meaning |
|---|---|
| `status` | `OPEN`, `MERGED`, or `CLOSED` (closed without merging) — `PULL_REQUEST_STATES` in `@auto-swe/shared/lib/pullRequest` |
| `isDraft` | whether the PR is a draft; set from how the worker opened it, then followed from the host |
| `title` | the title as opened, capped at 300 characters |
| `openedAt` / `mergedAt` / `closedAt` | when the PR was opened, merged, and closed (a merge sets both of the last two) |
| `ciStatus`, `headSha` | the CI verdict for the current head, unchanged by this lifecycle |

Only an `OPEN` row for the same request and repository is updated on a re-push. A request can have
several ledger rows (re-runs, and scheduled fires, which share one standing request and one branch),
so the choice is explicit: the open PR on the executing workflow's own ledger row, else the newest
open one of the request (`openedAt`, then `id`, descending). A close is a
decision, so it is respected within the workflow that opened the PR: when `createOrUpdatePullRequest`
runs again in a workflow whose latest PR for the repository was closed without merging, it fails
non-retryably with `PR_CLOSED_BY_REVIEWER` instead of opening a replacement. A new run of the same
request has its own ledger row, is not stopped by that close, and opens a new PR; the old row stays as
history.

An Agent Run is a new workflow each time, so the close guard does not apply to it: it opens one PR
per run, on its own branch, and inserts one row for it. The row is only ever inserted, never
updated: the host has just opened a new PR, so an existing row with the same (repository, number)
belongs to a different one. A failure to write it, including the unique index on (repository, number)
refusing a collision, is logged and recorded on the run as a `pr.record_failed` activity event, and
does not fail the run, because the branch is already pushed and the PR open.

### 1.1 Webhook events

`POST /api/v1/webhooks/git` follows the host's `pull_request` events for rows that already exist:

| Event | Effect |
|---|---|
| `closed`, merged | `OPEN` or `CLOSED` → `MERGED`, `mergedAt` and `closedAt` set, the workflow signalled and the merge side effects run (evals label, Slack, tracker) |
| `closed`, not merged | `OPEN` → `CLOSED`, `closedAt` set. The workflow is not signalled |
| `reopened` | `CLOSED` → `OPEN`, `closedAt` cleared. A merged PR is never reopened |
| `ready_for_review` / `converted_to_draft` | `isDraft` set to false / true |
| `edited` | `title` refreshed from the payload when it carries one |

Every other action is ignored. The handler updates the row matched by (repository, PR number) and
never creates one: a pull request opened outside the platform has no row and is not recorded.

The rest of the contract is the same as for every webhook delivery:

- The delivery is bound to the host its secret proved, exactly as for a merge, so a payload naming a
  repository on another host changes nothing (see [repositories.md](./repositories.md)).
- Every status transition is guarded on the row's current status (merge from `OPEN` or `CLOSED`,
  close from `OPEN`, reopen from `CLOSED`), so a redelivered event finds the row already changed and
  does nothing. `MERGED` is terminal: the transition into it is the claim, and only the delivery that
  wins it signals the workflow, so a redelivered merge cannot run the merge side effects twice. A
  failed signal restores the row's previous status. Draft and title updates are plain idempotent
  sets, not status-guarded.
- The title is host text, untrusted: it is trimmed and capped on write, and every surface renders it
  as plain text.

---

## 2. `GET /api/v1/pull-requests`

Newest first, paginated like `GET /work-requests` (`limit`, `offset`; `meta.total`).

| Parameter | Values | Default |
|---|---|---|
| `state` | `OPEN`, `MERGED`, `CLOSED`, `all` | `all` |
| `draft` | `any`, `draft`, `ready` | `any` |
| `repoId` | a repository id | any |
| `ticket` | substring of the external ticket id, case-insensitive | any |
| `scope` | `MINE` (requests the caller made) or `TEAM` (everything visible) | `MINE` |
| `teamId` | narrow to a team's repositories, including ones shared with it | any |

A row carries the repository (`id`, `org`, `name`), `prNumber`, `url`, `title`, `status`,
`isDraft`, `ciStatus`, `openedAt`/`mergedAt`/`closedAt`, and — from the ledger row the PR belongs
to — `ticketId`, `workRequestId`, `costUsd` and `latestRun` (`id`, `status`).

`url` is derived in one place, `pullRequestUrl()` in `@auto-swe/shared/lib/pullRequest`, from the
repository's own web base (so a repository on another host links to that host) and is null unless
that base is an http(s) address. The request list and the workflow page use the same function.

**Visibility.** A row is listed when the caller may reach the PR's repository
(`reachableConnections`, so a shared team counts and the permission gate applies); an ADMIN sees
every row. The ledger-derived fields are read only when the ledger row is on that same repository,
and `latestRun` only when the caller may see the run (`buildWorkflowRunVisibilityFilter`), so a
visible PR never discloses a run, request or cost the caller could not list themselves. `total`
counts the same filtered set.

---

## 3. `GET /api/v1/tickets`

Groups everything filed under one `externalTicketId`. The grouping, the ordering and the paging are
done in the database (`groupBy` over the matching requests), so a call reads one page of groups, not
every request. Groups are ordered by the creation time of their newest matching request, newest
first, then by ticket id; `meta.total` is the number of groups. Each page's aggregates are then read
for that page's tickets only.

| Parameter | Values | Default |
|---|---|---|
| `includeAutomated` | `true` / `false` | `false` |
| `search` | substring of the ticket id or the request description | none |
| `scope`, `teamId` | as for pull requests | `MINE` |

`search`, `scope` and `teamId` choose **which tickets are listed**. The figures for a listed ticket
cover all of its visible requests, not only the ones the filter matched, so searching for a request
does not shrink its ticket's cost or run counts.

A group carries the ticket id, `title`, `status` and `url`, `requestCount`, `runCounts` by run
status, the `latestRun`, the `pullRequests` (repository, number, state, draft, link), the summed
`costUsd`, `latestWorkRequestId` and `lastActivityAt` (the creation time of the group's newest
matching request; a later run of an old request does not move it).

**Automated work is hidden by default.** The ids these launches file are correlation keys, not
tickets, so unless `includeAutomated=true` the list leaves them out, and a listed ticket's requests,
runs, cost and pull requests leave them out too:

- requests with an agent run (a run of a template whose origin is the agent-run origin);
- requests with a Channel Assistant or Channel Task run, or any run in a Slack channel;
- requests whose ticket id the platform generated (`RunInput.ticketIsSynthetic`): a template launch
  that named no ticket and filed the request's own id, a PRD run (`PRD-<id>`), a scheduled work
  request (`<prefix>-SCHED-<id>`), a channel task (`slack-<channel>-<thread>`), and a PRD story given a generated id because the tracker did not
  assign one. A tracker- or user-supplied id is never flagged. Agent runs and channel tasks are
  flagged as well as recognised by their template or channel.

A request flagged `ticketIsSynthetic` names no tracker issue, so none of the tracker syncs (PR opened,
workflow started, CI verdict, merge, workflow finished) is attempted for it, and neither is the
knowledge-base PR link write-back, which would otherwise search the knowledge base for a page
matching the generated id. A Channel Assistant
turn files no request of its own, so there is nothing to flag. The Slack merge note and
the merge evaluation row do not depend on the tracker and still run.

**Visibility is per row.** A request is in scope when the caller requested it, when the caller can
see one of its runs (`buildWorkflowRunVisibilityFilter`, the rule `GET /workflow-runs/requests`
lists by), or when the caller reaches a repository it has a ledger row on or targets. Within a
group:

- runs are counted through the run rule;
- ledger rows (cost) and pull requests count only on repositories the caller can reach;
- an ADMIN sees everything.

The cost and PRs of a cross-repo epic therefore split by team: a member of one repository's team
sees that repository's child, not the epic's own ledger row, not another repository's child. A
`teamId` filter matches a request only through a repository the caller can reach (a ledger row, the
request's target, or a run the caller sees whose repository it is), so it can never reveal that a
ticket touches a team's repository the caller cannot reach, even when the caller sees one of its runs
through a template. A ticket with no visible request does
not appear or count toward `meta.total`.

**Tracker text.** `title` and `status` are the tracker's answer when the newest visible request that
has one was submitted (`ContextSnapshot.rawTicketData`). They are untrusted text, capped, and
rendered as plain text. `url` is returned only for an http(s) address; anything else is null.

---

## 4. Dashboard

The Work group of the sidebar lists **Pull requests** (`/pull-requests`) and **Tickets**
(`/tickets`). Filters live in the address, so a filtered list can be bookmarked and survives a
reload.

- **Pull requests** — a table with the state (Open, Draft, Merged, Closed) and CI badges, the ticket
  (linked to its request), the latest run, cost and age. Filters: scope, state (Open unless the
  address says otherwise), draft, repository, ticket. The PR links to the host in a new tab.
- **Tickets** — a table with the tracker status, request and run counts, the latest run, PR count,
  cost and last activity. A "Hide automated runs" checkbox is on by default. A row expands to the
  latest request and its pull requests with their states.

Titles, ticket ids and tracker text render as plain text; a ticket link is followed only for an
http(s) address.

---

## Limitations

- A PR closed by a reviewer is not replaced by a re-push in the same workflow; the run fails until
  the PR is reopened or the request is run again.
- Pull requests opened outside the platform are not listed: a webhook only updates a row the
  platform created.
- Review decisions (approvals, requested changes) are not tracked; the state is open, merged or
  closed, plus draft.
- A close without a merge is recorded but does not signal the workflow, so a run waiting on a human
  merge keeps waiting until it times out or is cancelled.
- Close and reopen events are applied in arrival order. If a `reopened` is lost, or arrives before
  the `closed` it follows, the row reads `CLOSED` for a PR that is open until the next merge or close
  event corrects it. A merge is still recorded from either state. Because the close guard reads that
  row, a lost `reopened` also makes a re-push in that workflow fail with `PR_CLOSED_BY_REVIEWER`
  although the PR is open on the host.
- The close guard finds a PR through the execution's own ledger row linked to its request. An
  execution with no such row (a self-registered ledger row with no request, an unmatched scheduled
  anchor) is not covered and may open a new PR after a close.
- A ticket's title, status and link are a snapshot from submit time, and exist only when a tracker
  is configured; they do not follow later edits in the tracker.
- `meta.total` for tickets is the number of groups, which the database counts by listing them; a
  deployment with a very large number of distinct tickets pays for that on each read.
- A repository's PR number is unique per connection row, but the webhook lookups match a repository
  by owner and name (and host), which can cover more than one connection row. The lookups order by
  `openedAt` then `id`, newest first, so the newest row wins. If an older row still holds a PR number
  after a repository was repointed or recreated, a new Agent Run PR with that number is not
  tracked (the insert is refused and traced), and the older row is never altered.
- A launch that names its own ticket label is indistinguishable from a real ticket and is not
  treated as automated.
- A requester who reaches none of a request's repositories sees the ticket and its runs but not its
  cost or pull requests, which are judged by repository.
- A ticket whose requests are all visible only through a team-owned template is listed too, as in
  `GET /workflow-runs/requests`.
- The list APIs are not exposed through the CLI or the MCP endpoint.
