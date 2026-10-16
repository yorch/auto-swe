# Evals

Evals measure the **quality of agent output** — something tests cannot do, because the unit tests
mock the LLM. They answer three questions a passing build leaves open: did this prompt or model
change make an agent better or worse, is the review network's judgment calibrated against what
humans actually merge, and has quality drifted since the last change.

Evals are a platform mechanism, not an SWE feature: the engine provides scoring, datasets, and
gating, and SWE ships the first datasets and rubrics as ordinary seed content.

The original RFC — conceptual grounding, the build-vs-buy analysis, and the risk register — is
preserved at [`history/evals-rfc.md`](./history/evals-rfc.md).

---

## 1. The three mechanisms

| Question | Mechanism |
|---|---|
| Has quality drifted? | **Online scoring** — `eval` nodes inside real workflow specs score live runs |
| Is this change a regression? | **Offline harness** — a frozen benchmark dataset, run against a candidate and a baseline agent version with paired statistics |
| Is this change safe at low volume? | **Canary routing** — a deterministic share of real traffic runs on a pinned candidate agent version |

Online scoring and the frozen benchmark are the foundation; both are deterministic and cheap.
Replaying full production history against original repository states is deliberately *not* built —
it depends on snapshot infrastructure that does not exist.

---

## 2. The `eval` node

`eval` is an ordinary workflow node type. It scores a value already in the run context and records
the result:

```jsonc
{
  "type": "eval",
  "target": { "from": "nodes.implement.output.diff" },
  "scorers": [
    { "kind": "gate",  "gate": "runTests" },
    { "kind": "assert", "expr": "$.linesChanged < 500" },
    { "kind": "pii" },
    { "kind": "trajectory" },
    { "kind": "judge", "rubricRef": "code-review-quality" }
  ],
  "judgeAdvisory": true,
  "onFail": "warn",
  "next": "review"
}
```

It dispatches to the `runEvalNode` activity, writes one `EvalResult` row per scorer, and binds its
result at `nodes.<id>.output`:

| Field | Meaning |
|---|---|
| `score` | Aggregate in [0, 1] for `cond` branching: 0 when a floor scorer failed, else the mean of the soft scorers that scored (1 when none did) |
| `floorPassed` | Every floor scorer passed |
| `perAxis` | Each scorer's value, keyed by scorer identity (`gate:runTests`, `judge:code-review-quality`); a scorer that could not score is absent |
| `errors` | Scorers that could not score, keyed by identity, mapped to the reason; `{}` when all scored |
| `decision` | `{ blocked, reason }` — the gate decision below |
| `passed` | `!decision.blocked` |
| `summary` | `eval blocked: <reason>` when blocked, else the reason |

A blocked eval is a failed node. `passed: false` sends it through `onFail` exactly like a failed
gate step: `block` (the default) records the step `FAILED` and fails the run with the summary as the
error, `warn` records it `FAILED` and carries on to `next`, and `{ retry: N }` re-runs the whole node
up to N more times before blocking. Each attempt runs every scorer again — gates re-execute and the
judge makes a new, separately paid call — so a retry only helps a scorer that can flake (a gate
with a flaky test, a judge on a bad day); a deterministic `assert`, `policy` or `pii` failure fails
every attempt. The output is bound in every case, so a `cond` after a `warn`
eval can still branch on `nodes.<id>.output.decision.blocked` or `score`. A spec that routes a
blocked eval with a `cond` sets `onFail: "warn"`; under the default it never reaches the `cond`.

The decision blocks when a floor scorer failed, or — only with `judgeAdvisory: false` — when a
judge scored below `evalJudgeThreshold` (Tier-2 defaults) or could not score at all. Otherwise the
eval passes, and the reason says whether a blocking judge cleared its threshold or the soft axes
were advisory.

### Scorer kinds

