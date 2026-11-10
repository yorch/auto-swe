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
one **work item** so retries and review-fix follow-ups are charged to the work that eventually merged,
and it adds merge rate over settled work, review rounds and the cost of work that never merged.

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
so the work request groups instead; a run with no work request is its own item. A retry and a re-run
therefore join the item they belong to.

**Follow-up runs.** A review-fix or PR-feedback run launches under a platform-generated ticket id, so
it would otherwise be an item of its own. When its launch recorded the run it acts on, it joins that
run's item, with its cost and its review rounds. Two launches record it: a stored review fix
(`reviewFixOfRunId` in the run payload) and PR feedback started from review findings (a
`review_findings` trigger, whose `feedbackEventId` is the originating run's id). A chain of follow-ups
resolves to the first run. Any other PR-feedback run (a human's changes-requested review, a comment)
names a pull request and a GitHub event id, not a run, so it cannot be joined: it is a follow-up
**without an originating run**, reported under [work outside the merge rate](#work-outside-the-merge-rate)
and in no rate. The item is attributed to the template and repository of the run that merged it, else
of its latest run that is not a follow-up.

**Merge-rate work.** An item is in the merge rate when it has a linked pull request or at least one
run that could open one. A run could open one when its pinned template version names a
pull-request step (`createOrUpdatePullRequest`, `pushCiFixToPullRequest`,
`pushPrFeedbackToPullRequest`) or it is an agent run launched with `deliver: draft_pr`; a missing
template version counts as capable. A run that completed a Slack, Zendesk or Notion template, or a
review that only comments, is not failed work for lacking a pull request.

#### Work outside the merge rate

| Kind | Rule | Where it shows |
|---|---|---|
| No pull-request work | no run in the item could open a pull request and none did | `noPrWork` (items, runs, spend) |
| Unlinked follow-ups | the item holds only follow-up runs whose originating run is not in the data | `unlinkedFollowUps` (items, runs, spend) |

Both are counted in `workItems`, `runs`, `runsByStatus` and `cost.totalUsd`. They are in no state count,
no settled count, no rate, not in `unmergedSettledUsd` and not in cost per merged PR, which divides the
spend of merge-rate work by merged pull requests. The Markdown shows them in their own section and in
an "Outside the merge rate" column.

**State of an item**, in this order:

| State | Rule |
|---|---|
| `merged` | any linked pull request has status `MERGED` |
| `open` | otherwise, any linked pull request is `OPEN` |
| `running` | otherwise, any run is still `RUNNING` |
| `closed_unmerged` | otherwise, it has pull requests and all are `CLOSED` |
| `no_pr` | otherwise: every run ended and none produced a pull request |

States are assigned to merge-rate items only. **Settled items** are `merged`, `closed_unmerged` and
`no_pr`. `open` and `running` are undecided and are counted and costed but left out of every rate's
denominator.

| Metric | Definition |
|---|---|
| Merge rate | merged items / settled items, with a 95% Wilson interval. Merge-rate items that failed, timed out or were cancelled without a pull request are in the denominator; work outside the merge rate is not. |
| Decided PR merge rate | merged items / (merged + closed unmerged items): of the pull requests a human decided, the share merged. |
| Review rounds | per item with at least one pull request, the number of finished `executeReviewFixImplementation` steps across all its runs. Reported as mean, median, maximum and the number of items with at least one. |
| CI-heal rate | of items with at least one finished `executeCIFixImplementation` step and a pull request, the share whose pull request has CI `PASSED` or merged. Reported for the whole report, per template and per repository (see [CI healing by repository](#ci-healing-by-repository)). |
| Guard trips | the `ci_fix.test_integrity_guard` events recorded on the runs of merge-rate items (see [the guard](./ci-failure-triggers.md#24-the-test-integrity-guard)): the number of trips (once per workflow attempt at a node, however many events a retry left), how many of them blocked the fix, and the number of items with at least one. A gate that could not read the whole change records the same event marked `degraded` and is not a trip. Only `block` mode blocks, and it is not the default, so a repository on the default shows trips with zero blocked. Trips of the first fix of `ci-triage-and-fix`, the quality-gate fix and the pull-request feedback fix are counted; the CI-heal rate itself still counts only items with a finished `executeCIFixImplementation` step. |
| Time to merge | for merged items with a merge timestamp, the time from the item's earliest run start to its first merge. Median and p90 with the sample size. |
| Cost per merged PR | the recorded cost of every run of merge-rate work, retries, follow-ups and failures included, divided by the number of merged pull requests. Null when none merged. |
| Cost per merged PR, settled | the same, counting only items that settled, so work still in flight is not charged to the merges that have happened. |
| Spend on unmerged | the recorded cost of merge-rate items that settled without a merge. |

Cost is each run's `costUsdAccrued`; when that is zero the matching `ActiveWorkflow` ledger row is
used, as in the delivery report. It is the model-call cost the platform recorded, nothing else.

#### CI healing by repository

The CI-heal rate is computed for every group the report slices by, and the Markdown prints it per
repository in its own table beside the guard's trips, with the 95% Wilson interval and a `low sample`
mark below 30 items with a CI fix. The two are read together because a heal rate can be raised by a
fix that deleted, skipped or weakened the failing test: that fix turns CI green. A repository with a
high heal rate and a long run of trips is healing by that route; a trip that blocked the fix is a
fix that was stopped before it was pushed, and its item counts in the denominator when it has a pull
request, as it did not heal.

The rate is the platform's, not a measure of test quality: a guard that did not trip says only that
it recognised nothing, and the rate does not count fixes the guard or a person never saw.

**Attribution.** An item belongs to the template and repository of the run that merged it, else of its
latest run that is not a follow-up. A repository is the run's persisted `attributedRepoId`; a run without one is reported under
`Unattributed`.

**Low sample.** A group with fewer than 30 settled items is marked `low sample`. The interval is the
honest statement of how little a small group says.

## 4. What the report shows about failure

Besides the rates, the Markdown carries a table of items by state (merged, closed unmerged, ended
without a pull request, open, running), the count of runs by status, the spend split into merged,
unmerged and undecided, and the work kept outside the merge rate with its own spend. A merge rate is read alongside the spend that did not produce a merge, and a
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

- The guard-trip counts come from the trace events the CI-fix session records. A run whose traces
  were deleted by retention shows no trips, and a repository whose guard is `off` shows none either.
  A trip is a heuristic finding (see [the guard's limits](./ci-failure-triggers.md#limitations)), not a
  confirmed deletion of a test.
- The CI-heal rate counts items whose pull request CI passed or merged. It does not say whether the
  tests that passed are the tests the repository had before the fix.
- Only GitHub Actions CI is read, so the heal rate covers pull requests whose CI status the platform
  records. Buildkite, CircleCI and GitLab CI are not sources.
- The report does not count human review rounds on the pull request. Review rounds are the fix rounds
  the platform's own review network triggered. Change requests a person makes on the pull request are
  not counted.
- Ticket grouping needs a ticket id the launch named. Work launched without one is one item per work
  request, so a retry that creates a new request is counted as separate work.
- Only follow-ups launched from stored review findings carry the run they act on. A PR-feedback run
  started by a human review or comment is not joined to the item whose pull request it addresses: its
  cost and review rounds stay out of that item, and it is reported under unlinked follow-ups. The same
  holds for any follow-up whose originating run started more than 30 days before the window start.
- Whether a run could open a pull request is read from its template version's step names (and the
  `deliver` option of an agent run). A template that reaches a pull-request step only through something
  the spec does not inline is treated as unable to, and its failures fall outside the merge rate.
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
