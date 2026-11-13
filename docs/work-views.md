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

A re-push looks first at the latest PR on the executing workflow's own ledger row, whatever its
status (`openedAt`, then `id`, descending). If it is `OPEN`, it is updated. A close is a decision, so
if it was closed without merging, `createOrUpdatePullRequest` fails non-retryably with
`PR_CLOSED_BY_REVIEWER` instead of opening a replacement, before any other PR is considered. If it
is merged, or the execution has no PR, the newest `OPEN` PR of the same request and repository is
adopted: a request can have several ledger rows (re-runs, and scheduled fires, which share one
standing request and one branch). When the executing workflow has a ledger row of its own, an
adopted PR moves to it, because the CI webhook signals the workflow a PR's row names and an execution
that is no longer waiting, or a concurrent one, cannot use that signal; the earlier execution's view
loses the link. A new run of the request has its own ledger
row, is not stopped by an earlier run's close, and opens a new PR; the old row stays as history.

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
| `teamId` | narrow to a team's repositories, including ones shared with it (see [`teamId` semantics](#teamid-semantics)) | any |

A row carries the repository (`id`, `org`, `name`), `prNumber`, `url`, `title`, `status`,
`isDraft`, `ciStatus`, `openedAt`/`mergedAt`/`closedAt`, and — from the ledger row the PR belongs
to — `ticketId`, `workRequestId`, `costUsd` and `latestRun` (`id`, `status`).

`url` is derived in one place, `pullRequestUrl()` in `@auto-swe/shared/lib/pullRequest`, from the
repository's own web base (so a repository on another host links to that host) or, when the
repository names none, the instance's configured GitHub base (`resolveGitHubBaseUrl()`, so a
GHE-primary deployment links to its own host, not github.com), and is null unless that base is an
http(s) address. The gateway derives it for every surface — the ticket and request lists and the
workflow API (`pullRequests[].url`), which the workflow page reads — so the browser never guesses
the host.

**Visibility.** A row is listed when the caller may reach the PR's repository
(`reachableConnections`, so a shared team counts and the permission gate applies); an ADMIN sees
every row. The ledger-derived fields are read only when the ledger row is on that same repository,
and `latestRun` only when the caller may see the run (`buildWorkflowRunVisibilityFilter`), so a
visible PR never discloses a run, request or cost the caller could not list themselves. `total`
counts the same filtered set.

### `teamId` semantics

A `teamId` filter has two scopes, and which one applies depends on whether the answer is a list or a
metric:

- **List scope: owned or shared.** `GET /pull-requests`, `GET /workflow-runs/requests`,
  `GET /workflow-runs`, `GET /human-steps` and `GET /repositories` match the work on repositories
  the team owns **or** that are shared with it, so a team's board shows what it can open. The run,
  request and human-step lists also match runs of a template the team owns
  (`runListTeamScope()` in `gateway/src/lib/runTeamScope.ts`); the repository list is
  `repositoryTeamScope()` alone. Agent runs have no list of their own: they list through
  `GET /workflow-runs`. Each run in those lists carries who or what started it
  ([run-provenance.md](./run-provenance.md)).
- **Metrics scope: owner only.** `GET /pull-requests/outcomes` and its export match pull requests
  whose attribution run (`PullRequest.runId`) is attributed to the team (`WorkflowRun.attributedTeamId`,
  `runMetricsTeamScope()`), so a repository shared with another team is counted once, by its owner.
  A pull request with no attribution run belongs to no team's metrics.
- **A non-member gets `404 TEAM_NOT_FOUND`.** Naming a team the caller does not belong to is refused
  whether or not the team exists (`assertTeamParam()` in `gateway/src/lib/teamParam.ts`); a platform
  ADMIN may name any team.
- **The filter only narrows.** It is its own `AND` term beside the visibility filter, so it can never
  widen what the caller may see.
