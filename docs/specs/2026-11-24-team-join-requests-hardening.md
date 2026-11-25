# Team join requests: hardening

Status: approved direction. Extends
[the follow-up spec](./2026-11-20-team-join-requests-followup.md); where the two differ, this document wins.

## 1. Problem

The earlier join-request feature left these gaps, each documented as a limitation:

1. An approval and a workflow launch on one team can deadlock: approvals lock the organization then the
   team, workflow launch locks the team then the organization, and a launch also locks the launching
   user's row, which an approval's membership insert needs a share lock on.
2. Nothing deactivates an organization, so closing requests for a deactivated organization is unwired, and
   the approval paths never check the organization's active flag.
3. A failed notification is logged and lost; nothing records that it was sent.
4. A team without a Slack channel gets no notice of a new request.
5. The directory's organization filter lists at most 500 organizations.
6. The `organizations` list query can choose a bad plan when statistics are stale.
7. The notification path had never been exercised against a real SMTP server or a Slack-shaped API, and
   the feature had never been walked through end to end in a browser.

## 2. Decisions

| Gap | Decision |
|---|---|
| Lock order | One global order, written once in `packages/gateway/src/lib/lockOrder.ts`: person advisory locks, the user row, connection rows, organization rows, team rows, each level in ascending id order. Workflow launch, join decisions and the other membership writes follow it, with staged interleavings run against a real database. |
| Organization deactivation | A platform admin can deactivate and reactivate an organization. Deactivating closes its teams' open requests in the same transaction. Decisions refuse an inactive organization. |
| Delivery | A database outbox written in the same transaction as the request or decision, drained by a gateway-side poller. Each delivery is retried with backoff and recorded. A request whose notice cannot be queued is not created. |
| Teams without Slack | Email the team's active `LEAD` and `ADMIN` members (new setting, default on). |
| Organization filter | A server-side search endpoint with a cursor replaces the cap; the web filter becomes a typeahead. |
| Query plan | The organization queries read distinct organization ids from `teams` with one `GROUP BY` and probe `organizations` by primary key in chunks, so their cost follows the number of teams and not the planner's statistics. A test measures it with no `ANALYZE`. |
| Live checks | Real SMTP and Slack-shaped loopback servers in the gateway tests. The browser journey was run by hand once and is not automated (see §10). |

## 3. Data model

`JoinRequestNotification` (`join_request_notifications`), one row per delivery:

| Field | Notes |
|---|---|
| `id` | uuid |
| `requestId` | FK to `TeamJoinRequest`, `onDelete: Cascade` |
| `event` | enum `JoinRequestNotificationEvent`: `CREATED`, `APPROVED`, `REJECTED`, `PENDING_ORG` |
| `channel` | enum `JoinRequestNotificationChannel`: `SLACK`, `EMAIL` |
| `audience` | enum `JoinRequestNotificationAudience`: `TEAM_CHANNEL`, `TEAM_REVIEWERS`, `REQUESTER`, `ORG_ADMINS` |
| `status` | enum `JoinRequestNotificationStatus`: `PENDING`, `DELIVERED`, `SKIPPED`, `FAILED`. `PENDING` ends as one of the other three; `FAILED` returns to `PENDING` only through an admin retry; `DELIVERED` and `SKIPPED` are final. |
| `attempts` | int, default 0 |
| `nextAttemptAt` | timestamptz, when the poller may next claim it |
| `lastError` | text, one of a fixed set of codes (`transport_not_configured`, `transport_error`, `slack_error`, `no_recipients`, `request_state_changed`, `notifications_disabled`, `party_inactive`); never an address, a body or a credential |
| `reached` | JSON array, default `[]`: unsalted SHA-256 hashes (fixed prefix, lower-cased address) of the recipients already reached. No address is stored; the hashes are pseudonymous, since anyone holding the users table can map them back, and the API never returns them |
| `deliveredAt`, `createdAt`, `updatedAt` | |

A unique index on `(request_id, event, audience)` makes enqueueing idempotent: a second enqueue of the same
event creates no second row. An index on `(status, next_attempt_at)` serves the poller and one on `(status, updated_at)` serves the
retention purge. A delivery to an
audience is one row, and a partly failed email fan-out is retried only for the recipients that failed:
recipients are resolved at send time, and the sender records each one reached in `reached` as it goes, so a
retry never resends to them.

## 4. Settings

