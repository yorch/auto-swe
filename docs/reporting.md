# Reporting

The admin Reports page summarizes delivery, quality, budget, automation, and human-approval
activity. The selected UTC date range applies to delivery, quality, automation, and approval
reports. Budget reports always use the current UTC calendar month. Each report tab exports its
displayed sections as a client-generated CSV. The Digests tab manages scheduled weekly reports.

Platform analytics time saved is the sum of each successful run's estimate, snapshotted from the
template when the run started.

Workflow runs store nullable reporting-only team and organization attribution. The team resolver
uses the run connection, work-request connection, channel, requesting service, then template, in
that order; the selected team's organization wins, with the work request's billing organization as
  the fallback when no team is available. Reporting visibility combines persisted attribution
  with organization opt-in, reachable repository, and launcher ownership.

Pull requests store their template id, template version and associated run id. Writers and the
historical backfill associate a PR only through an active workflow in the same repository.
`WorkflowRun.workflowId` is unique, so the associated run is resolved by that exact workflow id,
not by recency. Outcomes, per-version template analytics and report cohorts read these persisted
fields instead of dynamically joining recent runs.

## Delivery

Delivery cohorts are workflow runs whose `startedAt` falls inside the selected window. The funnel
counts runs started, successful runs, and runs linked to at least one pull request. CI-passed and
merged values count pull requests, not runs. Cost per merged pull request divides the cost of all
cohort runs by the number of merged pull requests; it is unavailable when no pull request merged.
Median time to merge measures from the cohort run's start to each linked pull request's merge.

Template and repository slices use the same funnel. Repository health also includes spend and run
success rate from visible cohort runs grouped by repository. Delivery spend uses each run's
`WorkflowRun.costUsdAccrued`; when that value is zero, the matching `ActiveWorkflow.costUsdAccrued`
is used as the legacy fallback. Totals, template and repository slices, and cost per merged pull
request use that same run-level amount. Pull requests whose repository does not match their linked
workflow are not attributed to a run.
Delivery also groups the cohort by persisted team attribution, including an `Unattributed` row.
The optional `teamId` filter applies to both the daily rollup and live slices. Delivery labels
repository, template, and team slices; inaccessible repository names appear as `Inaccessible
repository`, and templates hidden by the workflow-template visibility rule appear as `Private
template`, without dropping their counts.

## Quality

Gate metrics are grouped per `(run, gate)` pair. The first-attempt pass rate is the share of pairs
with a `PASSED` row and no `FAILED` row; the final pass rate is the share with any `PASSED` row.
Attempt counts sum `PASSED` and `FAILED` rows. Fix-loop attempts count terminal `PASSED` and
`FAILED` rows and report both runs with a fix and average attempts per such run. CI self-heal rate
is the share of runs with a CI fix that have a linked pull request with passed CI or a merge. The
self-heal and merge-rate cohorts combine rollup and live rows using persisted run/PR attribution.

Review verdicts are parsed defensively from reviewer trace output. The stored trace agent key is
`reviewer`; the individual persona is recorded in the verdict's `reviewer` field (`SECURITY`,
`DOMAIN_LOGIC`, or `PERFORMANCE`). Traces are restricted to cohort run ids, exclude records with
an error and records without an `approved` key, and do not use a separate trace timestamp window.
Remaining malformed verdict payloads are excluded from reviewer statistics and counted as
`nonVerdictRows`. The merge comparison groups cohort runs with pull requests by whether any parsed
verdict rejects the run.

## Budget

Each authorized organization shows its monthly budget, alert threshold, month-to-date spend,
elapsed UTC days, month length, and projected spend. Projection uses fractional elapsed days. A
projection from less than one elapsed day is still shown and marked low confidence. The status
prioritizes actual overspend, projected overspend, an alert threshold, and then an in-budget state.
Organizations without a cap show `no_cap`. The report lists the five highest-cost runs started in
the current month for each organization, attributed with the same organization ownership precedence
as month-to-date spend. Top runs are filtered by the caller's run visibility, so they may be a
partial view of the organization's highest-cost runs.

