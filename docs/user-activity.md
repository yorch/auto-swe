# User activity

User activity events are a first-party record of three things: who was refused, who looked at
something sensitive, and, only when an operator switches it on, which dashboard pages people open.
They live in the platform's own database (`user_activity_events`, `UserActivityEvent`); nothing is
sent to a third party and no client-side analytics library is loaded. They answer "who is probing
what they may not reach" and "who exported this", not "how long did someone stay on a page".

This is not the [audit log](./audit-log.md). The audit log records actions that change state and
is kept until an operator says otherwise; activity events record refusals and reads, and expire.

## 1. What is recorded

Each row carries `kind`, `route`, `method`, `status`, `actorId`, `via`, `requestId`, a truncated
`ip`, a small `props` object and `createdAt`.

| Kind | When | Actor |
|---|---|---|
| `denied` | A signed-in person is answered `403`: a platform or team role check, or a handler's own refusal | The person |
| `read` | A successful `GET` of a route tagged as a sensitive read | The person |
| `export` | A successful `GET` of a route tagged as an export | The person |
| `ui` | A page view reported by the dashboard (opt-in, section 3) | The person |

`route` is the route **template** the router matched (`/api/v1/workflow-runs/:id`), never the URL.
No request body, query string, header or path parameter value is stored, so a search term typed into
a filter or a run id never reaches the table.

A route opts in with `config: { activity: 'read' | 'export' }` on its definition, so every mount of
it is covered, the deprecated `/api/v1/admin` aliases included. The tagged routes are the audit-log
list and export, a run's detail and the pull-request outcomes export. The activity views are not tagged, so reading this feature's own
pages records nothing, and neither is a run's traces or a transcript read (a transcript access
already writes a fuller row to the transcript access log, [transcripts.md](./transcripts.md)).
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
  row per person, route and status every minute, and one page view per person and page every five
  seconds. The remembered keys are a small bounded map, so memory does not grow.
- **Rate.** Each person has a budget per kind, refilled continuously: 120 denials, 60 exports, 60 reads
  and 60 page views a minute. The budgets are separate, so a flood of page views, reads or distinct
  denied routes cannot use up the one that records an export, and a flood of denials cannot starve
  exports either. The excess is dropped and counted; an authenticated caller is rate-bounded, not
  unbounded. A dropped event does not mark its dedupe key, so the same event is recorded once the
  budget refills.
- **Queue.** Rows go to an in-memory queue (1,000 events) flushed in batches of up to 100, every five
  seconds or when a batch fills. When it is full, a `denied` or `export` event evicts the oldest page
  view, then the oldest read, before it would be dropped; a page view or read never displaces
  anything. A failed batch write is dropped, not retried. An export or denial can still be dropped when the
  queue is full of other exports and denials.

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

Both are ADMIN-only and are refused to the in-app assistant.

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
- Addresses are truncated before storage; the user agent is not stored.
- Refusals with no signed-in person leave no personal data at all, only a counter.
- Page views are opt-in, honour Do Not Track, and expire like everything else here.
- A row names its actor by id. Deleting a user does not delete their events; retention does.

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