| Key | Change |
|---|---|
| `teams.joinRequestReviewerEmail` | New. Boolean, default `true`, GLOBAL, admin write. When a team has no usable Slack channel (none set, or no bot token resolves for it), email its active `LEAD` and `ADMIN` members on a new request. Off stops that email. `teams.joinRequestNotifications` still stops every notification. |
| `teams.joinRequestNotificationRetentionDays` | New. Integer 1–3650, default `30`, GLOBAL, admin write. Delivered, skipped and failed rows last updated longer ago than this are deleted by the poller, 500 rows a pass and at most one pass a minute per gateway process. A `PENDING`
row is never deleted. |

## 5. Delivery

- The service writes the outbox rows inside the transaction that creates or decides the request
  (`enqueueJoinRequestEvent`), instead of calling a notifier after commit. A rolled-back transaction leaves
  no row, and a failure to queue the row rolls the request or decision back with it.
- The routing of a new request (a usable Slack channel, or the reviewer-email fallback) is resolved before
  the request's transaction opens (`resolveCreatedRouting`), so the transaction never waits for a second
  connection. Only the Slack bot-token lookup is forgiven: a configuration that cannot be decrypted counts as
  no usable channel and the reviewers are emailed (the log line is at most once a minute and carries no error
  text). A database error in the lookup fails the request, which is not created. If the channel or token is
  removed before delivery, the Slack row is `SKIPPED` (`no_recipients` or `transport_not_configured`) and the
  reviewers are not emailed for it.
- The poller starts with the gateway. Every 5 seconds (at once again after a full batch) it claims up to 20
  due `PENDING` rows with `FOR UPDATE SKIP LOCKED` (marked `// CLAUDE.md §7 exception:`) and moves their
  `nextAttemptAt` 10 minutes ahead. That value is the row's lease. The send runs outside the claim
  transaction.
- Before each row, and again before each recipient and each Slack post, the poller extends the lease from
  now with an update conditional on `(id, PENDING, the value it holds)`. A poller that finds the value
  changed has lost the lease: it sends nothing further and records nothing. The `reached` writes and the
  outcome write are conditional on holding the lease and on status `PENDING`, so a concurrent retry, purge
  or takeover is not undone. A row whose claimer crashed returns when its last extension ends.
- A send is bounded: SMTP connects within 15 s, waits 15 s for the greeting and 30 s of socket silence, one
  message is abandoned after 90 s, the Resend call after 30 s and a Slack post after 2 s.
- Delivery is at least once per recipient. A recipient enters `reached` only after a transport accepted the
  message, and a retry skips the recipients in it. A second copy needs an attempt with an unknown outcome:
  the 90 s email deadline (the socket is destroyed and no Resend fallback starts afterwards, but a relay that
  had read the message can still deliver it), a connection lost after the relay read it, a Resend or Slack
  abort or lost answer, a crash or shutdown between the send and the `reached` write, or a lease lost
  mid-send with the other poller sending again. Each such attempt can repeat that one recipient (up to 6
  attempts); no other recipient is repeated. Before a deadline fires an SMTP failure falls back to Resend,
  which can double a message within one attempt. A failure between two recipients writes the latest known
  `reached`, so recipients already reached stay recorded.
- The lease is evaluated on each gateway process's own clock (new rows take the database's), so replica clocks
  must be kept in step; a replica more than about 8 minutes ahead takes rows another replica holds.
- On shutdown the plugin waits up to 30 s for a running tick. Once stopping, the not-yet-started rows of the
  batch are released (due now, only if the lease is still held), no new recipient or Slack post starts, and
  the retention purge is skipped. A send in flight runs to its own deadline (up to 90 s per message), which
  can outlast the wait; that row then stays leased until the lease ends. A tick reports `released` and
  `leaseLost` counts.
- The SMTP modes are plain, implicit TLS (port 465), STARTTLS (other ports) and AUTH PLAIN and LOGIN, with
  chain and hostname verification on and SNI sent for host names. STARTTLS is opportunistic and there is no
  require-TLS setting. The bounded timeouts apply to notification email only; sign-in email keeps nodemailer's
  defaults.
- Before sending, the poller re-loads the request and marks the row `SKIPPED`, with the matching code, when
  `teams.joinRequestNotifications` is false (`notifications_disabled`), the request is gone, closed by a
  deactivation or no longer in the status the event announces (`request_state_changed`), the requester, team
  or organization is inactive (`party_inactive`), or the audience has no recipient (`no_recipients`).
- A failure sets `attempts + 1` and `nextAttemptAt` by backoff (30 s, 2 min, 10 min, 1 h, 6 h). The sixth
  failed attempt makes the row `FAILED`, about seven hours after the first; it stays for the retention period.