## Automations

Automation activity counts fires and their outcomes and reasons, last fire time, starts, failed
starts, and suppression categories. An automation is noisy when it has at least ten fires and more
than half are suppressed. It is broken when a start fails or when at least three starts have no
successful produced workflow run.

## Approvals

Approval reporting counts human steps by kind and status, resolution waits for resolved steps,
timeouts, currently pending steps, and the oldest pending age. Approvers are grouped by the
resolving user with interactive (`web`, `slack`) and automated (`api_token`, `mcp`, `assistant`)
counts. Resolved steps are also split by `resolvedVia`; null or unrecognized historical values are
reported as `unknown`. Autonomy decisions are counted by event and risk class.

## Data bounds

Report live reads are capped at 10,000 rows and responses include a `truncated` flag when any
bounded live source exceeds that bound, alongside a per-source truncation flag. Quality
workflow-step metrics use an uncapped `groupBy` over the bounded run cohort. Budget top-run lists
intentionally show at most five runs per organization; each organization indicates when more
ranked runs exist.

## Weekly digests

Digest subscriptions target exactly one organization or team and deliver weekly summaries by email,
Slack, or both. They compare the last seven completed UTC days with the seven days before them,
including delivery metrics, top templates, the worst gate when at least ten run/gate pairs exist,
pending approval age, and organization budget status. Organization subscriptions include budget
data; team subscriptions do not. Send-test delivers immediately without changing the scheduled
last-sent timestamp.

The weekly sweep runs Mondays at 13:00 UTC when `REPORT_DIGEST_ENABLED` is true. Configure
`REPORT_DIGEST_CRON` to change the schedule. Each workflow anchors one reporting period to its
start time: the previous ISO week, Monday 00:00 through Sunday 23:59:59 UTC. Retries and schedule
catch-up reuse that period. Digests require workflow-run rollups to be enabled;
`REPORT_DIGEST_CRON` must run after `WORKFLOW_RUN_ROLLUP_CRON`. If any of the 14 required completed
UTC days has no rollup rows, the workflow retries the coverage check up to six times, sleeping 15
minutes between passes, and records `rollup_incomplete` if coverage remains unavailable. Each
email address and Slack channel has its own durable delivery row for a reporting period. Failed
targets are retried after 15 minutes, for at most three attempts; targets already sent are not sent
again. Activity-level retries are disabled so the workflow owns the retry policy. The activity
refuses to create rows for a period less than six days after the last fully delivered period, or
earlier than any existing delivery period.

Email targets opted out on the subscription are excluded. The email includes a table-based HTML
report, a plain-text alternative, and `List-Unsubscribe` plus RFC 8058
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Opening the public unsubscribe URL
only renders a confirmation form; the form and one-click mail-client POST both opt out through
POST to that URL. Both methods are rate limited. The recipient-bound link uses a purpose-specific
HMAC key derived from the existing `CONFIG_ENCRYPTION_KEY`; no separate unsubscribe secret is
configured. Keep the previous encryption key in `CONFIG_ENCRYPTION_KEY_PREVIOUS` while links
signed by it need to remain valid. Removing that old key invalidates its outstanding unsubscribe
links. Plus-address variants (for example, `reports+weekly@example.test`) are separate recipient
targets and must be managed as distinct addresses.

Managers can see opted-out addresses in the Digests tab. Re-adding one requires confirmation and
records the manager in the audit log. `lastPeriodStart` is retained as the last fully delivered
period for display and as a guard against near-duplicate periods; the migration clears legacy
claim-era values so the displayed date has consistent meaning. Only a period whose active targets
all succeed is recorded. Send-test bypasses delivery-row persistence, records failures separately
from scheduled delivery status, and does not change the scheduled last-sent timestamp; its
one-minute limit is stored in Postgres. Email uses the platform SMTP configuration when available,
otherwise the configured Resend transport.

