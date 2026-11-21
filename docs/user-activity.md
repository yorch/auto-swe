# User activity

User activity events are a first-party record of four things: who was refused, who looked at
something sensitive, who signed in, failed to sign in or signed out, and, only when an operator
switches it on, which dashboard pages people open. They live in the platform's own database
(`user_activity_events`, `UserActivityEvent`); nothing is sent to a third party and no client-side
analytics library is loaded. They answer "who is probing what they may not reach", "who exported
this" and "who signed in, and how", not "how long did someone stay on a page".

This is not the [audit log](./audit-log.md). The audit log records actions that change state and
is kept until an operator says otherwise; activity events record refusals, reads and sign-ins, and
expire.

## 1. What is recorded

Each row carries `kind`, `route`, `method`, `status`, `actorId`, `via`, `requestId`, a truncated
`ip`, a small `props` object and `createdAt`.

| Kind | When | Actor |
|---|---|---|
| `denied` | A signed-in person is answered `403`: a platform or team role check, or a handler's own refusal | The person |
| `read` | A successful `GET` of a route tagged as a sensitive read | The person |
| `export` | A successful `GET` of a route tagged as an export | The person |
| `ui` | A page view reported by the dashboard (opt-in, section 3) | The person |
| `sign_in` | A session was created: any sign-in method (section 7) | The person |
| `sign_in_failed` | A sign-in attempt failed for a known address (section 7) | The person |
| `sign_out` | A signed-in session was ended by a sign-out request (section 7) | The person |

`route` is the route **template** the router matched (`/api/v1/workflow-runs/:id`), never the URL.
No request body, query string, header or path parameter value is stored, so a search term typed into
a filter or a run id never reaches the table. The sign-in kinds are not routed requests: their
`route` is `auth:<method>` (for example `auth:password`), `method` is `AUTH` and `status` is null.

A route opts in with `config: { activity: 'read' | 'export' }` on its definition, so every mount of
it is covered, the deprecated `/api/v1/admin` aliases included. The tagged routes are the audit-log
list and export, a run's detail, the pull-request outcomes export and one person's analytics
profile (`/api/v1/platform/analytics/users/:id`) and the people export (`/api/v1/platform/analytics/users/export`, section 10). The activity views and the analytics overview and
people list are not tagged, so reading them records nothing. Neither is a run's traces or a
transcript read (a transcript access already writes a fuller row to the transcript access log,
[transcripts.md](./transcripts.md)).
`activityEvents.test.ts` enumerates every route of every mount and fails unless the tagged set equals
the intended one, so a new mount or tag is a deliberate change.

### Denials with no actor

A `401`, or a `403` with no identified person (a missing or invalid credential, a service token
refused by a route), writes **no row**. A table that grew with every unauthenticated request would
let anyone who can reach the gateway fill it. They are counted instead, in the OpenTelemetry
counter `http.denied`, labelled by route template, status and `actor` (`known` or `none`), seeded at
zero so a rate query has a baseline. Denials with a known person are counted there too.

## 2. How rows are written

An `onResponse` hook builds the row from the request object. It never fails or delays a request.
Three bounds keep a poller or a hostile signed-in caller from flooding the table:

- **Dedupe.** At most one `read` row per person and route every 10 minutes (an `export` row is never collapsed), one `denied`
  row per person, route and status every minute, one sign-in or sign-out event per person and method every
  minute (failed sign-ins are not collapsed, so a burst of guesses is counted), and one page view per person and page every five seconds. The remembered keys are a small
  bounded map, so memory does not grow.
- **Rate.** Each person has a budget per kind, refilled continuously: 120 denials, 60 exports, 60 reads
  and 60 page views a minute, and 30 each of sign-ins, failed sign-ins and sign-outs. The budgets are separate, so a flood of page views, reads or distinct
  denied routes cannot use up the one that records an export, and a flood of denials cannot starve
  exports either. The excess is dropped and counted; an authenticated caller is rate-bounded, not
  unbounded. A dropped event does not mark its dedupe key, so the same event is recorded once the
  budget refills.
