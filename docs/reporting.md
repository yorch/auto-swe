# Reporting

The admin Reports page summarizes delivery, quality, budget, automation, and human-approval
activity. The selected UTC date range applies to delivery, quality, automation, and approval
reports. Budget reports always use the current UTC calendar month. Each tab exports its displayed
report as a client-generated CSV.

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

## Quality

Gate metrics are grouped per `(run, gate)` pair. The first-attempt pass rate is the share of pairs
with a `PASSED` row and no `FAILED` row; the final pass rate is the share with any `PASSED` row.
Attempt counts sum `PASSED` and `FAILED` rows. Fix-loop attempts count terminal `PASSED` and
`FAILED` rows and report both runs with a fix and average attempts per such run. CI self-heal rate
is unchanged: the share of runs with a CI fix that have a linked pull request with passed CI or a
merge.

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
resolving user. Autonomy decisions are counted by event and risk class. Resolved steps and approvals
record `resolvedVia` as `web`, `slack`, `api_token`, `mcp` or `assistant`; historical rows remain
null.

## Data bounds

Report reads are capped at 10,000 rows and responses include a `truncated` flag when any bounded
source exceeds that bound, alongside a per-source truncation flag. Quality workflow-step metrics
use an uncapped `groupBy` over the bounded run cohort. Budget top-run lists intentionally show at
most five runs per organization; each organization indicates when more ranked runs exist.

## Limitations

- Scheduled Slack and email report digests are not available.
- CLI and MCP report commands are not available.
- Non-ADMIN reporting visibility is based on persisted attribution: a row is included when its
  `teamId` (`WorkflowRun.attributedTeamId`) is one of the caller's member teams, or its `orgId`
  (`WorkflowRun.attributedOrgId`) is an organization where the caller is `ORG_ADMIN`. ADMIN sees
  all rows. The same rule applies to rollup and live slices. A `teamId` filter is allowed only for
  a team the caller belongs to or whose organization the caller administers; otherwise the route
  returns 403. This replaces `buildWorkflowRunVisibilityFilter` for rollup-backed reports, while
  non-rollup reads retain that visibility filter and add the team filter.
- Run and merge duration percentiles are approximate: values fall into logarithmically spaced
  buckets and the reader returns the bucket's geometric midpoint. CI-fix p95 and average use an
  exact attempt-count histogram for 0–19; its 20+ overflow bucket is represented as 20.
- Rollups are rebuilt daily and recomputed over the configured horizon to include late outcomes.
  `rollupDays` and `liveDays` show which dates came from each source; truncation flags apply only
  to live reads. Freshness is bounded by the daily schedule and the recompute window.
- Approval source counts use `resolvedVia`; historical rows with no source are reported as
  `unknown`.
- User records do not expose a service-principal or API-token approver flag, so approval counts
  cannot separate people from machine identities. The human-step HTTP route requires a user
  principal and does not admit service-principal tokens.
- Historical pull requests without a repository-matched active workflow and run remain unattributed.
- Historical human-step and approval records do not have a resolution source and remain null.