## Limitations

- CLI and MCP report commands are not available.
- Non-ADMIN reporting visibility includes runs attributed to the caller's teams, runs attributed
  to an organization where the caller is ORG_ADMIN and `analytics.orgWideReports` is enabled, runs
  on repositories reachable through the caller's teams and GitHub permission gate, and runs
  launched by the caller. The four predicates form one OR, so a run matching multiple predicates
  contributes once. ADMIN sees all rows, including null-attribution rows. A `teamId` filter remains
  team-only and is allowed for a member team or a team in an organization with the opt-in enabled;
  otherwise the route returns 403. Live and rollup report slices use the same run-to-repository
  mapping. HITL uses this same scope for live and historical rows.
- Organization-wide digest creation, updates, test sends, and scheduled delivery require
  `analytics.orgWideReports`; disabled subscriptions remain stored but scheduled delivery skips
  them without creating delivery rows.
- Template names hidden by the workflow-template visibility rule, channel names hidden by channel
  access, and repository names blocked by the repository-access gate are masked as `Private
  template`, `Private channel`, and `Inaccessible repository`; the corresponding counts remain.
- Run and merge duration percentiles are approximate. Duration buckets use sub-second bounds,
  then grow logarithmically; percentile ranks are interpolated inside each bucket (linearly from
  zero in the first bucket, logarithmically thereafter). When the entire requested window is live,
  run and HITL wait percentiles use the exact values already read for the response; mixed and
  rollup-backed windows use bucket interpolation. CI-fix p95 and average use an exact attempt-count
  histogram for 0–19; its 20+ overflow bucket is represented as 20.
- Rollups are rebuilt daily and recomputed over the shared
  `WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS` horizon to include recent outcomes. Older run days are
  dirtied by `WorkflowRun.updatedAt`, `PullRequest.updatedAt`, completion of a CI-fix
  `WorkflowStep`, or creation of a reviewer `AgentTrace`; human-step requested days are dirtied
  separately by `resolvedAt` for the approval rollup. Run deletions are not detected. Detection
  uses a fixed one-hour overlap and advances its watermark to the current sweep time only after
  that sweep's selected days rebuild successfully. At most 60 dirty days are rebuilt per sweep,
  oldest first; the durable backlog carries remaining days to later sweeps. `rollupDays` and
  `liveDays` show which dates came from each source; rows
  with an obsolete duration-bucket version count as uncovered, and truncation flags apply only to
  live reads. Global analytics daily series and duration percentiles, template per-version
  duration/PR statistics, delivery metrics, and the HITL and reviewer report slices use these
  hybrid readers. Set `WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS` to populate older history; the default
  of zero leaves older history on the live path.
- Approval source counts use `resolvedVia`; historical rows with no source are reported as
  `unknown`.
- HITL approval rollups use the UTC day of `requestedAt` and retain kind, status, resolution source,
  approver, timeout, and resolved-wait histogram measures. Reviewer rollups use the UTC day of
  `WorkflowRun.startedAt` and retain reviewer, severity, approval, findings, category, and
  malformed-verdict measures. Both carry a bucket version and persisted organization/team
  attribution. Pending approvals remain an uncapped live count plus the oldest `findFirst` row.
  If an approver account is no longer available, the report labels it `Unknown approver` rather than
  exposing its stored user ID.
- User records do not expose a service-principal or API-token approver flag, so approval counts
  cannot separate people from machine identities. The human-step HTTP route requires a user
  principal and does not admit service-principal tokens.
- Historical pull requests without a repository-matched active workflow and run remain unattributed.
- Historical human-step and approval records do not have a resolution source and remain null.
- Historical runs whose workspace connection (`runConnectionId`) differs from their repository
  may be attributed differently by the backfill than by runtime attribution.