- **Queue.** Rows go to an in-memory queue (1,000 events) flushed in batches of up to 100, every five
  seconds or when a batch fills. When it is full, a `denied`, `export` or sign-in event evicts the oldest page
  view, then the oldest read, before it would be dropped; a page view or read never displaces
  anything. A failed batch write is dropped, not retried. An export, denial or sign-in can still be dropped when the
  queue is full of other exports, denials and sign-ins.

Every drop is counted: `activity.events.dropped` is the counter, and `/admin/activity` shows how many
this gateway process has dropped since it started. The queue lives in the process, so events not yet
flushed when a gateway is killed are lost; shutdown waits a few seconds for a flush and then gives up
if the database is down.

`ip` is the request's address truncated to its /24 (IPv4) or /48 (IPv6), the same truncation the audit
log uses; it is omitted for an in-app assistant call, whose peer address is the worker's.

## 3. Page views (opt-in)

Page views are off. The registry setting `analytics.uiEventsEnabled` (ADMIN, GLOBAL only, default
`false`) turns them on, read on each request, so no restart is needed.

- The dashboard reports the page's **pathname only**, in batches of at most 20, at most every five
  seconds, through `POST /api/v1/activity/ui`. The same page twice in a batch is one view. The route
  requires a signed-in person. Queued views are discarded when the signed-in person changes or the
  gateway answers `enabled: false`.
- The gateway reduces each path to a Next.js route template (`/runs/[id]`) from a fixed list that
  mirrors `packages/web/src/app/**/page.tsx`. A path that matches no template, or carries a query
  string, fragment, `..` or control character, is dropped, not trimmed. `uiRoutes.test.ts` fails when a
  page is added or renamed without the list following.
- While the setting is off the endpoint stores nothing and answers `{ "enabled": false }`; the
  browser then stops sending for the rest of the session.
- A browser that sends Do Not Track (or Global Privacy Control) never reports.
- Only one event kind exists, `page_view`. There is no click, scroll, timing or text capture.

## 4. Reading it

`/admin/activity` (ADMIN only) shows the last 14 days' counts by kind and by day, the most-denied
routes, and a paginated table of recent events with a kind filter. The data comes from:

- `GET /api/v1/platform/activity`: events newest first, filtered by `kind`, `actorId`, `route` and a UTC
  date range (`since`, `until`), 50 per page by default.
- `GET /api/v1/platform/activity/summary?days=`: counts by kind and day (1 to 30 days, 14 by default),
  the top denied routes, the retention in force, whether page views are on, and the drop counter.
  The counts are exact: one grouped count per day in the database, not rows read back.

Both are ADMIN-only and are refused to the in-app assistant. The sign-in figures are read through
the analytics endpoints in section 8.

## 5. Retention

`analytics.activityRetentionDays` (ADMIN, GLOBAL only, default 90 days, at least 7) is how long
events are kept. A daily sweep deletes older rows in batches; it shares its schedule with the
audit-log retention sweep (`AUDIT_ACTIVITY_PRUNE_ENABLED`, `AUDIT_ACTIVITY_PRUNE_CRON`; see
[configuration.md](./configuration.md)). Turning that sweep off stops both prunes. One sweep deletes
at most 100,000 rows from each table and the next run continues, so a large backlog takes several
days to clear.

## 6. Privacy stance

- Everything is first-party: stored in the platform database, readable only by ADMINs, never sent out.
- Route templates, not URLs: nothing a person typed or a resource id can appear in a row.
- Addresses are truncated before storage. The user agent is not stored in an activity event; a
  sign-in keeps only its browser and operating system family (section 7).
- Refusals with no signed-in person leave no personal data at all, only a counter.
- Failed sign-ins never store the address that was tried (section 7).
- Page views are opt-in, honour Do Not Track, and expire like everything else here.
- A row names its actor by id. Deleting a user does not delete their events; retention does.

## 7. Sign-ins and sign-outs

The sign-in events are written by the same better-auth hooks that write the `Session` audit row
(see [audit-log.md](./audit-log.md)). Each session created writes one `sign_in` event, whichever
method created it. A sign-out writes one `sign_out` event when the request carries a session
cookie that still resolves to a session; the person is named from that session, and the row is
written before the session is removed. A request with no cookie, or with an expired one, writes
nothing.

