# Pull requests and tickets

Two dashboard views answer questions the request list does not: *which pull requests are open, and
where do they stand?* and *what happened under this ticket?* Both read from what the platform
already records. This document covers the recorded pull-request lifecycle, the two list APIs, and
how visibility is applied to every row and every aggregate.

---

## 1. Pull-request lifecycle

Every pull request the platform opens has one `PullRequest` row, created by the
`createOrUpdatePullRequest` activity when the host accepts the PR. The row records:

| Column | Meaning |
|---|---|
| `status` | `OPEN`, `MERGED`, or `CLOSED` (closed without merging) — `PULL_REQUEST_STATES` in `@auto-swe/shared/lib/pullRequest` |
| `isDraft` | whether the PR is a draft; set from how the worker opened it, then followed from the host |
| `title` | the title as opened, capped at 300 characters |
| `openedAt` / `mergedAt` / `closedAt` | when the PR was opened, merged, and closed (a merge sets both of the last two) |
| `ciStatus`, `headSha` | the CI verdict for the current head, unchanged by this lifecycle |

Only an `OPEN` row for the same request and repository is updated on a re-push. A close is a
decision, so it is respected within the workflow that opened the PR: when `createOrUpdatePullRequest`
runs again in a workflow whose latest PR for the repository was closed without merging, it fails
non-retryably with `PR_CLOSED_BY_REVIEWER` instead of opening a replacement. A new run of the same
request has its own ledger row, is not stopped by that close, and opens a new PR; the old row stays as
history.

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

Groups everything filed under one `externalTicketId`, ordered by last activity (the newest of a
request's creation and its runs' start). Paginated over groups.

| Parameter | Values | Default |
|---|---|---|
| `includeAutomated` | `true` / `false` | `false` |
| `search` | substring of the ticket id or the request description | none |
| `scope`, `teamId` | as for pull requests | `MINE` |

A group carries the ticket id, `title`, `status` and `url`, `requestCount`, `runCounts` by run
status, the `latestRun`, the `pullRequests` (repository, number, state, draft, link), the summed
`costUsd`, `latestWorkRequestId` and `lastActivityAt`.

**Automated work is hidden by default.** The ids these launches file are correlation keys, not
tickets, so unless `includeAutomated=true` the list leaves out:

- requests with an agent run (a run of a template whose origin is the agent-run origin);
- requests with a Channel Assistant or Channel Task run, or any run in a Slack channel;
- a template launch whose ticket id is the request's own id (the fallback when a launch names none).

**Visibility is per row.** A group is built only from rows the caller may see:

- the requests: an ADMIN's, or those with a ledger row on a repository the caller can reach — the
  rule `GET /work-requests` applies;
- the runs, through `buildWorkflowRunVisibilityFilter`;
- the ledger rows (for cost) and the pull requests, on reachable repositories.

Counts, cost and the tracker title come from those rows alone, and a group with no visible request
does not appear — nor does it count toward `meta.total`. A ticket worked by two teams therefore
reads differently to each of them.

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
  latest request, the ticket's requests, and its pull requests with their states.

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
  event corrects it. A merge is still recorded from either state.
- A ticket's title, status and link are a snapshot from submit time, and exist only when a tracker
  is configured; they do not follow later edits in the tracker.
- Tickets are grouped over every visible request matching the filters before they are paged, so a
  deployment with a very large request history pays for that on each read.
- A launch that names its own ticket label is indistinguishable from a real ticket and is not
  treated as automated.
- A request visible only because its requester launched it, with no ledger row on a repository the
  caller reaches, is not listed under Tickets; `GET /work-requests` applies the same rule.
- The list APIs are not exposed through the CLI or the MCP endpoint.