- **The dashboard sets it from `?team=<slug>`.** Each global list page reads the team's slug from its
  address, resolves it among the caller's teams (a platform ADMIN's through every team) and passes
  the id here; an unresolved slug is ignored and a failed lookup is an error, never an unfiltered
  list ([teams.md](./teams.md#4-the-team-filter-on-global-pages)). A service principal skips the
  membership check on `GET /workflow-runs?teamId=`; the filter still only narrows.
- **Rows name their team.** A pull request row carries `ownerTeam` (`id`, `name`, `slug`) for the
  team that owns its repository, and a request row carries `teams` (`id`, `name`) for the owners of
  the repositories and template it ran on, found by one extra query over the page's runs, limited to
  runs the caller may see.

The request list's attention state and `pendingStepCount` count only the pending steps the caller may
answer (the run-control rule). A member of a team a repository is shared with sees the request and its
steps in the human-step list, but the request is not marked as needing their attention.

---

## 2.1 `GET /api/v1/pull-requests/:id/cockpit`

What the review page (§5) shows for one pull request, by its `PullRequest` id. ENGINEER and above,
with the list's visibility: a repository the caller cannot reach is `404 PULL_REQUEST_NOT_FOUND`, and
nothing is read from the host until that is decided. The answer has these parts, `pull` first:

- `pull` — the list row (§2) plus `headSha`, the head the row stores.
- `evaluation` — the latest evaluation of the pull request, or null when there is none: risk class,
  mode, status, reasons and claims to verify, and, where the evaluation stored them, the ticket's
  `intent`, the run's `evidence` and the review network's `findings`
  ([`pr-evaluation.md`](./pr-evaluation.md)). `stale` is true when it covers a head other than the one
  the host reports now. A finding carries `anchored`, true only when its line is inside its file's
  patch at that head, so a stale evaluation's findings are never anchored.
- `files` — read live from the host, in the platform's reading order, each with its patch, a
  `patchDigest`, and the evaluation's marks (`flagged`, `why`, `verify`, `skim`). The read uses the
  repository's own approved API host and a platform credential that never leaves its host, the rule
  the check-run and PR-feedback reads apply. When the host cannot be read, `files` is
  `{ "type": "unavailable", "reason": … }` with `host-not-approved`, `no-credential`, `not-found`,
  `rate-limited` or `failed`, and the rest of the answer is unaffected.
- `viewed` — the paths the caller has marked viewed whose patch has not changed since, and
  `changedSinceViewed`, the paths they marked whose patch has changed since the mark.
- `sinceLastVisit` — set only when the caller has opened the page before (§2.3) at a head other than
  the one the host reports now, and the host could be read: the head they saw, when, and the commits
  between the two (`sha` and the first line of the message, oldest first, at most 100, with
  `totalCommits` for the rest). `rewritten` is true when the earlier head is no longer an ancestor
  of the current one, which a force-push causes; the commits are then those the branch has beyond
  the last one they share. `commits` is null when the host could not be asked for them, so only the
  move is known.
- `drafts` — the caller's own unsent line comments (§2.4), oldest first. Each is `outdated` when its
  file's patch is no longer the one it was written against or its line is no longer in the patch;
  while the files cannot be read nothing is flagged, since nothing can be said.
- `write` — whether the caller can send from the page (§2.5): `available`, and when not, a `reason`
  (`disabled`, `no-token`, `unusable` or `unreadable`). `approvalMayNotCount` is true for the person
  who launched the latest run or requested the work, whose approval the platform sets aside
  ([`pr-evaluation.md`](./pr-evaluation.md)); `feedbackLoopEnabled` says whether
  `github.prFeedbackAutomationsEnabled` is on at the repository's scope. The saved token is
  resolved to learn this and is never part of the answer.

A patch is never stored. The gateway keeps one read in memory for five minutes, per repository,
pull request and head, for at most twenty reads, and does not keep a read holding more than five
million characters of patch. The pull request itself is read on every request, because that is how
the current head and state are known; the read is conditional on the ETag of the last one, so an
unchanged pull request is answered with a 304 that does not count against the host's rate limit, and
`state` always comes from that read, never from the held files. The whole read, the pull request and
up to 30 pages of files, is bounded to a minute. The host lists at most 3000 files, so `truncated` says
when more exist, and a patch over 200,000 characters is treated as absent, as the evaluator does. The
answer as a whole carries at most three million characters of patch: in reading order, a file past
that is named without its patch, like a binary one, and cannot be marked viewed. Titles, paths,
patches and findings are untrusted text.

## 2.2 `PUT /api/v1/pull-requests/:id/viewed`

Marks files viewed, or clears the marks, for the caller alone. Body
`{ "files": [{ "path", "patchDigest" }], "viewed": true | false }`: 1 to 200 files, a path of at most
500 characters, and the 64-character hexadecimal digest the page received with the file. A mark
counts only while the file's patch digest equals the one stored, so a push that changes a file puts
it back among the unread, as the host does. A person can hold at most 3000 marks on one pull request
(`400 TOO_MANY_VIEWED_FILES`). The visibility and 404 are the cockpit's. The in-app assistant may
propose it only for the user's confirmation.

## 2.3 `POST /api/v1/pull-requests/:id/visit`

Notes that the caller has seen a head: body `{ "headSha" }`, a 40- or 64-digit commit id. One row
per person and pull request holds the head last seen and when, and the time of the first visit, which
is never moved. The page sends it once per head, after the page has drawn and never from a refresh,
so the next visit can say what moved since (`sinceLastVisit`, §2.1). It reads nothing from the host.
The visibility and 404 are the cockpit's. The in-app assistant may not call it.

## 2.4 Draft line comments

`POST /api/v1/pull-requests/:id/drafts` keeps a comment for the caller on one line of a file's new
side: `{ path, line, body, headSha, patchDigest }`. `PATCH …/drafts/:draftId` changes the text and
`DELETE …/drafts/:draftId` discards it. A draft is the caller's alone and never leaves the platform
until a review is sent (§2.5); a person holds at most 100 per pull request
(`400 TOO_MANY_DRAFTS`). Text is refused (`400 REVIEW_TEXT_REFUSED`, with `details.problem`) when it
is empty, longer than 4000 characters, holds the platform's automation marker (the platform would
read it as its own text and ignore it), or has a line starting `/auto-swe fix`, which starts a run
when it reaches the host and has its own button (§2.6). Whether the line is still in the diff is
decided when a review is sent. The visibility and 404 are the cockpit's, and a draft that is not the
caller's is a `404 DRAFT_NOT_FOUND`. The in-app assistant may not call these.

## 2.5 `POST /api/v1/pull-requests/:id/review`

Sends a review as the caller: `{ event, body?, draftIds, headSha }`, where `event` is `COMMENT`,
`APPROVE` or `REQUEST_CHANGES` and `draftIds` names the caller's drafts to send as line comments (at
most 100). It is posted to the host in one request, pinned to the head the page showed, with the
token the caller saved for the repository
([`user-github-credentials.md`](./user-github-credentials.md) §7). It never uses the platform's
credential: with no usable token of their own nothing is sent (`409 NO_USER_CREDENTIAL`, with
`details.reason`). Requesting changes needs a body (`400 REVIEW_BODY_REQUIRED`), and a comment needs a
body or a draft (`400 NOTHING_TO_SEND`). The text rules are §2.4's.