| Kind | `props` | Written when |
|---|---|---|
| `sign_in` | `method`, `browser`, `os` | Every session creation, including those by a social provider, a magic link and automatic sign-in after email verification |
| `sign_in_failed` | `method`, `reason`, `browser`, `os` | A `POST /sign-in/email` answered with an error and the address named an existing user |
| `sign_out` | `browser`, `os` | A sign-out request whose session cookie resolves |

- **Method.** A closed set: `password`, `github`, `google`, `okta`, `magic-link`, `oauth` (any other
  configured single sign-on provider) and `unknown`. It is derived from the endpoint that ran; the
  client's choice is matched against the set and nothing else is kept.
- **Reason.** A failed attempt is classified as `invalid_credentials`, `unverified`, `locked` or
  `other`, from the error code better-auth returned.
- **Browser and OS.** Coarse families only: `Chrome`, `Firefox`, `Safari`, `Edge` or `Other`, and
  `Windows`, `macOS`, `Linux`, `iOS`, `Android` or `Other`. The raw user agent is parsed at write time
  and discarded. A missing user agent is recorded as `Other`.
- **Failed attempts with no known person.** A failure whose address matches no user writes no row;
  it is counted only in the OpenTelemetry counter `auth.sign_in.failed`, labelled by `method` and
  seeded at zero for each method. The counter counts every failure, including those with no known
  user and those of OAuth and magic-link endpoints. The table never holds the address that was
  tried, only the id of an existing user.
- **OAuth and magic-link failures.** These carry no address the gateway reads, so they are counted
  by the counter only and write no row.
- **Writing.** Sign-in events go through the activity queue when it is running, so they share its
  dedupe, buckets and batching. Before the queue starts and after it closes they are written
  directly. Failure to write is logged and never fails or alters the sign-in or the auth response.

## 8. User analytics (ADMIN)

The dashboard at `/admin/user-analytics` shows platform-wide figures for a window of up to 30 days:
daily, weekly and monthly active users and stickiness (daily over monthly), sign-ins and failed
sign-ins with their methods and coarse browser and OS families, active sessions, new users, actions
by entity type, peak hours, the most active people and the 20 most recent failed sign-ins. It also
lists every person, searchable by email or name and sortable. `/admin/user-analytics/users/[id]` is
one person's profile: sign-in and sign-out history, sessions still valid, actions by entity type,
daily counts and, when page views are on, the pages they viewed. The dashboard and the profile page are ADMIN only. The in-app assistant is refused every
analytics endpoint, including the alert list and the export.

| Route | Returns |
|---|---|
| `GET /api/v1/platform/analytics/overview?days=` | Tiles, per-day series, breakdowns, top people and recent failures |
| `GET /api/v1/platform/analytics/users?days=&limit=&offset=&order=&sort=&q=` | One row per person; `sort` is `lastActive`, `actions`, `signIns`, `failed` or `email` |
| `GET /api/v1/platform/analytics/users/:id?days=` | One person's profile. Tagged `read`, so opening it is itself recorded |
| `GET /api/v1/platform/analytics/users/export?days=&order=&sort=&q=` | The people list as a CSV file, for every match up to 5,000 people. Tagged `export` (section 10) |
| `GET /api/v1/platform/analytics/alerts` | Accounts over the failed sign-in threshold (section 9) |

`days` is 1 to 30 (14 by default). The people list takes `limit` 1 to 100 (25 by default).

**Active on a day.** A person is active on a UTC day when they have a `sign_in`, `ui`, `read` or
`export` event, or an audit-log row as the actor other than a `Session` row (a launch counts; a
denial does not). Daily active users is the last UTC day, weekly the last seven days and monthly
the 30-day window.

**Cost and caching.** The overview and the people list share one scan of the 30-day window: one
grouped count per UTC day and source, three days at a time, cached for 30 seconds. Rows are read
back only where a grouped count cannot answer (methods, browsers, peak hours and histories), and
every such read is capped. The scan and the caps are in
`packages/gateway/src/routes/userAnalytics.ts`.

