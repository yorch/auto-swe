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
    { "kind": "trajectory", "from": "nodes.implement.traceRef",
      "metrics": ["toolCorrectness", "stepCount", "guardrailHits"] },
    { "kind": "judge", "agentRef": "evalJudge", "rubric": "code-review-quality@3" }
  ],
  "onFail": "warn",
  "next": "review"
}
```

It dispatches to the `runEvalNode` activity, writes one `EvalResult` row per scorer, and exposes an
aggregate at `nodes.<id>.output.score` for downstream `cond` branching. `onFail` takes the same
`warn` / `block` / `{ retry: N }` policy as every other node.

### Scorer kinds

| Kind | Family | What it does |
|---|---|---|
| `gate` | floor | Executes a real quality gate against the candidate's pushed branch on the repo's executor image |
| `assert` | floor | Evaluates a programmatic expression against the target |
| `trajectory` | soft | Reads `AgentTrace` rows and scores *process* — tool correctness, step count, guardrail hits |
| `judge` | soft | An LLM judge (`evalJudge`, bound to its own model) scoring against a versioned `EvalRubric` |

Floor scorers run first and short-circuit the judge when they fail, so a broken diff never costs a
judge call. When a `judge` scorer is present the activity is an LLM activity and is wrapped in
`AgentTracer` + `persistActivityTrace` like every other one.

**The `gate` scorer fails safe.** `runGateStandalone` resolves the SCM clone URL from the run's
connection, checks out the candidate's already-pushed branch (not a fresh branch off the default) on
the repo's `executorImage`, and executes the gate command. Any non-executable path — no linked run, a missing connection or ticket, a clone or
exec error — records `passed: false`. A floor scorer must never green-light unverified code by
silently passing.

---

## 3. Offline harness

`EvalDataset` holds versioned, scope-cascaded `EvalCase` rows; each case carries an `input`, an
optional `reference` (expected tests, golden diff, ideal answer), provenance back to a source run,
and tags. Running a dataset compares a **candidate** against a **baseline**, both given as
`key@version` agent refs, and reports paired statistics with error bars rather than a single number.

`runCaseDefault` resolves each ref through `resolveAgent` with the version pin applied, builds the
implementer with that model override, and runs a bounded TDD loop scoring the golden test's exit
code.

**Infrastructure errors throw rather than scoring zero.** A Docker, model, agent, or MCP failure
marks the `EvalRun` `FAILED`; it never records a false `0` that would poison the regression verdict
with infra noise.

Execution is durable: `EvalRunWorkflow` runs the dataset on Temporal, so a long benchmark survives
restarts like any other run.

---

## 4. Scheduling and canary

**Nightly regression.** `ScheduledEvalWorkflow` runs on a Temporal Schedule configured per
deployment at `/govern/workflow-defaults`.

**Golden-set re-validation.** `ScheduledRevalidationWorkflow` fans out over datasets due for
re-validation and quarantines cases that have gone stale, so the benchmark does not silently decay
into measuring the wrong thing. Managed at `/govern/workflow-defaults`, with
`GET`/`PUT /api/v1/admin/config/revalidation` and a manual trigger endpoint
(`POST /api/v1/admin/config/revalidation/trigger`).

**Canary routing.** `resolveCanaryConfig()` reads the canary agent key and version from
`WorkflowDefaults`; `shouldRouteToCanary()` hashes the work-request ID (FNV-1a) for a deterministic
split. A routed run is stamped `isCanary` and gets the candidate version applied as an
`agentVersions` override, so its scores are directly comparable to the baseline population.

**Suite health.** Flake rate, stale rate, and judge/human agreement (kappa) are tracked against the
thresholds in the Tier-2 defaults (`evalHealthMaxFlakeRate`, `evalHealthMaxStaleRate`,
`evalHealthMinKappa`, `evalJudgeThreshold`). An unhealthy suite is not a trustworthy gate.

---

## 5. Data model

| Model | Holds |
|---|---|
| `EvalResult` | One row per scorer — normalized `value`, `passed`, `rationale`, judge model, cost. Indexed for per-scorer trend queries |
| `EvalDataset` | A versioned, scope-cascaded benchmark |
| `EvalCase` | One case — `input`, optional `reference`, `sourceRunId` provenance, tags |
| `EvalRun` | One execution of a dataset — status, candidate/baseline refs, aggregate statistics |
| `EvalRubric` | A versioned judging rubric; `code-review-quality` ships seeded |

`EvalResult` joins to `WorkflowRun`, `WorkflowStep`, and `AgentTrace`, which is what turns one-off
verdicts into trends per template, model, and prompt version.

---

## 6. Surfaces

| Surface | Where |
|---|---|
| Dashboard | `/govern/evals` — datasets, runs, suite health, score trends |
| Run detail | The eval panel on `/runs/[id]` |
| REST | `/api/v1/platform/evals` (datasets, cases, runs, rubrics) |
| CLI | `auto-swe evals` — list, show, and `run` a dataset |
| Schedules | `/govern/workflow-defaults` — nightly regression and re-validation cadence |

---

## 7. Key files

| Path | Purpose |
|---|---|
| `packages/shared/src/workflow/spec.ts` | `EvalNodeSchema`, `EvalScorerSchema` |
| `packages/worker/src/activities/runEvalNode.ts` | Node execution, scorer dispatch, short-circuiting |
| `packages/worker/src/activities/evalHarness.ts` | `runCaseDefault`, dataset orchestration |
| `packages/worker/src/activities/evalRevalidate.ts` | Golden-set re-validation and quarantine |
| `packages/worker/src/activities/prepareScheduledEvalRun.ts` | Scheduled-run setup |
| `packages/worker/src/workflows/evalRun.ts` | `EvalRunWorkflow` |
| `packages/worker/src/workflows/scheduledEval.ts`, `scheduledRevalidation.ts` | Schedule-driven workflows |
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
- **A judge is only as good as its rubric.** Suite health (flake rate, stale rate, judge/human
  kappa) is tracked precisely because an uncalibrated judge produces confident, wrong verdicts —
  check it before trusting a gate.