- A system close creates no outbox row.
- Audiences: `CREATED` goes to `TEAM_CHANNEL` (Slack) when the team has a channel and a bot token resolves
  for it, otherwise to `TEAM_REVIEWERS` (email) when `teams.joinRequestReviewerEmail` is on, otherwise to
  no one. `APPROVED` and `REJECTED` go to `REQUESTER`. `PENDING_ORG` goes to `REQUESTER` and `ORG_ADMINS`.
  Reviewer and organization-admin recipients are resolved at send time, deduplicated and capped at 20 each.
  A failed Slack row is retried as Slack and never falls back to email.
- An unconfigured transport (no SMTP or Resend, no Slack token) marks the row `SKIPPED` with
  `transport_not_configured`, with one warning per process and channel, so a deployment that has no transport
  does not retry for seven hours. `SKIPPED` is final: only a `FAILED` row can be retried, and a retry
  re-queues the row and writes its audit entry in one transaction.

### Admin visibility

| Route | Purpose |
|---|---|
| `GET /api/v1/platform/join-request-notifications?status=&limit=&cursor=` | Platform admins list outbox rows (newest first, `limit` 1–100, default 50, `meta.nextCursor`, `400 INVALID_CURSOR`) with status, attempts, `nextAttemptAt`, `lastError`, the request id and the team's id and name; no recipient addresses and no reached set. |
| `POST /api/v1/platform/join-request-notifications/:id/retry` | A platform admin re-queues a `FAILED` row (attempts reset, error cleared, due now; the `reached` set is kept) and its audit row is written in the same transaction. Another status answers `409 NOTIFICATION_NOT_FAILED`; an unknown id `404 NOTIFICATION_NOT_FOUND`. |

Both need the capability `platform.join-request-notifications.manage` and are `never` in the assistant policy.

## 6. Organization deactivation

`PATCH /api/v1/platform/organizations/:orgId` (and its `/api/v1/admin/organizations` alias) accepts
`isActive`. Only a holder of `platform.orgs.deactivate` (a platform admin) may send it. The change, any
other field sent with it, the closing of requests and an audit row commit in one transaction that takes the
organization's row lock first. Deactivating closes every open join request of the organization's teams
(`closeOpenJoinRequests` with the `ORGANIZATION_DEACTIVATED` scope; no cooldown, no notification) and
records the count in the audit row. The organization that owns the team named by `defaultTeamSlug` cannot
be deactivated (`409 DEFAULT_ORGANIZATION`). Reactivating sets the flag and reopens nothing. An unchanged
value writes nothing.

Creating a request to a team of an inactive organization answers the same `404 TEAM_NOT_FOUND` as an
unknown team. Approving or rejecting at either step answers `409 ORGANIZATION_INACTIVE`. Creating a team in
an inactive organization answers `409 ORGANIZATION_INACTIVE` on both team-creation routes, and saving a
`defaultTeamSlug` whose team is in an inactive organization answers `409 DEFAULT_TEAM_ORGANIZATION_INACTIVE`;
each check reads the organization under its row lock. Adding members to a team of an inactive organization
stays allowed. The assistant policy treats the organization `PATCH` route as `confirm`, as it already does
for `trustedInvites` on the same route. The organization budget-alert list takes
`includeInactive` so the admin list can show an inactive organization and offer reactivation, and the web
organization page has a Deactivate and Reactivate card.

## 7. Lock order

The order is written once, in `packages/gateway/src/lib/lockOrder.ts`, and a transaction only goes forward:

1. advisory locks keyed by a person (`join-request:<id>`, `team-create:<id>`, `mcp-launch:<id>`);
2. user rows (`lockUser`, `FOR NO KEY UPDATE`);
3. connection rows, ascending id (`lockConnections`);
4. organization rows, ascending id (`lockOrganizations`);
5. team rows, ascending id (`lockTeams`);
6. then the rows a write touches.

Organization and team locks are `FOR UPDATE` for a membership write, an approval, a deactivation and a
launch, and `FOR SHARE` for a request's creation and a rejection. Workflow launch locks every connection,
organization and team of all its sources, in that order, before it checks any (`lockLaunchSources`), and a
user deactivation takes the account's row before it closes that account's requests.

The user lock is `FOR NO KEY UPDATE` because a launch holds the launcher's row for its whole transaction
while it waits for the team rows, and a membership insert (an approval, a member added, a request created)
holds the team row and then takes a share lock on the user row through its foreign key. `FOR UPDATE`
conflicts with that share lock, so the launch would wait for the team while the insert waits for the
user. `FOR NO KEY UPDATE` still excludes every other writer of the row and a second launch, and does not
conflict with the foreign key check, so the cycle cannot form. A writer that only inserts rows that
reference a user takes no user lock.

Tests stage each interleaving of a launch with an approval at either step, a request's creation, a member
add, a deactivation, a team creation and a default-team save against a real database.