The host is read first, and nothing is sent when the pull request cannot be read
(`409 FILES_UNAVAILABLE`), is no longer open (`409 PULL_REQUEST_NOT_OPEN`), has moved from `headSha`
(`409 STALE_HEAD`, with `details.currentHeadSha`), or when any named draft is on a file whose patch has
changed or on a line no longer in it (`409 DRAFTS_OUTDATED`, with `details.draftIds`); a draft that
no longer exists is `409 DRAFTS_CHANGED`. A refusal by the host is a `502` whose code says which:
`HOST_FORBIDDEN`, `HOST_NOT_FOUND`, `HOST_RATE_LIMITED`, `HOST_REJECTED` (an author cannot approve
their own pull request, and a comment must be on a changed line) or `OUTCOME_UNKNOWN`. The message
is fixed text, never the host's words.

A review is sent once and never retried. It carries no idempotency key, because a key would have to
be a marker in the text, and text with the marker is read as the platform's own. When the connection
fails or the host answers 5xx, the review may or may not exist, and the answer says exactly that;
the drafts are kept so nothing is lost, and the reviewer checks the pull request before trying
again. On success the sent drafts are deleted and an audit entry of entity type `PullRequestReview` is
written in one transaction ([`audit-log.md`](./audit-log.md)); if that step fails the answer is still
a success, with `draftsKept: true`. The answer carries the review's id and an http(s) address.