## 9. Failed-sign-in alerts

The alert list flags accounts that take repeated failed password sign-ins. It is read from the
`sign_in_failed` rows of section 7, so it covers those failures and no others.

**Settings.** `analytics.failedSignInAlertThreshold` (default 5 failures, 2 to 100) and
`analytics.failedSignInAlertWindowMinutes` (default 15 minutes, 1 to 1440). Both are ADMIN, GLOBAL
only, and take effect without a restart: the list reads them each time it is built.

**The list.** `GET /api/v1/platform/analytics/alerts` (capability `platform.audit.read`) returns the
accounts whose `sign_in_failed` rows inside the window reach the threshold, most failures first. Each
entry gives the email and name, the failure count, the first and last failure, the methods seen, and
`signedInAfter`, which is true when the account has a `sign_in` event later than its first failure
in the window. The response lists at most 50 accounts and sets `truncated` when there were more. It
is cached for 10 seconds per gateway process. The alert card on `/admin/user-analytics` shows the
list; when the request fails the card says the state is unknown, not that no account is over the
threshold.

**What the count means.** Each failed password sign-in to a known address is one row, up to 30 rows
per person a minute (section 2). A burst beyond that is dropped and counted, so the list can read
lower than the real number of attempts. A threshold above 30 times the window in minutes can never
be reached; the endpoint reports `thresholdReachable`, `failuresRecordedPerMinute` and
`maxRecordable`, and the card warns when the configured threshold is unreachable.

**The threshold counter.** `auth.sign_in.threshold_exceeded`, an OpenTelemetry counter labelled by
`method`, rises once per account per window when failed password sign-ins to a known address reach
the threshold. Its state is in memory in each gateway process, not in the database:

- It counts every such attempt, including those beyond the 30-a-minute recording budget, so it can
  see a burst that the list undercounts.
- Its window slides, like the list's. It keeps the most recent failure times for the account, up to
  the threshold, and reports when that many fall inside the configured length. It reports again only
  after the count has dropped below the threshold.
- Each replica keeps its own windows, so one burst split across replicas can cross nowhere, and a
  single account can cross once per replica.
- The map holds at most 10,000 accounts. When it is full, expired windows go first, then the oldest,
  so a flood of distinct accounts can make an account report again.

**Nothing else is notified.** Alerts appear on the dashboard and in the counter. There is no Slack,
email or webhook delivery. The in-app assistant may not read the list.

## 10. People export (CSV)

`GET /api/v1/platform/analytics/users/export` (capability `platform.audit.read`) downloads the people
table as a CSV file. It takes the people list's `days`, `q`, `sort` and `order`, and no paging. The
file holds every person matching the search, in the list's order. When more than 5,000 people match,
the route answers `413` with code `EXPORT_TOO_LARGE` and asks the admin to narrow the search with
`q`; it never returns a partial file. It is
served as an attachment named `user-analytics-<days>d.csv`, with `Cache-Control: no-store`, and is
built from the same scan the list uses (section 8), so it shares that 30-second cache.

Columns, in order: `email`, `name`, `role`, `userId`, `createdAt`, `lastActiveAt`, `lastSignInAt`,
`signIns`, `failedSignIns`, `actions`, `activeDays`, `activeSessions`. Each matches the list's field
of the same name in section 8. `lastSignInAt` is all-time, as it is in the list.

Each successful download writes one `export` row (section 1). An export row is not deduplicated, so
every download is recorded, within the export budget of 60 a minute per person. An export can still
be dropped when the queue is full of other exports, denials and sign-ins (section 2). The row records
who downloaded and when; it does not track the file after the download. The dashboard's export button
calls this route.

