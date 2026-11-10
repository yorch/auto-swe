# Outcome metrics

A report of what the platform's runs achieved, computed from the deployment's own run data: merge
rate, review rounds, CI-heal rate, time to merge and cost per merged pull request, per workflow
template and per repository. It reports failures next to successes, states every denominator, and is
reproducible: the same rows and the same window always give the same figures.

The numbers belong to the deployment that produced them. This repository carries the method and the
generator; it carries no figures, because none come from a deployment it can read. An operator runs the
report against their own data (see [Publishing your numbers](#6-publishing-your-numbers)).

It extends the [delivery report](./reporting.md#delivery), which answers the same questions per run
for a signed-in user's visible scope and reads daily rollups. The outcome report differs in three
ways: it spans the whole deployment (so it is ADMIN-only), it groups attempts at the same ticket into
one **work item** so retries are charged to the work that eventually merged, and it adds merge rate
over settled work, review rounds and the cost of work that never merged.

## 1. Getting the report

| Surface | What it gives |
|---|---|
| `GET /api/v1/reports/outcomes?windowDays=90&format=json\|markdown` | Computes the report now over the trailing `windowDays` complete UTC days (7 to 365, default 90). ADMIN only. |
| `GET /api/v1/reports/outcomes/latest?format=json\|markdown` | The newest stored snapshot from the scheduled regeneration. ADMIN only. `404` until the first one is written. |

With `format=markdown` the response is the report as Markdown, rendered from the same JSON by the same
function, so the two never disagree. The JSON shape is `OutcomeReport` in
`packages/shared/src/workflow/outcomeMetrics.ts`.

```bash
curl -s -H "Authorization: Bearer $AUTO_SWE_TOKEN" \
  "$GATEWAY/api/v1/reports/outcomes/latest?format=markdown" > outcome-metrics.md
```

## 2. Scheduled regeneration

The gateway registers one system-wide Temporal Schedule, `auto-swe-outcome-report`, at startup. It
runs `ScheduledOutcomeReportWorkflow`, a single `generateOutcomeReport` activity that builds the
report over the trailing 90 complete UTC days and stores it as a `workflow_artifacts` row of kind
`outcome-report` through the artifact store (so it lands wherever artifacts are configured to land).
The newest eight snapshots are kept; older ones are deleted at the end of each run, and a failed
deletion is retried by the next run without losing the new snapshot.

| Variable | Default | Meaning |
|---|---|---|
| `OUTCOME_REPORT_ENABLED` | `true` | `false` pauses the schedule. The routes still compute on demand. |
| `OUTCOME_REPORT_CRON` | `37 2 * * 1` | Five-field cron, UTC. Mondays, after the nightly rollups. |

Like the other scheduled sweeps these are environment-only and applied once at gateway startup; a
change needs a restart, and the gateway refuses to start on a value it cannot use. The window ends at
the start of the current UTC day, so two runs on the same day agree on their cohort.

## 3. Definitions

**Cohort.** Work items whose earliest run started inside the window. Runs are read from 30 days before
the window start so a retry of older work does not count as new work.

**Work item.** All runs for the same ticket in the same repository (case-insensitive ticket id).
A ticket id the platform generated itself (a launch that named no ticket) is only a correlation key,
so the work request groups instead; a run with no work request is its own item. A retry, a re-run and
a fix run launched after a failure therefore join the item they belong to.

**State of an item**, in this order:

| State | Rule |
|---|---|
| `merged` | any linked pull request has status `MERGED` |
| `open` | otherwise, any linked pull request is `OPEN` |
| `running` | otherwise, any run is still `RUNNING` |
| `closed_unmerged` | otherwise, it has pull requests and all are `CLOSED` |
| `no_pr` | otherwise: every run ended and none produced a pull request |

**Settled items** are `merged`, `closed_unmerged` and `no_pr`. `open` and `running` are undecided and
are counted and costed but left out of every rate's denominator.

| Metric | Definition |
|---|---|
| Merge rate | merged items / settled items, with a 95% Wilson interval. Items that failed, timed out or were cancelled without a pull request are in the denominator. |
| Decided PR merge rate | merged items / (merged + closed unmerged items): of the pull requests a human decided, the share merged. |
| Review rounds | per item with at least one pull request, the number of finished `executeReviewFixImplementation` steps across all its runs. Reported as mean, median, maximum and the number of items with at least one. |
| CI-heal rate | of items with at least one finished `executeCIFixImplementation` step and a pull request, the share whose pull request has CI `PASSED` or merged. |
| Time to merge | for merged items with a merge timestamp, the time from the item's earliest run start to its first merge. Median and p90 with the sample size. |
| Cost per merged PR | the recorded cost of every run in the cohort, retries and failures included, divided by the number of merged pull requests. Null when none merged. |
| Cost per merged PR, settled | the same, counting only items that settled, so work still in flight is not charged to the merges that have happened. |
| Spend on unmerged | the recorded cost of items that settled without a merge. |

Cost is each run's `costUsdAccrued`; when that is zero the matching `ActiveWorkflow` ledger row is
used, as in the delivery report. It is the model-call cost the platform recorded, nothing else.

**Attribution.** An item belongs to the template and repository of the run that merged it, else of its
latest run. A repository is the run's persisted `attributedRepoId`; a run without one is reported under
`Unattributed`.

**Low sample.** A group with fewer than 30 settled items is marked `low sample`. The interval is the
honest statement of how little a small group says.

## 4. What the report shows about failure

Besides the rates, the Markdown carries a table of items by state (merged, closed unmerged, ended
without a pull request, open, running), the count of runs by status, and the spend split into merged,
unmerged and undecided. A merge rate is read alongside the spend that did not produce a merge, and a
low cost per merged PR on a few merges is flagged as low sample rather than presented as a result.

## 5. Reading it correctly

- **Right-censoring.** A young window is mostly undecided work. Merge rate leaves it out and time to
  merge counts only merges that have already happened, so recent windows read fast and favourable. A
  window older than the deployment's usual time to merge is the fair comparison.
- **Heterogeneous work.** Templates differ in what they are asked to do; a merge rate is a property of
  a template on a repository's tickets, not of the platform.
- **Not a comparison to humans.** The report has no baseline for what the same work costs without the
  platform.

## 6. Publishing your numbers

1. Let the schedule run, or call `GET /api/v1/reports/outcomes/latest?format=markdown` (computing with
   `GET /api/v1/reports/outcomes` if no snapshot exists yet).
2. Keep the JSON beside the Markdown. Anyone with read access to the same database can regenerate the
   same figures for the same window with `GET /api/v1/reports/outcomes`, which is the reproducibility
   claim.
3. Check what a published copy discloses. The report names repositories and templates. Remove or rename
   them before sharing outside the organization.
4. State the window, the deployment size (runs and work items are in the report) and the low-sample
   marks. Publish the failure sections with the rest.

## Limitations

- The report does not count human review rounds on the pull request. Review rounds are the fix rounds
  the platform's own review network triggered. Change requests a person makes on the pull request are
  not counted.
- Ticket grouping needs a ticket id the launch named. Work launched without one is one item per work
  request, so a retry that creates a new request is counted as separate work.
- A retry of work whose first run is more than 30 days before the window start is counted as new work.
- Reads are capped at 50,000 runs; the report marks itself `truncated` and covers a subset when the
  cap is hit.
- Pull requests are joined to a run by `PullRequest.runId`. A pull request without a run is not in any
  item.
- Cost excludes human time, CI minutes and infrastructure, and a run recorded without cost counts as
  zero.
- The scheduled window is fixed at 90 days and the stored snapshot is the only history kept (the newest
  eight). Longer series need the JSON saved elsewhere.
- There is no redaction option and no CLI command; the output is read through the two API routes.
- No figures from any deployment are published with the repository.
