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
profile (`/api/v1/platform/analytics/users/:id`). The activity views and the analytics overview and
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
  row per person, route and status every minute, one sign-in event per person, kind and method every
  minute, and one page view per person and page every five seconds. The remembered keys are a small
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
daily counts and, when page views are on, the pages they viewed. Both are ADMIN only, and the
in-app assistant is refused all three endpoints.

| Route | Returns |
|---|---|
| `GET /api/v1/platform/analytics/overview?days=` | Tiles, per-day series, breakdowns, top people and recent failures |
| `GET /api/v1/platform/analytics/users?days=&limit=&offset=&order=&sort=&q=` | One row per person; `sort` is `lastActive`, `actions`, `signIns`, `failed` or `email` |
| `GET /api/v1/platform/analytics/users/:id?days=` | One person's profile. Tagged `read`, so opening it is itself recorded |

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
- Sign-in events start at the deployment of this code. Earlier sign-ins are in the audit log only and
  are not counted by the analytics or the activity views.
- A failed sign-in is in the table only for a password sign-in to a known address. OAuth, magic-link
  and unknown-address failures are counted by `auth.sign_in.failed` alone, so the table cannot say
  who they were.
- Failures are deduped to one row per person and method each minute, so a burst of guesses against
  one account shows as one row, while the counter shows every attempt.
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