## 8. Directory

- `GET /api/v1/teams/directory/organizations?q=&limit=&cursor=` returns `{ organizations: [{ id, name }], nextCursor }`
  over the same visibility rule as the directory, sorted by name, case-insensitive substring `q` on the name,
  `limit` 1–100 (default 50), the cursor the last name of the previous page (`400 INVALID_CURSOR` otherwise).
  The directory's own `organizations` list, capped at 500, and `organizationsTruncated` stay.
- The `organizations` queries read the distinct organization ids of active teams with one `GROUP BY` over
  `teams`, then ask `organizations` about at most 1,000 ids at a time, with the database ordering the
  chunks' winners, so their cost follows the number of teams and does not depend on table statistics. A
  test with 40,000 organizations and no `ANALYZE` finishes each query within a bound stated in the test,
  and records the plan it saw.

## 9. Web and CLI

The directory's organization filter searches the new endpoint, so selecting an organization keeps working
when more than 500 exist. The CLI has `teams directory organizations [--query] [--limit] [--cursor]`,
`orgs deactivate|reactivate <orgId>` and `notifications list|retry`.

## 10. Verification

- The notifier tests run the real SMTP transport against an SMTP server started inside the test, and the
  Slack post against an HTTP server started inside the test, asserting the delivered bytes, retries,
  backoff, `SKIPPED` for a missing transport and that a delivered row is never sent twice. A separate suite
  (`notificationEmail.tls.test.ts`) runs the SMTP client against loopback servers for implicit TLS, STARTTLS,
  AUTH, certificate and hostname verification and the deadline over TLS.
- The journey was run by hand once against a real gateway, web app and database: sign-in for four users,
  the directory typeahead, a request, a cross-organization approval through both panels, a rejection with
  its cooldown message, organization deactivation and reactivation, and notification emails delivered to a
  loopback SMTP sink with the outbox rows `DELIVERED`. It is not automated and is not run in CI; no
  browser test is committed. The SMTP and Slack deliveries are covered by loopback-server integration tests
  in the gateway's Postgres suite.

## 11. Documentation

`docs/teams.md` describes the outbox, the two admin routes, organization deactivation and the lock order, and
drops the limitations this closes. `docs/configuration.md` lists the two new settings and describes the email transport.
`docs/upgrade-notes.md` gains entries for the outbox table and its default-on reviewer email, and the
`<fixing commit SHA>` of the earlier notification entry becomes `456c74c`.

## Limitations

- A notification is retried for about seven hours at most; after that it is `FAILED` until a platform admin
  retries it.
- Email delivery is to the addresses on file; the platform does not verify that a mailbox exists.
- Locks outside the paths that use `lockOrder.ts` are not shown to be consistent with it: the service-principal
  launch guard locks the principal and then a connection before the launch takes the user row, and
  repository moves, share edits and the device-approval user lock take their rows on their own.
- Two bulk closes of overlapping requests (user, team and organization deactivation each update their
  scope's open requests in one statement) lock rows in the order the database reads them; no test stages
  this.
- The fallback organization of `POST /api/v1/teams` is the one with the slug `default`, while the guard
  against deactivating "the default organization" follows the team named by `defaultTeamSlug`; when they
  differ, the `default` organization can be deactivated.
- Delivery is at least once per recipient. An attempt with an unknown outcome (the 90 s email deadline, a
  connection lost after the relay read the message, a Resend or Slack abort or lost answer, a crash between
  the send and the `reached` write, a lease lost mid-send) can repeat that one recipient, once per attempt.
  Recipients already in `reached` are not sent again by a retry, and a poller that has lost its lease sends
  nothing further and records nothing.
- Replica clocks must agree: a gateway more than about 8 minutes ahead takes rows another replica holds, and
  the in-flight duplicate then happens routinely.
- A send in flight at shutdown can outlast the 30 s wait; its row stays leased until the 10-minute lease ends.
- STARTTLS is opportunistic and there is no require-TLS setting: a relay without STARTTLS on a non-465 port is
  used in plaintext, AUTH included, and STARTTLS stripping can downgrade the connection. A private CA is
  trusted only through `NODE_EXTRA_CA_CERTS` on the gateway process.
- The `reached` hashes are pseudonymous, not anonymous.
- A request whose team loses its Slack channel or token after creation gets no reviewer email for it.
- `SKIPPED` rows are final and only `FAILED` rows can be retried, so a notice skipped as
  `transport_not_configured` is not sent after an operator configures the transport.
- There is no automated browser test. The browser journey in §10 was run by hand once; a regression in the
  web app's directory, approval panels or organization page is caught only by the component tests and by
  someone repeating it.
