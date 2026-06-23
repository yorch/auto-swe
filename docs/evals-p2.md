# Evals — P2: `eval` workflow node + LLM-as-judge + calibration + canary

> Build plan for **Phase P2** of the [evals RFC](./evals.md). P2 adds the **soft / subjective** axis
> that execution can't cover: a declarative **`eval` workflow node**, an **LLM-as-judge** scorer
> (rubric-based, run via a dedicated `evalJudge` Agent), **judge calibration** against a
> decontaminated human channel, and a **production canary** for fast per-change A/B.
>
> Parent RFC: [`evals.md`](./evals.md) §4.1 (`eval` node), §4.4 (calibration), §4.5 (canary), §6,
> §9 (judge weakness, calibration confounding, Goodhart, decision rule, implementer/rubric wall).
> Builds on [`evals-p1.md`](./evals-p1.md) (harness, scorers, stats). **Judge is advisory until
> calibrated** — it ranks, it does not gate, until its κ clears a threshold (RFC §2, §9).

---

## Gating prerequisites (RFC §6)

P2 defers until a **named owner exists for judge calibration + rubric governance**, and (for the
`eval` *node* / product surface) a real user pulls for it. Until then, ship the judge as an
internal harness scorer (WS2) without the workflow node (WS1).

## Outcomes (definition of done)

1. **`eval` workflow node** in the spec + interpreter + a `runEvalNode` activity (mirrors
   `runAgentNode`): a node carrying a `scorers[]` array; floor scorers run first and short-circuit
   the judge (RFC §2 combination model).
2. **LLM-as-judge scorer** run via a dedicated **`evalJudge` Agent** whose model **must differ from
   the implementer's** (self-preference bias — RFC §9); **pairwise (relative)** judging is the
   default, pointwise reserved for ranking; each judged case runs **N× → mean ± std**.
3. **Admin-extensible rubrics** (`EvalRubric`, versioned, modeled on `ScannerPattern`): rubric text
   + scale, managed at `/admin/evals/rubrics`.
4. **Decontaminated calibration channel:** a human-review queue that samples diffs **including ones
   the review network rejected**, scored by a reviewer who did not see the bot verdict; track Cohen's
   κ vs that channel (not raw merges — RFC §4.4, §9).
5. **Production canary:** route a configured % of live work requests to a candidate agent version and
   compare outcomes (test-pass, merge rate) against control.
6. **Decision rule + reward-hacking wall** codified (RFC §9): execution + guardrail block;
   trajectory + judge are advisory-with-thresholds; golden references and rubric text are **never**
   visible to the implementer agent (an enforced invariant + test).
7. **Tests:** interpreter dispatches an `eval` node; judge scorer runs N× and aggregates; floor
   short-circuits the judge; κ is computed against the decontaminated channel; canary routing samples
   correctly; the implementer/rubric wall holds.

## Non-goals (deferred)

- `/admin/evals` drift **dashboard**, dataset compression, cost ceilings, golden-set re-validation,
  optional historical-replay tier → **P3**.
- Multi-judge ensembles beyond "N× one judge + optional stronger model on the gate path" → future.

## The guiding constraint

The judge is the **least reliable** scorer (κ≈0.45 on subjective SE tasks — RFC §9), so P2 must
*not* let it gate by default. All judge I/O happens in the `runEvalNode` activity (V8-isolate rule).
The rubric/golden-reference **wall** is a hard invariant, not a guideline.

---

## Workstreams

### WS1 — `eval` node + interpreter + `runEvalNode` activity
**Why:** in-workflow scoring as a declarative step (RFC §4.1).

- **Spec** (`packages/shared/src/workflow/spec.ts`): add `EvalNodeSchema` (mirror `AgentNodeSchema`/
  `McpNodeSchema`) with `{ type: 'eval', target: Binding, scorers: ScorerSpec[], onFail?, next? }`
  where `ScorerSpec` is a discriminated union on `kind`: `gate` | `assert` | `trajectory` | `judge`
  (the last two soft). Add to the `NodeSchema` `discriminatedUnion` (~:403) + export `EvalNode`.
- **Interpreter** (`packages/shared/src/workflow/interpreter.ts` ~:277): add `case 'eval':` →
  `runEvalNode(...)` helper (mirror `runAgentNode` ~:387) that routes to the `runEvalNode` step.
- **Worker** (`packages/worker/src/activities/runEvalNode.ts`, NET-NEW; mirror `runAgentNode.ts`):
  evaluate floor scorers first; **short-circuit the judge if the floor fails**; for `judge`, resolve
  the `evalJudge` AgentSpec (`resolveAgentSpec` + `runAgent`, traced); write one `EvalResult` per
  scorer; expose aggregate at `nodes.<id>.output.score` for `cond`. Register in
  `activities/index.ts` + `workflows/runnable.ts` (`proxyActivities` + `STEP_EXECUTORS` entry
  `'runEvalNode'`), exactly as `runAgentNode` is wired.
- **Acceptance:** interpreter test dispatches an `eval` node; a floor-fail produces no judge call;
  seeded SWE templates unaffected (additive).

