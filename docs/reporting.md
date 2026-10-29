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
the fallback when no team is available. This attribution does not change run visibility.

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
`REPORT_DIGEST_CRON` to change the schedule. Digests require workflow-run rollups to be enabled;
`REPORT_DIGEST_CRON` must run after `WORKFLOW_RUN_ROLLUP_CRON`. The sweep skips delivery and
retries on its next run when any of the 14 required completed UTC days has no rollup rows. A
subscription is claimed once per reporting period before delivery, so a failed email or Slack
channel is recorded but is not retried in the same period. Send-test bypasses the weekly claim and
does not change the scheduled last-sent timestamp; its one-minute limit is stored in Postgres.
Email uses the platform SMTP configuration when available, otherwise the configured Resend
transport.

## Limitations

- CLI and MCP report commands are not available.
- Non-ADMIN reporting visibility is based on persisted attribution: a row is included when its
  `teamId` (`WorkflowRun.attributedTeamId`) is one of the caller's member teams, or its `orgId`
  (`WorkflowRun.attributedOrgId`) is an organization where the caller is `ORG_ADMIN`. ADMIN sees
  all rows, including null-attribution rows; null-attribution rows are excluded for everyone else.
  This rule is applied to every slice in a rollup-backed response, including headline metrics,
  group-bys, selected runs, steps, and quality traces. ORG_ADMIN therefore sees every run
  attributed to their organization even when `buildWorkflowRunVisibilityFilter` would hide it;
  requester-only and shared-connection visibility do not apply to these reports. A `teamId` filter
  is allowed only for a caller's member team or a team in an organization they administer;
  otherwise the route returns 403. Non-rollup reads retain the normal run-visibility filter and
  add the selected team filter.
- Template names hidden by the workflow-template visibility rule, channel names hidden by channel
  access, and repository names blocked by the repository-access gate are masked as `Private
  template`, `Private channel`, and `Inaccessible repository`; the corresponding counts remain.
- Run and merge duration percentiles are approximate. Duration buckets use sub-second bounds,
  then grow logarithmically; percentile ranks are interpolated inside each bucket (linearly from
  zero in the first bucket, logarithmically thereafter). When the entire requested window is live,
  duration percentiles use the exact run durations already read for the response. CI-fix p95 and
  average use an exact attempt-count histogram for 0–19; its 20+ overflow bucket is represented as
  20.
- Rollups are rebuilt daily and recomputed over the shared
  `WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS` horizon to include recent outcomes. Older days are rebuilt
  when a run ends, a linked pull request merges or closes, or a human step resolves after the
  previous successful sweep. At most 60 dirty days are rebuilt per sweep, oldest first; remaining
  days wait for a later successful sweep. `rollupDays` and `liveDays` show which dates came from each
  source; rows with an obsolete duration-bucket version count as uncovered, and truncation flags
  apply only to live reads. Global analytics daily series and duration percentiles, template
  per-version duration/PR statistics, and delivery metrics use this hybrid reader. Set
  `WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS` to populate older history; the default of zero leaves older
  history on the live path.
- Approval source counts use `resolvedVia`; historical rows with no source are reported as
  `unknown`.
- User records do not expose a service-principal or API-token approver flag, so approval counts
  cannot separate people from machine identities. The human-step HTTP route requires a user
  principal and does not admit service-principal tokens.
- Historical pull requests without a repository-matched active workflow and run remain unattributed.
- Historical human-step and approval records do not have a resolution source and remain null.
- Historical runs whose workspace connection (`runConnectionId`) differs from their repository
  may be attributed differently by the backfill than by runtime attribution.