## 2.6 `POST /api/v1/pull-requests/:id/send-back`

Leaves `/auto-swe fix` on the pull request as the caller, with an optional note after it:
`{ headSha, note? }`. It is the comment a person would type, so the existing webhook path decides
the rest with its own checks: the caller's linked account and write permission, the round limit and
the kill switch ([`pr-feedback.md`](./pr-feedback.md)). Nothing is started from here, and the route
answers `409 FEEDBACK_LOOP_OFF` while `github.prFeedbackAutomationsEnabled` is off at the
repository's scope, since the comment would do nothing. The rules of §2.5 otherwise hold: the
caller's own token, an open pull request, the head the page showed, one send and no retry, and the
note's text rules (§2.4). It is audited as entity type `PullRequestReview`. The in-app assistant may
not call §2.4, §2.5 or this route: a person decides what is sent in their name.

---

## 3. `GET /api/v1/pull-requests/outcomes`

The delivery metric: of the pull requests opened in a window, how many were merged and how fast.
The cohort is the PRs **opened** in the window, with each one's outcome read as of now.

| Parameter | Values | Default |
|---|---|---|
| `window` | 1 to 365 days, whole UTC days ending today | `30` |
| `since`, `until` | an inclusive UTC day range (`YYYY-MM-DD`), together; replaces `window` | none |
| `scope` | `MINE` (requests the caller made) or `TEAM` (everything visible) | `TEAM` |
| `teamId` | narrow to runs attributed to the team (owner only; see [`teamId` semantics](#teamid-semantics)) | any |
| `repoId` | a repository id | any |

The response `data` holds `window` (`start`, `end`, `days`), `current` for the window and
`previous` for the same number of days directly before it (null when `previousComplete` is false),
`previousComplete`, `isTruncated`, and
`byRepository`: the ten repositories with the most PRs opened, each with its own summary, plus
`byTemplate`: PR outcomes grouped by the persisted `PullRequest.templateId` and template name.
Rows without a template id appear in the null-id “Unattributed” bucket. A summary
carries `opened`, `merged`, `closedUnmerged`, `open`, `mergeRate` (merged over merged plus closed
unmerged; null while none has resolved), `timeToMergeMs` (`p50`, `p95` and `count` of merged PRs
with a valid open-to-merge time), `ciStatusCounts` and `draftCount`. The summaries are computed by
`summarizePullRequestOutcomes()` in `@auto-swe/shared/lib/pullRequestOutcomes`.

Both outcomes routes accept an optional `templateId` UUID in addition to `repoId`; the export
includes `template_id` and `template_name` columns.

Visibility is the list's: an ADMIN sees every row, anyone else the PRs of repositories they may
reach (`reachableConnections`). The read takes at most 10,000 PR rows after filters, newest first.
When that cap cuts into the window, `isTruncated` is true and `current` is computed from the rows read; when it
cuts into the previous window only, `previousComplete` is false and `previous` is null.

### 3.1 `GET /api/v1/pull-requests/outcomes/export`

The same pull requests as a file for a spreadsheet or BI tool: one row per PR **opened in the
window** (no previous window), newest first. It takes the outcomes read's `window`, `since`/`until`,
`scope`, `teamId`, `repoId` and `templateId`, plus `format`: `csv` (default) or `ndjson`. Visibility is the
outcomes read's, from the same filter function, so an export reaches no row the summary would not.
ENGINEER and above may call it.

Columns (CSV header, and the keys of each NDJSON object): `pull_request_id`, `repository_org`,
`repository_name`, `pr_number`, `status`, `is_draft`, `ci_status`, `opened_at`, `merged_at`,
`closed_at`, `time_to_merge_ms` (merged PRs only), `template_id`, `template_name`. Titles and
tickets are not exported. A text cell
that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` so a
spreadsheet does not run it as a formula (`csvCell()` in `gateway/src/lib/csv.ts`, shared with the
audit-log export); numbers and booleans are written as they are.

The file stops at 50,000 rows. `X-Export-Row-Limit` carries the cap and `X-Export-Truncated` is
`true` when more rows matched. The count and the first batch are read before any byte is sent, so a
database failure at that point is a plain `500`. The assistant may not call it (`bulkExport` in the
assistant policy).

---

## 4. `GET /api/v1/tickets`

Groups everything filed under one `externalTicketId`. The grouping, the ordering and the paging are
done in the database (`groupBy` over the matching requests), so a call reads one page of groups, not
every request. Groups are ordered by the creation time of their newest matching request, newest
first, then by ticket id; `meta.total` is the number of groups. Each page's aggregates are then read
for that page's tickets only.

| Parameter | Values | Default |
|---|---|---|
| `includeAutomated` | `true` / `false` | `false` |
| `search` | substring of the ticket id, the request description or its launch label | none |
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
matching the generated id. The write-back also requires the flag to have been read and found false,
so an unreadable flag skips it while the tracker sync is still attempted. A `postTicketComment`
step in such a run posts nothing and returns `posted: false` with a reason. A Channel Assistant
turn files no request of its own, so there is nothing to flag. The Slack merge note and
the merge evaluation row do not depend on the tracker and still run.

On the GitHub tracker every read and write — a `postTicketComment` comment, the syncs above (which
post comments, post the pull-request link as a comment and close the issue when the run completes),
the issues a PRD run creates for its epics and stories, and the ticket fetched into a request's
`ContextSnapshot` — stays in a repository the run targets, on the host the tracker is configured
for, or in one an operator listed in `github.trackerIssueRepositories`. A GitHub ticket id
(`owner/repo#123`) names its own repository and is supplied by whoever launched the run, so the id
is checked first against the run's repositories: its connection when that is a git repository, and
the git repositories its launch was authorized against (`knowledgeRepoSources`). At submit time the
repository is the one the launcher selected, which the route has already checked for membership.
Owner and repository compare case-insensitively; the host is the tracker's base URL
(`api.github.com` when it has none) against the repository's API and web URLs (the instance's GitHub
URL when it has none), with `github.com` and `api.github.com` one host, and `<t>.ghe.com` and
`api.<t>.ghe.com` one host. A bare issue number names no repository: a write refuses it, and a read
resolves it against the run's own repository and checks that.

A deployment that keeps its tickets in a separate issues repository (`org/issues#5` while the run
targets `org/app`) lists `org/issues` in `github.trackerIssueRepositories`
([`configuration.md` §9](./configuration.md#9-extra-issue-tracker-repositories)). A ticket id that
names a listed repository is then in scope for reads and writes alike. The setting is ADMIN-only and
resolves at the team and organization of the run's own repository, never from anything a launcher
supplies. Listed entries are on the tracker's host by definition, so the host comparison applies
only to a run's repositories; the provider still calls only the tracker's own base URL. A bare issue
number never resolves against the list. A setting that cannot be read is an empty list, so the
check fails closed. A run with no git repository connection has no team to resolve at and gets no
list. A PRD run's project key
(`owner/repo`) is checked the same way, as the issue `<key>#1`; without a project key the
admin-configured default is used and is not checked. A write that fails the check is skipped and
logged with a fixed line, and a PRD item that is refused counts as a failed tracker item. A read
that fails the check happens before any request and is treated as a ticket that was not found: no
ticket is fetched or stored, the submission still succeeds and the run continues from its
description, and a fixed line is logged with ids only. Jira and Linear ids and project keys name no
repository and are not checked.

The check runs on the repository the ticket id names, and the request then stays there. The
provider follows a redirect only while its target is still under
`/repos/<owner>/<repo>/` of the checked repository (case-insensitive), and a fetched issue whose
`repository_url` names another repository is discarded. Reads and writes therefore never reach a
repository other than the one checked. GitHub answers a renamed repository or a transferred issue
with a redirect outside that path, which is not followed: a read treats the ticket as unavailable
(no ticket is fetched or stored), and a write (comment, close, pull-request link, issue creation) is
skipped.

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

## 5. Dashboard

The Work group of the sidebar lists **Pull requests** (`/pull-requests`) and **Tickets**
(`/tickets`). Filters live in the address, so a filtered list can be bookmarked and survives a
reload.

- **Pull requests** — a table with the state (Open, Draft, Merged, Closed) and CI badges, the ticket
  (linked to its request), the latest run, cost and age. Filters: scope, state (Open unless the
  address says otherwise), draft, repository, ticket. The title opens the review page, and the PR
  links to the host in a new tab.
- **Review page** (`/pull-requests/<id>`) — reads one pull request in the order the platform
  suggests: a header with the state, CI, risk class and head; what was asked and how the run settled
  each open question; what the run verified; the review findings, drawn under the line they name;
  and the diff, with the files to verify marked, the ones proven skimmable marked, each file
  collapsible and the first three open, in one column or, on a wide screen, split with the old
  version beside the new (a per-viewer choice kept in the browser; a narrow screen always uses one
  column), with the code coloured by language in the colours of the viewer's theme once a file is
  opened. Within an edited line the words that changed are marked, and a block of code removed in
  one place and added in another (in this file or another) is marked as moved on both sides. A rail
  lists the files with a filter (all, to verify,
  unviewed, skim) and a count of those viewed; `j` and `k` move between files and `v` marks one
  viewed. Marking a file viewed collapses it. A banner says when the evaluation covers an earlier
  commit, when the host could not be read, when files were cut off, and when the pull request is no
  longer open. A visit after the head has moved opens with what came in since the last one (the
  commit subjects, or that the branch was rewritten), kept on screen for the visit, and a file whose
  patch changed under a viewed mark says so in the rail and on the file.
  A reviewer with a saved GitHub token for the repository can also write from the page, as
  themselves: the number of each added or unchanged line is a button that opens a box under the line,
  saved as a draft; a panel sends the verdict (comment, approve, request changes), a summary and the
  drafts as one review; and "Send back to the agent" leaves `/auto-swe fix`, with a note if wanted.
  Every send asks first and says it is posted as them. Without such a token the panel says why and
  offers nothing; drafts that no longer fit the diff are listed in the panel, where they can be
  deleted, and hold the review back. The page never merges.
- **From a run** — the outcome card of a run that opened a pull request, for a workflow or an agent
  run, offers "Open review" beside the host link. The run detail (`GET /api/v1/workflow-runs/:id`)
  carries it as `pullRequestId`: the newest pull request recorded against the run that has a number,
  and only one in a repository the caller can reach, so the link never leads to a 404. It is null
  otherwise, and always null for a service principal. It also carries `ownerTeam` (the team that
  owns the run's repository) and the `canControl` flag of its `review` block, which is `false` for a viewer who sees the run
  through a shared repository without controlling it ([teams.md](./teams.md#seeing-a-run-versus-controlling-it)).
- **Pull request outcomes** — a card on **Platform analytics** (`/admin/analytics`) for the page's
  date range: merge rate, median and 95th-percentile time to merge, PRs opened (with merged, closed
  unmerged, open and draft counts), each against the previous window, and the ten repositories with
  the most PRs opened. A banner says when the row cap cut into the window, and when it cut into the
  previous one so no comparison is shown. The card loads and fails on its own.
- **Tickets** — a table with the tracker status, request and run counts, the latest run, PR count,
  cost and last activity. An "Include automated runs" checkbox is off by default. The ticket title opens the
  latest request; its pull requests and their states are listed in the row.

Titles, ticket ids and tracker text render as plain text; a ticket link is followed only for an
http(s) address. On the review page every file name, patch line, finding and criterion is plain
text with invisible and direction-changing characters made visible, never markup.

---

## Limitations

- The outcomes `teamId` filter matches through the pull request's attribution run, so a pull request with no run, or a run with no attributed team, appears under no team's metrics (it still appears when no `teamId` is given).
- Writing from the page needs a token the reviewer saved for the repository, with the switch for
  saved tokens on. The token's scope is not checked when it is saved, so a token that cannot write
  fails at the first send (`HOST_FORBIDDEN`). A comment is on one line of the new side: a comment on a
  removed line, on a range of lines or on a whole file is written on the host.
- A review is sent once and never retried, and carries no key the host could de-duplicate by, so a
  send whose outcome is unknown (`OUTCOME_UNKNOWN`) is for the reviewer to check on the host. The
  host's own rules still apply: an author cannot approve their own pull request, and a review
  requesting changes or approving counts toward branch protection only as the host decides. The
  platform sets aside the approval of whoever launched or requested the work, and the page warns
  only for the latest run and the requester it can see, not for every run of the same work.
- "Send back" starts a run only if the webhook path's checks pass for the reviewer. The page cannot
  see them, so it says the comment was left, not that a run started.
- The summary of what came in since the last visit is kept for the visit it was shown on and is gone
  on the next, because opening the page records the head. Commits are listed from the host's compare
  read, which lists at most 100 of a long push (`totalCommits` gives the full count).
- Each visit and each refresh of the review page asks the host for the pull request, and for its
  files when the head has moved or the copy is older than five minutes. The pull request read is
  conditional, so an unchanged one is cheap, but a changed one and every page of files are not. The
  page refreshes every minute while the pull request is open and stops once the host reports it closed
  or merged.
- Code is coloured for the file types the page knows by name or extension (TypeScript, JavaScript,
  JSON, YAML, Markdown, CSS, HTML, Python, Go, Rust, Java, shell, SQL, TOML, Prisma and a few more);
  any other file draws plain. Colouring is worked out in the browser only for a file that is open, a
  grammar is fetched the first time a file of its language is opened, and a file over 150,000
  characters of patch draws plain. The old and new versions of each hunk are read separately, so a
  hunk that starts inside a multi-line comment or string is coloured as if it began at its first
  line. Until the colours arrive a file draws plain.
- Changed words are marked only for a removed line and the added line that replaces it, when both
  are at most 500 characters and share a good part of their words; a rewrite is left plain. Moved
  code is found only by exact match, ignoring indentation and blank lines, in runs of at least three
  lines with some content: a block that was moved and also edited is shown as removed and added.
- Up to 3000 files are listed. A binary file, or a patch over 200,000 characters, is named but not
  shown. A file without a patch cannot be marked viewed.
- An evaluation written before the intent, evidence and findings were stored shows only the reading
  path and the skim list until the pull request is evaluated again, which a push does.
- The evidence is the run's: browser-check counts are per run, not per head, and the tests and CI
  are those at the head the evaluation covered. A stale evaluation says so.
- Viewed marks are per person and per pull request, and reset when a file's patch changes. A mark is
  matched by path, so a rename starts unviewed.
- The run page's outcome card links to the review page only for a pull request the platform
  recorded against that run: a pull request whose attribution to the run is missing has the host link
  alone.
- Pull-request attribution is stored when a worker creates or updates a PR and is backfilled from
  repository-matched active workflows. `WorkflowRun.workflowId` is unique, so the run is resolved
  by that exact workflow id rather than by recency. Rows with no matching run keep null attribution
  and appear as “Unattributed”; reporting reads the stored attribution rather than searching recent
  runs. For non-admin outcomes and exports, a template name is included only when the template
  passes the same team-membership visibility filter as `GET /workflow-templates`; otherwise the PR
  is included in “Unattributed” with no template name.

- With the GitHub tracker, comments, pull-request links, issue closes and PRD issue creation go
  only to a repository the run targets, on the tracker's host, or one listed in
  `github.trackerIssueRepositories`, and a ticket is read only from one. The tracker has no
  configured default repository, so a ticket id naming any other repository, a repository on
  another host, or a bare issue number gets no write: `postTicketComment` returns `posted: false`,
  and the sync is skipped. A PRD run's project key outside the run's repositories and the list
  creates no issue.
- A ticket already on a `ContextSnapshot` is used as stored; the scope check applies only when the
  ticket is fetched.
- A listed issues repository must be on the tracker's own host and is listed by an admin; there is
  no per-request or per-launcher way to name one. A `TEAM` or `ORGANIZATION` value applies to every
  run on that team's repositories, including runs by other teams on a repository shared with it,
  because the list resolves at the repository's owning team; shares and membership decide that
  audience.
- A renamed repository or a transferred issue is not followed, so its ticket is unavailable and its
  writes are skipped until the id names the current repository.
- A GitHub ticket id on a run with no git repository (no connection, no authorized repository) is
  never fetched, even a bare number.
- Outcomes group PRs by the time they were opened and judge them as of now, so a recent cohort
  under-reports merges that have not happened yet and its merge rate rises as its PRs resolve.
- An outcomes read takes at most 10,000 PRs; beyond that the figures cover only the newest ones
  read, and `isTruncated` or `previousComplete` says so.
- Outcomes are grouped by workflow template, but not by agent. The dashboard card on
  `/admin/analytics` follows that page's date range and offers a repository filter.
- An export that fails after its first byte cannot change its status: the transfer is aborted and a
  client sees a failed download, not a clean short file. Rows already sent are not marked.
- The export is a snapshot read in batches of 500 by cursor, not a transaction, so a PR whose state
  changes while it streams can appear in its old or new state.
- The count behind `X-Export-Truncated` and the first batch are separate reads, not one transaction,
  so the header can disagree with the body when rows are added or removed between them. A row
  deleted between two batches is the cursor for the next, and the file ends there early, with no
  error and `X-Export-Truncated` unchanged.
- The outcomes read and its export filter on `openedAt`; the standalone index supports this
  cohort query. The analytics approval-latency read filters `workflow_human_steps` on
  `requested_at`, which is indexed.
- `scope` defaults to `TEAM` here and to `MINE` on the list, so the same caller sees different
  counts from the two endpoints unless one is set explicitly.
- A closed draft counts as `closedUnmerged`; the merge rate does not separate drafts from ready PRs.
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
  anchor) is not covered and may open a new PR after a close, and an open PR it adopts stays linked
  to its earlier execution, whose workflow receives the CI signal.
- Two executions of one request are kept apart by two checks that each read the ledger and then
  act, with no lock between them. A retry is refused with `409 WORKFLOW_ALREADY_EXISTS` while any
  ledger row of the request is not terminal, a scheduled fire's and a template-launched run's
  included (a retry of a `wf-` run is refused while that run is in flight). A scheduled fire is
  skipped (reason `request-in-flight`) while a row of the request that is not a fire is not
  terminal; a retry can last days awaiting a merge, and every fire in that time is skipped, each
  tick shown as a refused execution with at most one audit row an hour (its `afterJson.event` is
  `fire-skipped`), and the schedule resumes on the first tick after the retry ends. The schedule's
  own overlap policy keeps fires apart from each other.
- A ledger row is only a claim, and one can be left non-terminal with no run row for the reaper to
  find (a launch that failed after its ledger write, a workflow terminated before its first
  activity). So before either check refuses, the row is confirmed with Temporal: a finished or
  absent workflow has its row closed with the status Temporal reports (`COMPLETED`, `TIMED_OUT`,
  `CANCELLED` for a terminated or cancelled one, else `FAILED`) and does not block; a row written in
  the last five minutes is trusted without asking; and when Temporal cannot be asked, or does not
  answer within three seconds, the row blocks and the 409 or the skip says it could not be confirmed.
  The retry's workflow id allocator refuses on any non-terminal row of the ticket's `eng-` family
  without asking, so a retry confirms the row the allocator names the same way (including one of
  another request) and allocates again once it is closed. Rows of the ticket's family under a legacy
  id spelling are confirmed the same way, since the allocator names whichever row it refuses on.
  A retry and a fire that both read before either has written its ledger row can still overlap, and
  the second to reach the PR step then adopts and re-links the other's open PR as described above.
- A run ended by a `terminate` node with status `SKIPPED` closes its ledger row as `COMPLETED`, the
  run keeping `SKIPPED`, so it never reads as in flight.
- Adopting an open PR of the request is by request and repository only; no head branch is stored.
  After a branch prefix change, or a missed close webhook, the adopted PR may have a different head
  branch than the one the run pushed.
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