### WS2 — LLM-as-judge scorer (the soft axis)
**Why:** measure "is this a good diff" — what execution can't.

- **`evalJudge` Agent** seeded with its own `modelSpec`, **constrained to differ from the implementer
  model** (assert at seed/validate time — RFC §9). Cheap single judge for *online/advisory*; allow a
  stronger model on the *gate* path.
- **Pairwise default:** the judge compares candidate vs. baseline output (relative), which is where
  moderate-κ judges are usable; pointwise rubric scoring is reserved for ranking, not gating.
- **N× sampling:** each judged case runs 3–10× (temp-0 ≠ deterministic — RFC §9); report mean ± std;
  persist per-sample rows + an aggregate.
- **Advisory-until-calibrated:** the harness/eval-node gate consumes judge output **only as a
  reported signal** until WS4 κ clears a stated threshold; the blocking decision stays on
  execution + trajectory.
- **Acceptance:** a judged case yields N rows + mean±std; pairwise verdict flips on an obviously
  worse candidate; gate verdict ignores the judge while κ is below threshold.

### WS3 — Admin-extensible rubrics
**Why:** rubric text is config, not code (mirror the scanner-pattern model).

- **Schema** `EvalRubric` (versioned; `slug`, `scope`, `version`, `promptText`, `scale`, `isBuiltIn`)
  — same shape/governance as `ScannerPattern`. Seed a `code-review-quality` rubric.
- **Gateway/Web:** CRUD at `/api/v1/admin/evals/rubrics` + `/admin/evals/rubrics` (copy the scanner
  admin page + `useAdmin` mutation pattern). Custom rubric text scanned by the existing
  `scanSkillContent` (injection/exfiltration) — non-blocking warnings.
- **Acceptance:** a rubric is created/edited/versioned; the judge binds the active version.

### WS4 — Decontaminated calibration channel
**Why:** the raw merge label is confounded, not just noisy (RFC §4.4, §9).

- **Sampling job:** periodically sample diffs for human re-review — **including a sample the review
  network rejected** (break survivorship) — and enqueue them to a review surface where the human
  does **not** see the bot's verdict. Reuse the HITL `humanReview` node/inbox where possible.
- **κ tracking:** compute Cohen's κ (and correlation) of the `evalJudge` / review-network verdict vs
  this independent channel; store on a small `EvalCalibration` record per period; surface the trend.
- **Gate coupling:** the judge axis becomes eligible to influence a gate **only** once κ clears a
  documented threshold (wired into WS2's advisory flag).
- **Acceptance:** κ computed against the independent channel (not raw merges); rejected-diff sampling
  present; below-threshold κ keeps the judge advisory.

### WS5 — Production canary
**Why:** fast per-change A/B without replay (RFC §4.5).

- **`CanaryConfig`** (agentKey, candidate version/modelSpec, sample %, window). At work-request
  routing, sample `%` of runs to the candidate version (extend the `agentVersions` pin path /
  `resolveAgent` with a sampled override), tagging the run as `canary`.
- **Comparison:** reuse P0 capture (gate/merge rows) + P1 stats to compare canary vs control outcomes
  over the window; surface a verdict. Real, current repo state by construction — nothing to replay.
- **Acceptance:** a 10% canary routes ~10% of runs to the candidate; the comparison reports a paired
  outcome delta; disabling the canary restores 100% control.

### WS6 — Decision rule + implementer/rubric wall
**Why:** a gate must terminate in a decision; the implementer must not see the answer key (RFC §9).

- **Decision policy** (codified in the harness verdict + the `eval` node `onFail`): execution +
  guardrail are **blocking**; trajectory + (calibrated) judge are **advisory-with-thresholds**; a
  named approver adjudicates mixed soft-axis results.
- **Wall:** assert — and unit-test — that golden references (`EvalCase.reference`) and rubric text are
  **never** injected into the implementer's context or `MemoryItem` retrieval, in any run. Exclude
  eval-case repos/tickets from memory retrieval during eval + canary runs.
- **Acceptance:** mixed-axis verdict resolves per policy; a test proves the implementer context never
  contains rubric/golden-reference strings.

### WS7 — Tests
- Interpreter `eval`-node dispatch + floor short-circuit; judge N× aggregation + pairwise flip;
  rubric CRUD/versioning; κ vs decontaminated channel; canary sampling proportion; decision-rule
  table; wall invariant.

---

## Exit criteria (RFC §6)

The `eval` node runs a judge scorer in-workflow (floor-gated, advisory judge); judge-vs-human
agreement (κ) is tracked **against a decontaminated channel** and surfaced; a production canary gives
fast per-change feedback; the decision rule and the implementer/rubric wall are enforced and tested.

## Risk notes carried from RFC §9

- **Weakest scorer leaned on hardest:** mitigated by pairwise default, N× sampling, judge-model ≠
  implementer-model, and advisory-until-κ-clears.
- **Confounded calibration:** WS4's independent channel (incl. rejected diffs) replaces raw merges.
- **Goodhart / reward hacking:** stacked axes + the WS6 wall + frozen held-out (P1/P3) — none alone
  is sufficient, hence all three.