A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`, so a
spreadsheet does not run it as a formula. Numbers are written as they are. The file holds emails and
names, which is why each download is recorded.

## 11. Backfilling earlier sign-ins

Sign-ins recorded before sign-in events carried a method exist only as `Session` audit rows, so
section 8's figures leave them out until they are copied. An opt-in script copies them. It never runs
at boot:

```bash
yarn workspace @auto-swe/gateway backfill:sign-ins -- --dry-run
yarn workspace @auto-swe/gateway backfill:sign-ins
```

It reads audit rows with `afterJson.event = 'sign_in'`, no `method` key and an actor, created inside
the activity retention window (`analytics.activityRetentionDays`). Each becomes a `sign_in` event at
the audit row's timestamp, with route `auth:unknown`, `props.method` `unknown`, `props.backfilled`
true, and the address the audit row kept. A row is skipped when the same person already has a
`sign_in` event within five seconds of it, so a second run inserts nothing. It reads in batches of
500 and stops at `--max-rows` (default 1,000,000); run it again to continue.

Backfilled sign-ins count toward sign-in totals, last sign-in and active days. Their method shows as
`unknown` on the person's page. The script copies no failed sign-ins, because the audit log never
recorded them; failures from before the table are absent from section 9.

## Limitations

- A denial with no identified actor is a metric only, so the table cannot answer who tried it.
- Reads on routes that are not tagged are not recorded. Tagging a route is a code change.
- Only the exports named above are recorded; any other bulk read is recorded only once its route is
  tagged `config: { activity }`.
- Dedupe means repeated reads collapse: the table shows that someone read a route in a ten-minute
  window, not how many times.
- Page views are opt-in, and a browser that sends Do Not Track is invisible. The last few seconds of
  views before a tab closes are lost, since the batch is sent on a timer. A browser that has been told
  `enabled: false` stays quiet until it reloads, even if an operator switches page views on.
- The drop counter and the queue are per gateway process; with several replicas the page shows the
  replica that answered.
- Events still in the queue when a gateway process is killed are lost.
- Per-person rate limiting and dedupe state live in each gateway process, so with several replicas
  the bounds apply per replica.
- A `403` from the gateway's own hooks before routing (an unmatched route is a `404`) is not an event.
- Sign-in events start at the deployment of this code. Earlier sign-ins are counted only after the
  backfill in section 11 has been run, and the backfill copies only those inside the retention window.
- A failed sign-in is in the table only for a password sign-in to a known address. OAuth, magic-link
  and unknown-address failures are counted by `auth.sign_in.failed` alone, so the table cannot say
  who they were.
- At most 30 failed sign-ins per person are recorded each minute, so a very fast burst is recorded
  in part, while the counter sees every attempt.
- A sign-out writes nothing when its session has already expired or its cookie is gone.
- Active-user counts come from recorded events. With page views off, a person who only browses is
  not counted as active; they count once they sign in, read a tagged route, export or make a change.
- The analytics window is at most 30 days, and history never exceeds the retention in section 5.
- The analytics caps are 5,000 rows per scan (sign-ins and actions), 5,000 people in the list, and 50
  sign-in and 50 action rows in one person's history. When a cap cuts into the requested window the
  response sets `truncated: true`, and the dashboard shows a warning that its counts are partial.
- The analytics cache is 30 seconds per gateway process, so with several replicas two requests can
  show different numbers for up to that long.
- Browser and OS are coarse families. An unrecognised browser or system shows as `Other`.
- The alert list covers password sign-ins to a known address only. OAuth, magic-link and
  unknown-address failures never reach it, and they are not in the counter either.
- The methods shown for an alert come from the 2,000 most recent failure rows in the window. Past that
  cap a method can be missing from the list, though the failure count is exact.
- Alerts have no notification channel. The dashboard card and the counter are the only outputs.
- The threshold counter is per process and in memory. It resets on restart, counts every attempt,
  reports once per account per crossing, and reports separately from each replica (section 9).
- The threshold counter holds at most 10,000 accounts, so an account can report again after eviction.
- The alert list is capped at 50 accounts, sets `truncated` beyond that, and is cached for 10 seconds
  per process.
- The people export refuses with `413` when more than 5,000 people match, so a large deployment
  exports a narrower search at a time. The file is a snapshot of the scan taken at request time.
- The backfill copies sign-ins only, never failures, and each backfilled sign-in carries method
  `unknown`. Sign-ins older than the retention window are not copied.
