# Reporting

The admin Reports page summarizes delivery, quality, budget, automation, and human-approval
activity. The selected UTC date range applies to delivery, quality, automation, and approval
reports. Budget reports always use the current UTC calendar month. Each tab exports its displayed
report as a client-generated CSV.

## Delivery

Delivery cohorts are workflow runs whose `startedAt` falls inside the selected window. The funnel
counts runs started, successful runs, and runs linked to at least one pull request. CI-passed and
merged values count pull requests, not runs. Cost per merged pull request divides the cost of all
cohort runs by the number of merged pull requests; it is unavailable when no pull request merged.
Median time to merge measures from the cohort run's start to each linked pull request's merge.

Template and repository slices use the same funnel. Repository health also includes spend and run
success rate from active workflows grouped by repository. Pull requests whose repository does not
match their linked active workflow are not attributed to a run.

## Quality

Gate pass rates include only `PASSED` and `FAILED` workflow steps. Fix-loop rounds count step rows
per run. CI self-heal rate is the share of runs with a CI fix that have a linked pull request with
passed CI or a merge.

Review verdicts are parsed defensively from reviewer trace output. The stored trace agent key is
`reviewer`; the individual persona is recorded in the verdict's `reviewer` field (`SECURITY`,
`DOMAIN_LOGIC`, or `PERFORMANCE`). Invalid verdict payloads are excluded from reviewer statistics
and counted as unparseable. The merge comparison groups cohort runs with pull requests by whether
any parsed verdict rejects the run.

## Budget

Each authorized organization shows its monthly budget, alert threshold, month-to-date spend,
elapsed UTC days, month length, and projected spend. Projection uses fractional elapsed days. A
projection from less than one elapsed day is still shown and marked low confidence. The status
prioritizes actual overspend, projected overspend, an alert threshold, and then an in-budget state.
Organizations without a cap show `no_cap`. The report lists the five highest-cost runs started in
the current month for each organization.

## Automations

Automation activity counts fires and their outcomes and reasons, last fire time, starts, failed
starts, and suppression categories. An automation is noisy when it has at least ten fires and more
than half are suppressed. It is broken when a start fails or when at least three starts have no
successful produced workflow run.

## Approvals

Approval reporting counts human steps by kind and status, resolution waits for resolved steps,
timeouts, currently pending steps, and the oldest pending age. Approvers are grouped by the
resolving user. Autonomy decisions are counted by event and risk class.

## Data bounds

Report reads are capped at 10,000 rows and responses include a `truncated` flag when a source
exceeds that bound. Budget top-run lists intentionally show at most five runs per organization;
each organization indicates when more ranked runs exist.

## Limitations

- Scheduled Slack and email report digests are not available.
- CLI and MCP report commands are not available.
- Delivery reports do not include a team slice because workflow runs do not have a reliable
  run-to-team relationship.
- Reports use live bounded reads; a daily run-rollup table is not available.
- User records do not expose a service-principal or API-token approver flag, so approval counts
  cannot separate people from machine identities.