| Kind | Family | Fields | What it does |
|---|---|---|---|
| `gate` | floor | `gate`, optional `command` | Executes a real quality gate against the candidate's pushed branch on the repo's executor image. A `command` is code the author wrote: saving it takes the shell authoring role and writes a `WorkflowShellAudit` row ([nl-workflow-authoring.md](./nl-workflow-authoring.md#5-design-notes)); without one the repository's configured command runs |
| `assert` | floor | `expr` | Evaluates a programmatic expression against the target (`$.`-prefixed paths, the `cond` grammar) |
| `policy` | floor | `riskClass` | Passes when the run's resolved autonomy policy sets that risk class to `auto`; fails on any other action (`require_approval`, which is also what a class the policy does not name resolves to) or when the eval runs outside a run. It never waits for an approval |
| `pii` | floor | — | Runs every active `PII` scanner pattern over the target (JSON-encoded when not a string); passes on no match, fails on a match, an incomplete scan, or a scan that skipped a quarantined pattern |
| `trajectory` | soft | — | Reads the current run's `AgentTrace` rows and scores tool correctness |
| `judge` | soft | `rubricRef` | An LLM judge (`evalJudge`, bound to its own model) scoring against the newest version of the `EvalRubric` whose slug is `rubricRef` |

`rubricRef` is a bare slug; the judge always uses that slug's newest version, so `slug@version` does
not resolve. Saving a spec warns (`RUBRIC_REF_UNRESOLVED`) when no rubric has the slug.

Floor scorers run first and short-circuit the judge when they fail, so a broken diff never costs a
judge call. When a `judge` scorer is present the activity is an LLM activity and is wrapped in
`AgentTracer` + `persistActivityTrace` like every other one. The judge's `EvalResult` row records the
model the call was priced at (`judgeModel`) and its cost (`costUsd`) — the same attribution
`recordLlmUsage` debited to the run, including a call that was paid for and then failed. A judge
that never reached a model (no rubric, an unresolvable agent) records neither.

**A judge that cannot score fails closed only when it is blocking.** A missing rubric, a failed
call, a spent budget, or output with no score leaves the judge with an error instead of a score.
The node output lists it under `errors` and leaves it out of `score` and `perAxis`. Its
`EvalResult` row keeps a neutral placeholder `value` of 0.5 and says so: `rationale` reads
`scorer error: <reason>` and `metadata.error` holds the reason (`rubric not found`,
`judge call failed`, `judge budget exhausted`, `judge returned no score`). The trends endpoint
(`GET /api/v1/platform/evals/trends`) leaves those rows out of its means. With
`judgeAdvisory: false` the error blocks the eval (`judge could not score (...)`) whatever the
threshold; an advisory judge's error does not.

Every `EvalResult` row an `eval` node writes carries the node's recording id in `nodeId`.

The cost estimator prices one `evalJudge` call per `judge` scorer and nothing for an eval without
one: the other scorers call no model.

**The `gate` scorer fails safe.** `runGateStandalone` resolves the SCM clone URL from the run's
connection, checks out the candidate's already-pushed branch (not a fresh branch off the default) on
the repo's `executorImage`, and executes the gate command. Any non-executable path — no linked run, a missing connection or ticket, a clone or
exec error — records `passed: false`. A floor scorer must never green-light unverified code by
silently passing.

That branch is the run's own work branch (`<branchPrefix>/<ticketId>`) unless the node names one with
`candidateRef`, a binding resolved like `target`:

```jsonc
{
  "type": "eval",
  "candidateRef": { "from": "nodes.implement.output.branch" },
  "target": { "from": "nodes.implement.output.diff" },
  "scorers": [{ "kind": "gate", "gate": "runTests" }]
}
```

Name one whenever the code under review is not on `<branchPrefix>/<ticketId>` — which a per-branch
fan-out subtask is not (`<branchPrefix>/<ticketId>/<subtask>`), and a step with its own `branch`
override or a `codeResult.branch` may not be either. A `candidateRef` that cannot be resolved falls
back to the default, and a binding whose path is wrong is reported by `validateSpec` just like
`target`'s, so a mistyped path does not silently score the wrong tree.

Scoring the wrong branch is wrong in **both** directions, and the second is the dangerous one:

- if `<branchPrefix>/<ticketId>` does not exist, the checkout fails and a floor scorer records
  `passed: false` — a failure the change never caused;
- if it exists — an older attempt's branch, or a sibling run's — the scorer runs against *that* tree.
  Its tests may pass, so the eval reports a green gate while verifying code the change never touched.

Leave `candidateRef` off only when the default branch really is the candidate.

---

## 3. Offline harness

`EvalDataset` holds versioned, scope-cascaded `EvalCase` rows; each case carries an `input`, an
optional `reference` (expected tests, golden diff, ideal answer), provenance back to a source run,
and tags. Running a dataset compares a **candidate** against a **baseline**, both given as
`key@version` agent refs, and reports paired statistics with error bars rather than a single number.

`runCaseDefault` resolves each ref in the dataset's tenant — its team and organization, with the
version pin applied — and builds the implementer through the same `buildImplementerTurnRunner` a run
uses, so the runtime, tool keys, skills, MCP binding and step budgets a TEAM or ORGANIZATION
override gives that tenant's runs are what the eval grades. A GLOBAL dataset resolves at GLOBAL
scope. It then runs a bounded TDD loop scoring the golden test's exit code.

**Only flake-screened cases are scored.** A case is scored once its reference passed every run of
its flake screen (§4). A case never screened, or whose screen failed, is skipped — as is a case
re-validation quarantined — so a flaky floor cannot move the verdict. Every run's summary carries
`unscreened`: the count and ids of the cases skipped as never screened (`neverScreened`,
`neverScreenedCaseIds`) and as failed screens (`screenFailed`, `screenFailedCaseIds`). The run page
and `auto-swe evals run` print those counts. A run that finds never-screened cases starts its
dataset's screen (§4) before scoring what is already screened, so a dataset screens itself on first
use.

**A run with no screened case is `INCONCLUSIVE`.** When the dataset has cases but none is
flake-screened, nothing is scored and there is no verdict: the run ends `INCONCLUSIVE` — neither
`SUCCESS` nor `FAILED` — and its summary's `inconclusive` names how many cases await screening
(`awaitingScreen`) and how many failed their screen (`screenFailed`). The run page explains it and
`auto-swe evals run` exits 2, as for a run without a verdict. Running again once the screen
finishes gives a verdict. A dataset with no cases at all is not inconclusive; its run is a
`SUCCESS` over nothing.

### Comparing runtimes

Each side of a run can name the implementer runtime it runs on: `candidateRuntime` and
`baselineRuntime` (`mastra`, `claude-code` or `pi`) on `POST /api/v1/platform/evals/runs`, or
`--candidate-runtime` / `--against-runtime` on `auto-swe evals run`. A side that names none runs on
what its agent resolves to in the dataset's scope: the Agent version's own `runtime`, else
`workspace.implementerRuntime` ([agents.md §3.7](./agents.md#37-runtimes-mastra-and-the-harnesses)). Giving both sides the
same agent ref and different runtimes grades one runtime against the other on the same prompt,
model and skills:

```bash
auto-swe evals run golden --candidate=implementer@3 --candidate-runtime=claude-code \
  --against=implementer@3 --against-runtime=mastra
```

The override is a pair of fields, not part of the agent ref. An agent ref (`key` or `key@version`)
names an Agent version and means the same thing in a workflow node, a canary and a run pin, none of
which can honour a runtime; a suffix such as `implementer@3#claude-code` would be accepted by the
grammar everywhere and mean something in only one place. As fields, existing refs are untouched,
the gateway validates the value against the runtime list, and the request is stored on the
`EvalRun` beside the refs.

The override enters `buildImplementerTurnRunner` as pins, in the tiers a production run's own pins
occupy: the agent's per-run runtime pin (`ctx.agentRuntimes`), which wins over the Agent version's
own `runtime`, and the run pin of `workspace.implementerRuntime`. The runtime is still chosen by
`resolveAgentRuntime`, nothing skips it, and a production run is unaffected. A case whose
runner was built on a different runtime than the one requested fails with
`EVAL_RUNTIME_MISMATCH` instead of grading the wrong runtime under the requested name.

Every harness result records the runtime that actually ran, whether or not the run overrode it: the
candidate arm's in `EvalResult.runtime`, the baseline arm's in its `metadata.baselineRuntime`. The
verdict's `summary.runtimes` lists the runtimes each side ran on across the completed cases.

**Cases run in a pinned image.** A case is scored, and its reference screened and re-validated,
in `EVAL_WORKSPACE_IMAGE`, not the operator's configured workspace image, so a score stays
comparable with its history; moving the image re-baselines every score and calls for a re-screen.

**Infrastructure errors throw rather than scoring zero.** A Docker, model, agent, or MCP failure
marks the `EvalRun` `FAILED`; it never records a false `0` that would poison the regression verdict
with infra noise.

**A spent budget ends the run early, not in failure.** A dataset run keeps no `WorkflowRun`, so its
calls are held to the runless cap (`workflow.runlessMaxInputTokens` /
`workflow.runlessMaxOutputTokens`), multiplied by the dataset's case count so the setting reads as
a per-case allowance. When the cap runs out part-way, the harness stops at that case and finishes
the run with a verdict over the cases already paired; the summary carries a `partial` marker
(completed and total case counts, the ids that did not run, the budget message). Run rows from the
API carry `partial: true` for it, and the dataset page's run list and the run page's header badge
read `SUCCESS (partial)` or `REGRESSION (partial)` in amber instead of a plain verdict. `auto-swe evals run` prints the partial line and exits 2 for a partial
`SUCCESS`, so a nightly gate never passes on a prefix; a partial `REGRESSION` still exits 1. A cap
reached before any case completed fails the run. The same early end applies when the organization's
monthly USD cap refuses a call: the summary's `partial.reason` is then `org_budget` rather than
`budget`, and the run page names the organization budget.

Execution is durable: `EvalRunWorkflow` runs the dataset on Temporal, so a long benchmark survives
restarts like any other run.

---

## 4. Scheduling and canary

**Nightly regression.** `ScheduledEvalWorkflow` runs on a Temporal Schedule configured per
deployment at `/admin/workflow-defaults`.

**Golden-set re-validation.** `ScheduledRevalidationWorkflow` fans out over datasets due for
re-validation and quarantines cases that have gone stale, so the benchmark does not silently decay
into measuring the wrong thing. A reference run that was killed by a signal or timed out says
nothing about the case, so the case is left as it is — neither quarantined nor restored — using the
same classification as flake screening (below). A quarantined case whose reference passes again is
restored, and
its flake screen is reset to never-screened: it passed its last screen in an older repository
state, so it is scored again only after a new one passes. Managed at `/admin/workflow-defaults`,
with `GET`/`PUT /api/v1/admin/config/revalidation` and a manual trigger endpoint
(`POST /api/v1/admin/config/revalidation/trigger`). The schedule is off by default. Its
`revalidationDatasetSlug` (the `datasetSlug` field of that endpoint) limits a sweep — re-validation
and the screening after it — to the datasets whose slug contains it; unset, a sweep covers every
dataset.

**Flake screening.** A case's reference — its golden test at the pinned commit, in the eval
workspace image the harness scores it in (`EVAL_WORKSPACE_IMAGE`) — is run up to
`evals.flakeScreenRuns` times (setting registry, default 3, GLOBAL only, ADMIN to change) by the
`screenDatasetCasesActivity` activity. The case is marked `flakeScreened` only when every run
passed; the first failing run ends its screen. Either way `flakeRuns` records the configured number
of runs, so `flakeRuns = 0` is a case never screened and `flakeRuns > 0` without `flakeScreened` is
a failed screen (a flaky reference, or one that never passes).

Screening starts itself. `EvalScreenWorkflow` runs under one id per dataset
(`eval-screen-<datasetId>`), and every starter joins a screen already running instead of starting a
second: creating a dataset with cases, an eval run that finds never-screened cases in its dataset
(§3), and an admin re-screen. A running screen reloads the dataset's never-screened cases when it
has worked through them, so a case added or reset while it ran is screened too. A start can still
join a screen whose activity has made its last load, so when the activity returns the workflow
counts the cases still never screened and screens again while any remain, up to five screens per
run; a case that hit an infrastructure error in the run is left for the next one. Every
re-validation sweep also screens each dataset's never-screened cases, one dataset at a time, after
all its re-validations.

A run that could not say anything about the test leaves the case unscreened for the next screen
rather than marking it flaky: a workspace that could not be provisioned or cloned, and a run killed
by a signal or a timeout — the runner's own timeout, or an exit status of 128 and above, such as
137 for the out-of-memory killer, up to 254. Every other non-zero exit, 255 included — what a
test's own `exit(-1)` produces — is a test failure. Each such error is counted on the case
(`flakeScreenInfraErrors`); at the third the case is recorded as a failed screen
(`flakeRuns > 0`, not `flakeScreened`), so a test that always dies stops being retried and shows
as failed. The activity
heartbeats after every reference run, under a five-minute heartbeat timeout. Quarantined cases are
not screened. A screen's result is written only if the case is still unscreened and its repository,
commit and golden test are still the ones it ran. A case's reference cannot be edited through the
API, so a new reference is a new case, which starts unscreened.

**Re-screening.** An admin resets a dataset's cases, or one case, to never-screened
(`flakeRuns = 0`, `flakeScreened = false`, `flakeScreenInfraErrors = 0`) and starts the dataset's screen with
`POST /api/v1/platform/evals/:id/rescreen` or `POST /api/v1/platform/evals/:id/cases/:caseId/rescreen`,
the re-check buttons on the dataset page, or `auto-swe evals rescreen <dataset-id> [--case=<id>]`.
The reset is audited against the dataset, with how many of the cases were screened, failed their
screen, or were never screened before it. When the screen cannot start (Temporal unreachable) the
cases stay reset, and the next eval run of the dataset or the next sweep screens them. Until a new
screen passes, the harness does not score a reset case.

**Canary routing.** `resolveCanaryConfig()` reads the canary agent key and version from
`WorkflowDefaults`; `shouldRouteToCanary()` hashes the work-request ID (FNV-1a) for a deterministic
split. A routed run is stamped `isCanary` and gets the candidate version applied as an
`agentVersions` override, so its scores are directly comparable to the baseline population.

**Suite health.** Flake rate, stale rate, and judge/human agreement (kappa) are tracked against the
thresholds in the Tier-2 defaults (`evalHealthMaxFlakeRate`, `evalHealthMaxStaleRate`,
`evalHealthMinKappa`, `evalJudgeThreshold`). An unhealthy suite is not a trustworthy gate.
`GET /api/v1/platform/evals/suite-health` returns each dataset's case count, how many cases
re-validation quarantined as stale, how many are flake-screened, and the count of the
non-quarantined cases the harness skips as never screened or failed screens, each with the ids of
the oldest 50 of them, with the three
thresholds, and `/admin/evals` charts the stale rate per dataset against its ceiling. The dataset
page and `auto-swe evals show` mark each case as screened, flaky, or not checked yet.

---

## 5. Data model

| Model | Holds |
|---|---|
| `EvalResult` | One row per scorer — normalized `value`, `passed`, `rationale`, for a judge row the model and cost of its call, and for a harness row the implementer `runtime` the candidate ran on. Indexed for per-scorer and per-day trend queries |
| `EvalDataset` | A versioned, scope-cascaded benchmark |
| `EvalCase` | One case — `input`, optional `reference`, `sourceRunId` provenance, tags, its flake-screen state (`flakeScreened`, `flakeRuns`, `flakeScreenInfraErrors`) and whether re-validation quarantined it |
| `EvalRun` | One execution of a dataset — status, candidate/baseline refs, each side's optional runtime override, aggregate statistics |
| `EvalRubric` | A versioned judging rubric; `code-review-quality` ships seeded |

`EvalResult` joins to `WorkflowRun`, `WorkflowStep`, and `AgentTrace`, which is what turns one-off
verdicts into trends per template, model, and prompt version.

---

## 6. Surfaces

| Surface | Where |
|---|---|
| Dashboard | `/admin/evals` — each scorer's daily mean over a 7, 30, or 90-day UTC window or a custom span of up to 366 days, charted by week above 90 days (`since` / `until` on `GET /api/v1/platform/evals/trends`); every captured result, paginated and filterable by scorer and source, linked to the run or harness run it scored; the datasets |
| Dataset detail | `/admin/evals/datasets/[id]` — the cases with their stability (flake-screen) state, a re-check of every case or of one already checked, and the dataset's harness runs, each side with its runtime override |
| Harness run detail | `/admin/evals/runs/[id]` — the paired verdict, overall and per tag, the runtimes each side ran on, the cases left unscored for want of a passing screen, why a run is inconclusive, and that run's results with the runtime of each |
| Run detail | The eval panel on `/runs/[id]` |
| REST | `/api/v1/platform/evals` (datasets, cases, runs, rubrics, `results`, `trends` — one bounded aggregate per UTC day — and `rescreen`) |
| CLI | `auto-swe evals` — list, show, `rescreen`, and `run` a dataset, optionally on a runtime per side; `results` prints a harness row's runtime |
| Schedules | `/admin/workflow-defaults` — nightly regression and re-validation cadence |

---

## 7. Key files

| Path | Purpose |
|---|---|
| `packages/shared/src/workflow/spec.ts` | `EvalNodeSchema`, `EvalScorerSchema` |
| `packages/worker/src/activities/runEvalNode.ts` | Node execution, scorer dispatch, short-circuiting |
| `packages/worker/src/activities/evalHarness.ts` | `runCaseDefault`, dataset orchestration |
| `packages/worker/src/activities/evalRevalidate.ts` | Golden-set re-validation and quarantine |
| `packages/worker/src/activities/evalFlakeScreen.ts` | Flake screening of never-screened cases, and what counts as an infrastructure failure |
| `packages/worker/src/activities/evalWorkspaceImage.ts` | `EVAL_WORKSPACE_IMAGE`, the pinned image cases are scored and screened in |
| `packages/worker/src/lib/evalScreenStart.ts` | Starting or joining a dataset's screen from an activity |
| `packages/worker/src/activities/prepareScheduledEvalRun.ts` | Scheduled-run setup |
| `packages/worker/src/workflows/evalRun.ts` | `EvalRunWorkflow` |
| `packages/worker/src/workflows/scheduledEval.ts`, `scheduledRevalidation.ts` | Schedule-driven workflows; the re-validation sweep also flake-screens |
| `packages/worker/src/workflows/evalScreen.ts` | `EvalScreenWorkflow`, one per dataset, started on dataset creation, by an eval run, and by a re-screen |
| `packages/gateway/src/routes/evals.ts` | Admin API |

> End-to-end verification of the Temporal, Docker, and LLM paths requires the full infrastructure
> stack running; the unit suite covers orchestration against mocks.

---

## 8. Limitations

- **Historical replay is not built.** Replaying real production tickets against their original
  repository states would need snapshot infrastructure the platform does not have. The regression
  gate rests on the frozen benchmark plus online scoring and canary instead.
- **End-to-end paths need real infrastructure.** The unit suite covers orchestration against mocked
  Docker, Temporal, and LLM calls; the harness has not been exercised against a live stack.
- **Only the stale rate of suite health is measured, and only as it is now.** The flake-rate and
  kappa thresholds are set at `/admin/workflow-defaults`, but nothing compares the failed-screen
  share against the flake-rate ceiling or stores a judge/human agreement figure, so there is nothing
  to chart for them; the stale rate is the quarantined share of cases today, with no history, so it
  is a bar per dataset and not a trend.
- **A new case is not scored until it is screened.** Screening a dataset runs up to k workspaces
  per case, one after another, so a run started while its dataset is being screened scores only the
  cases screened so far, and one that finds no screened case is `INCONCLUSIVE`. A dataset whose
  screen could not start (Temporal unreachable) is screened by its next eval run, the next sweep, or
  a re-screen.
- **Trends shift as the screened set grows.** A dataset's runs score whatever is screened when each
  run starts, so successive runs of one dataset can cover different cases — more as screening
  catches up, fewer after a re-screen. Pass rates and per-day means compared across that change
  compare different case sets; compare runs whose `unscreened` counts match.
- **Screening costs up to k reference runs per case.** `evals.flakeScreenRuns` multiplies the clone
  and golden-test time of every new case; a case's first failing run ends its screen. One screen of
  a dataset is a single activity with a four-hour limit; a dataset too large for it is finished by
  its retries and later starts, which skip the cases already recorded. A sweep screens a dataset in
  its own activity, not through the dataset's `EvalScreenWorkflow`, so a sweep and a screen started
  by a run can work on the same dataset at once and run one case's reference twice; only one result
  is recorded. Screens of different datasets are not limited together: each dataset has its own
  workflow, so datasets screened at once provision their workspaces at once; only a sweep screens
  its datasets one at a time.
- **The runner sees only the golden test's exit status.** A dependency install or network fetch
  inside the golden-test command that fails exits like a failing test and marks the case flaky; an
  admin re-screen clears it. In the other direction, a test suite that itself dies on a signal, or
  hangs past the runner's timeout, reads as an infrastructure failure: it is retried by the next
  screens and, after three, recorded as a failed screen, which a re-screen resets. The dataset
  page and `evals show` mark such a case as not checkable rather than flaky. A genuine
  outage of the workspace or registry can therefore fail cases that a re-screen then clears.
- **A failed screen stands until an admin re-screens it.** Nothing re-screens a case on its own once
  its screen is recorded, except re-validation restoring a quarantined case. Changing
  `evals.flakeScreenRuns` does not re-screen cases already screened; a dataset re-screen does.
- **k passes are evidence, not proof.** A reference that fails rarely can pass k runs and be scored;
  re-validation quarantines it later only if it fails on the run re-validation makes.
- **Trend breakdowns cover judge model, agent and runtime, and templates only for online signals.**
  `GET /api/v1/platform/evals/trends` accepts `by=judgeModel|agentKey|runtime` and `templateId`. A
  runtime breakdown sees only harness rows, the one place a runtime is recorded. A template
  filter keeps results of runs of that template, so offline harness rows, which have no run, drop
  out of it; there is no breakdown by prompt version.
- **A runtime override is per run, not per schedule.** The nightly regression schedule passes no
  runtime, so its sides run on what their agents resolve (the Agent's own runtime, else the
  setting); comparing runtimes is a manual `evals run`.
- **Runtime comparisons share a model constraint.** The `claude-code` runtime needs an Anthropic
  model; a side whose agent resolves to another provider fails the run (`HARNESS_UNSUPPORTED_MODEL`)
  rather than scoring zero.
- **A budget-limited verdict covers a prefix of the dataset.** The cap is shared by the whole run,
  so one expensive case can spend another's allowance, and the cases that did not run are the ones
  at the end of the dataset, not a sample. The run's status is still `SUCCESS` or `REGRESSION`, so
  a gate of its own that reads the status alone must check `summary.partial` as well;
  `auto-swe evals run` already does.
- **Some eval-node fields are accepted but not read.** A judge's `baselineFrom`, a trajectory
  scorer's `from`, and the node's `inputs` parse but change nothing: the judge scores the target
  against its rubric with no baseline, the trajectory scorer always reads the current run's own
  traces and reports only tool correctness, and scorers read only `target`. `validateSpec` warns
  (`IGNORED_FIELD`) on each.
- **A retried eval writes a full set of rows per attempt.** `{ retry: N }` re-runs every scorer, so
  each attempt records its own `EvalResult` rows and, with a judge, pays for its own judge call. The
  rows carry the node id but not the attempt, so the attempts of one node are told apart only by
  `createdAt`, and trend means count every attempt.
- **The results list still shows placeholder rows.** Only the trends endpoint excludes a scorer
  that could not score; `GET /api/v1/platform/evals/results` returns those rows with their 0.5
  placeholder and the `scorer error:` rationale.
- **The `policy` scorer reads the run's template, not its target.** It resolves the autonomy policy
  for the run's template and team, so it scores what the run is allowed to do, not the value under
  evaluation.
- **A judge is only as good as its rubric.** Suite health (flake rate, stale rate, judge/human
  kappa) is tracked precisely because an uncalibrated judge produces confident, wrong verdicts —
  check it before trusting a gate.
