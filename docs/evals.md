# Evals — RFC & Roadmap

Planning doc (RFC + roadmap) for **evals**: a first-class, native capability that measures the
quality of agent/LLM output in auto-swe — offline (regression-gating prompt/model/skill
changes before they ship) and online (scoring real runs to catch drift). Like the platform
pivot, evals are framed as a **platform feature**, not a SWE-only add-on: the engine gains a
generic eval mechanism, and SWE ships the first eval *content* (datasets + scorers) as seed
data.

> Status: **P0–P3 implemented; a few deep seams remain** (rev. 2026-06-24; rebased onto main incl.
> P5 multi-org). **76 eval tests green (full suite 1105 green); all packages typecheck; lint clean;
> migrations consolidated into one Prisma baseline + custom file, verified against a live Postgres.**
> Built across all
> phases: P0 capture + read API + run panel; P1 schema + paired-stats + trajectory scorer +
> SHA-pinned workspace + standalone gate runner + admin API + `auto-swe evals` CLI (incl. `run`) +
> harness orchestration + **durable `EvalRunWorkflow`** + a **platform-native nightly Temporal
> Schedule** (`ScheduledEvalWorkflow`, configured per deployment and managed at `/admin/workflow`);
> P2 scorer-combination +
> decision-rule + judge-prompt + implementer/rubric wall + `EvalRubric` schema/API + the **`eval`
> workflow node** (spec→interpreter→activity→canvas) + **wired LLM judge** (`evalJudge` agent,
> distinct model) + seeded `code-review-quality` rubric; P3 suite-health + cost policy + anchor
> subset + `/admin/evals` dashboard + **golden-set re-validation** (`quarantined` + the loop) +
> **canary routing decision**. **Genuinely deferred (need deeper schema/routing or live infra):**
> node-level gate execution (needs a workspace+diff in the node), agent-diff generation in the
> harness (scores the fixture tree as a proxy today), capturing per-run baseline SHA for the
> historical-replay tier, the canary *routing integration* into `resolveAgent`, and the
> re-validation Temporal schedule. End-to-end verification of every Temporal/Docker/LLM path needs
> that stack running.
> This doc establishes the vision, the conceptual grounding, and a phased build plan
> sized so each phase lands in one (or a small handful of) PR(s). An adversarial review (feasibility,
> methodology, strategy) is folded in as **§9 Risks & open feasibility gaps**, and this revision
> acts on its central finding: the regression gate now rests on a **small frozen benchmark** +
> **online scoring / canary** (§4) — deterministic, cheap mechanisms — while *replaying real
> production history* (the original load-bearing but infeasible idea) is **demoted to an optional P3
> tier**. So: ship a thin **P0 (signal capture)** now; P1 needs an authored frozen benchmark + a
> **build-vs-buy bake-off** (§8), not a replay spike. Per-phase build plans (`evals-p0.md`, …) split
> out as phases are committed, mirroring `platform-pivot-p*.md`.

---

## 1. Why evals (the gap today)

auto-swe already produces most of the *signals* an eval system needs — but it has no eval
**layer** that turns them into datasets, scores, trends, or regression gates. Today a change
to a prompt, skill, or model spec is validated only by deterministic unit tests (which mock
the LLM) and then by whether real production PRs succeed. There is no way to answer:

- "Did this prompt edit make the implementer **better or worse**, with statistical confidence,
  before it reaches production?"
- "Is the review network's judgment **calibrated** against what humans actually merge/reject?"
- "Has agent quality **drifted** since we swapped `implementer` from model X to model Y?"

What already exists, and how it maps to eval primitives:

| Existing primitive | File(s) | Eval role it already plays |
| --- | --- | --- |
| **Quality gates** (`runLint/Typecheck/Tests/Build/VulnScan/PerfBench` → `GateResult{passed,…}`) | `packages/worker/src/activities/qualityGates.ts` | **Reference / execution-based** evals (pass@k on real test suites) — objective, cheap, already wired |
| **Review network** (3 reviewers → `ReviewVerdict{approved, severity, findings}`) | `packages/worker/src/agents/reviewNetwork.ts`, `activities/runReviewNetwork.ts` | An un-framed **LLM-as-judge** — emits verdicts, but never stored as scores nor calibrated |
| **Security scanners** (6, advisory/blocking) | `lib/skillScanner.ts`, `shellCommandScanner.ts`, … | **Programmatic / guardrail** evals |
| **AgentTracer → `AgentTrace`** (every tool call + LLM response, tokens, cost, OTel IDs) | `packages/worker/src/lib/agentTracer.ts`; model `AgentTrace` (schema.prisma:567) | Raw **trajectory** material — nothing scores it yet |
| **`WorkflowRun` / `WorkflowStep`** (status, cost, tokens, outputs) | schema.prisma:520 / :606 | **Outcome** signals — no aggregation/trends |
| **`MemoryItem`** (lessons, `failureType`, pgvector) | schema.prisma:108 | Failure taxonomy to mine for eval cases |
| **PR merge / reject by humans** | gateway webhooks | A free stream of **human labels** — currently uncaptured |

**The honest summary:** the signals are scattered across gates, reviewers, and traces. Evals
are the missing layer that records them as scores, replays them against curated datasets, and
gates changes on regression — with error bars.

---

## 2. Conceptual grounding

An **eval** is a repeatable measurement of output quality against a **dataset** of cases,
scored by a **scorer**, reported as a **distribution with error bars** (not a single pass/fail).

Two axes structure the design:

- **Offline vs online.** *Offline* = a fixed golden dataset run in CI before shipping a change
  (regression testing). *Online* = scoring sampled production traffic continuously (monitoring,
  drift detection).
- **Outcome vs process (trajectory).** *Outcome* = was the end-state correct (tests pass, ticket
  solved)? *Process* = did the agent take a good path (right tools, no wasted steps, no unsafe
  actions)? Agentic systems need **both** — a good diff reached via a reckless trajectory is
  still a failure mode worth catching.

### Scorer taxonomy (what auto-swe will support)

1. **Reference / execution-based** — exact-match, pass@k, or "did the repo's hidden test suite
   pass." Objective and cheap. auto-swe already has the runner (quality gates). **Prefer these
   first**: they are the SWE-bench-Verified model and they don't cost LLM tokens.
2. **LLM-as-judge** — a model grades output against a rubric (pointwise) or against a baseline
   (pairwise A/B). Flexible, but with caveats (see §7): expert-domain judge–human agreement
   often falls to ~60–70% (lower on highly subjective tasks), at or below inter-expert agreement;
   and temperature-0 does **not** guarantee determinism — run judges N× and report mean ± std.
3. **Programmatic / guardrail** — regex/assertion/policy checks (the existing scanners).
4. **Trajectory / process** — scores *how the agent got there*, not just the end-state, from the
   `AgentTrace` rows the system already records (every tool call + LLM response). Programmatic, no
   LLM cost: tool-call correctness (did it call the right tools or flail), efficiency (step count /
   token cost vs. a baseline — a correct diff in 40 steps is worse than in 8), and guardrail
   respect (did it *try* to write `.env` or run a blocked command — the scanners already flag
   these; the scorer counts them). This is the τ-bench dimension: outcome correctness **and**
   policy adherence. A good diff reached via a reckless path is still a failure mode.
5. **Human** — the calibration ground-truth. The PR merge/reject signal is the cheapest source.

Families 1–4 are **machine-scored** (no human in the loop at scoring time); family 5 (Human) is
the ground-truth the machine judges are calibrated against. A single scorer may emit several
**metrics** (sub-axes) — e.g. the trajectory scorer emits tool-correctness, step-count, and
guardrail-hits — so "scorer" names the family and "metric" names a number it produces.

### How a score is computed (the combination model)

The scorers above are **not averaged into one mushy number** — that would hide regressions and
invite gaming. A run's quality is computed in three deliberate stages, mirroring how a good
engineering org reviews a PR ("does it work → is it good → did it behave"):

1. **Gate on the objective floor (hard, binary).** Execution + guardrail scorers must pass:
   tests green, build/typecheck clean, no security block. Fail here ⇒ aggregate score **0**, full
   stop — no judge runs (saves cost on already-failed output). These are ground-truth, so they are
   non-negotiable and never overridden by a favorable judge. *Caveat:* this treats the suite as
   **deterministic** ground-truth. Real suites are flaky (~10% of SWE-bench Lite cases), so a hard
   gate-to-0 over an unscreened suite can measure infra noise, not agent quality — cases must be
   flake-screened at curation and the floor re-run on failure before zeroing (§9).
2. **Rank passing candidates on the soft axes.** Among outputs that clear the floor, the judge
   (rubric) and trajectory scorers produce per-axis numbers (correctness-of-intent, scope,
   readability, efficiency, …) used to *compare* configurations — e.g. prompt A vs. prompt B.
3. **Report per-axis, never one blended verdict.** Each axis is surfaced separately with its N and
   error bars, so a regression is **attributable**: *"tests still pass, but the judge's scope
   score dropped — the new prompt makes the implementer touch unrelated files."* That is
   actionable; a single collapsed number is not.

Two invariants fall out of this model and are enforced everywhere downstream:
- **Execution anchors the subjective.** A judge score is never trusted alone — it is calibrated
  against the one hard signal that already exists (did a human merge it; §4.4). An uncalibrated
  judge may rank, but may not gate.
- **Stacked, not summed.** Keeping the axes separate (execution + judge + trajectory + guardrail)
  is a primary defense against Goodhart's law (§7): it removes any single scalar to optimize and
  raises the cost of gaming — necessary, but not sufficient on its own (frozen held-out sets +
  periodic human trace review are still required; §7).

`EvalResult` stores one row **per scorer** (not per run) precisely so these axes stay
decomposable for trend and regression queries; the eval node's `nodes.<id>.output.score`
aggregate (§4.1) is a *convenience for `cond` branching*, not the system of record.

### Prior art to borrow from

- **SWE-bench / SWE-bench Verified** — agent produces a patch, graded by whether hidden tests
  pass. This is *almost exactly auto-swe's own loop* — so the offline harness runs a
  **small frozen benchmark** (own pinned fixtures, or a SWE-bench Verified slice) as its regression
  set, rather than trying to refreeze moving production history (§4.3).
- **τ-bench (tau-bench)** — tool-use + **policy adherence** in multi-turn agent tasks; measures
  outcome correctness *and* rule-following (pass^k consistency). Directly relevant to "did the
  agent respect the security/policy guardrails."
- **Anthropic, "Adding Error Bars to Evals"** — eval numbers without error bars are
  "essentially meaningless." Use CLT standard errors, **clustered SEs** when cases come in
  related groups (e.g. many tickets from one repo — naive SEs can understate variance ~3×), and
  **paired, question-level** comparison when deciding "is prompt B better than A."

---

## 3. Design principles

These mirror the platform-pivot principles so evals stay coherent with the rest of the system.

1. **Native, DB-backed, self-hosted.** Datasets, scorers, and results live in Postgres + the
   admin UI, consistent with the project's "everything in Prisma, no external SaaS as system of
   record" philosophy (model config, scanners, connections all follow this). External tools
   (Promptfoo/Langfuse) are *optional exporters*, never the source of truth.
2. **Evals are content, the harness is engine.** The mechanism (an `eval` node, a
   `runEvalNode` activity, an `EvalResult` table) is generic; SWE ships seed datasets +
   scorers as content, with no privileged runtime status — same split as Agents/Templates/Skills.
3. **Reuse existing seams.** Score the signals that already exist (gates, review verdicts,
   traces) before inventing new ones. The cheapest, highest-value work is *recording* what the
   system already computes.
4. **Cost-disciplined.** LLM-judge calls run ~$0.001–0.10 each and compound to thousands of
   dollars per full suite at scale. Default scorers to execution-based; sample for online; use a
   small/cheap judge model; support dataset compression (tinyBenchmarks-style anchor subsets).
5. **Governed like everything else.** Datasets/scorers are versioned and scoped through the same
   4-level cascade (`WORKFLOW_TEMPLATE` → `TEAM` → `ORGANIZATION` → `GLOBAL`) and RBAC as Agents
   and model config.
6. **Statistically honest.** Always report N, mean, and standard error. Gate decisions use paired
   comparison + power, never a bare delta on a single run.

---

## 4. Architecture (where evals slot in)

The plan rests on **three measurement mechanisms, ordered by robustness.** The foundation is online
scoring + a small frozen benchmark — both deterministic and cheap. Replaying *real production
history* is a **demoted, optional tier** because it depends on snapshot infra auto-swe lacks (§9);
the foundation does not depend on it.

| Need | Mechanism | Status |
| --- | --- | --- |
| Quality trends / drift | Online scoring of live runs (§4.5) | **foundation** |
| Pre-merge regression gate | Small **frozen benchmark** — own fixtures / SWE-bench slice (§4.3) | **foundation** |
| Fast A/B on one change | **Production canary** (§4.5) | **foundation** |
| Mirror real traffic exactly | Replay historical tickets against their original repos (§4.3) | deferred / optional |

### 4.1 The `eval` workflow node (new node type)

A new declarative node alongside the existing `step` / `agent` / `mcp` / `set` / `cond` /
`fanOut` / `signal` / `terminate` / `shell` / `containerStep` / `human*` nodes
(`packages/shared/src/workflow/spec.ts`). It
evaluates a target value already in the run context and records a score:

```jsonc
{
  "type": "eval",
  "target": { "from": "nodes.implement.output.diff" },  // Binding, like every node input
  "scorers": [
    { "kind": "gate", "gate": "runTests" },             // floor: execution, reuses qualityGates
    { "kind": "assert", "expr": "$.linesChanged < 500" }, // floor: programmatic guardrail
    { "kind": "trajectory", "from": "nodes.implement.traceRef",  // soft: process, reads AgentTrace
      "metrics": ["toolCorrectness", "stepCount", "guardrailHits"] },
    { "kind": "judge", "agentRef": "evalJudge", "rubric": "code-review-quality@3" } // soft: rubric
  ],
  "onFail": "warn",        // a low score warns (or blocks, or retries) — reuses OnFailSchema
  "next": "review"
}
```

Scorer `kind`s map to the four machine-scored families in §2 (`gate`/`assert` = floor;
`trajectory`/`judge` = soft axes). The activity evaluates floor scorers first and short-circuits
the judge when the floor fails (per the combination model above), so a broken diff never costs a
judge call.

The node dispatches to the `runEvalNode` activity (an LLM activity when a `judge` scorer is
present — wrapped in `AgentTracer` + `persistActivityTrace` like every other LLM activity). It
writes one `EvalResult` row per scorer, and exposes an aggregate score at
`nodes.<id>.output.score` for downstream `cond` branching.

This is purely additive: existing specs are unaffected; the interpreter gains one case.

### 4.2 `EvalResult` + `EvalCase` Prisma models (the missing aggregation layer)

```prisma
model EvalResult {
  id          String   @id @default(cuid())
  runId       String?                       // null for offline harness runs
  run         WorkflowRun? @relation(...)
  nodeId      String?                       // the eval node, when in-workflow
  caseId      String?                       // EvalCase, when offline
  agentKey    String?                       // which agent's output was scored
  scorer      String                        // 'gate:runTests' | 'judge:code-review-quality' | 'assert:...'
  scoreType   EvalScoreType                 // BOOLEAN | NUMERIC | CATEGORICAL
  value       Float                         // normalized 0..1 (or 0/1 for boolean)
  passed      Boolean?
  rationale   String?                       // judge explanation / assertion message
  judgeModel  String?
  costUsd     Float?
  metadata    Json?
  createdAt   DateTime @default(now())
  @@index([runId, nodeId])
  @@index([scorer, createdAt])              // trend queries per scorer over time
}

model EvalDataset {
  id      String @id @default(cuid())
  slug    String                            // 'swe-implementer-golden'
  scope   ConfigScope                       // 4-level cascade, like Agent/ModelRoleConfig
  // ... versioned like WorkflowTemplate
  cases   EvalCase[]
}

model EvalCase {
  id          String @id @default(cuid())
  datasetId   String
  input       Json                          // the work request / prompt / fixture
  reference   Json?                         // ground-truth: expected tests, golden diff, ideal answer
  sourceRunId String?                       // provenance when harvested from a real run
  tags        String[]                      // 'repo:payments', 'failureType:CI_FAILURE'
  createdAt   DateTime @default(now())
}
```

`EvalResult` linked to `WorkflowRun`/`WorkflowStep`/`AgentTrace` turns one-off verdicts into
**trends per template / model / prompt-version** — the thing that's impossible today.

### 4.3 Offline eval harness (CLI + frozen benchmark) — the regression gate

A new CLI surface (`auto-swe evals run <dataset> --agent implementer --against baseline`) over a
gateway endpoint (`/api/v1/admin/evals/*`). The **default dataset is a small, frozen benchmark** —
~20–50 cases that are *our own pinned fixtures* (a pinned commit + a known passing/failing test set
per case), or a slice of an existing benchmark such as **SWE-bench Verified**. Because the eval
repos are frozen and owned, the "repos move under you" problem (§9) **does not arise**: the cases
are deterministic by construction, an order of magnitude cheaper than replaying full history, and
need no snapshot-reconstruction infra. The harness:

1. Loads the frozen `EvalDataset`.
2. Runs each case against a **candidate** agent/model/prompt config (existing `modelSpec` cascade +
   agent-version pinning).
3. Scores via execution gates first (objective), then judge.
4. Reports **mean ± standard error vs the baseline**, paired per case, with a regression verdict.

This is a **nightly / release gate**, not per-PR: one implementer case is a multi-minute Docker run
with several LLM calls (on the order of tens of dollars per case), so even a 20–50-case run with
resampling is best run nightly. The §5 "gate" means that nightly run.

> **Deferred tier — replaying real production history.** Replaying *historical tickets against their
> original repos* (the "SWE-bench pointed inward" idea) is more representative of real traffic but
> inherits SWE-bench's hard prerequisite: a per-case baseline SHA + golden test set that auto-swe
> does **not** capture today (it clones `defaultBranch` HEAD, no SHA pinned, and discards the
> container), so a replayed score is incomparable as the repo moves on. This is demoted to an
> **optional later tier**, gated on the replay spike (§6). The regression gate above does **not**
> depend on it — it stands on the frozen benchmark alone.

### 4.4 Promote review-network verdicts to first-class scores

Minimal work, immediate value: the verdicts already exist. Persist each `ReviewVerdict` as an
`EvalResult` (severity → numeric), and **calibrate** the judge against human labels (track Cohen's
κ / correlation over time). But the raw merge/reject label is **confounded, not merely noisy**: the
review network already gated the diff (self-reinforcing), rejected diffs never become PRs
(survivorship bias), and a merge is partly a business decision (deadline, trust-the-bot). More
confounded data narrows nothing. So calibrate against a **decontaminated channel** — a small,
periodically refreshed set re-reviewed by a human who did *not* see the bot's verdict, **including
sampled diffs the network rejected** — against the human–human agreement ceiling, not raw
production merges (§9). Done right, this converts the review network from an opaque gate into a
measured, improvable judge.

### 4.5 Online scoring, drift, and canary

Sample N% of production runs, score trajectory (from `AgentTrace`) + outcome (from
`WorkflowRun`), and surface drift on `/admin/evals` (and a per-run panel on `/runs/[id]`,
alongside the existing security-events panel). The PR-merge signal feeds judge calibration. This
needs no replay — the data already exists per run — which is why it's a **foundation** mechanism,
not a deferred one.

For a *fast* signal on a specific change (without waiting for the nightly benchmark), **canary** the
new prompt/model on a small % of live production traffic and compare outcomes (test-pass rate, merge
rate) against the control. The repo state is real and current by construction, so there is nothing
to replay or freeze. Canary + frozen benchmark together cover the two cases the demoted
historical-replay tier was meant to serve — fast per-change feedback, and a stable regression gate —
without its infra cost.

---

## 5. Practical use cases

Concrete walkthroughs of what evals unlock — each is something the system **cannot do reliably
today**.

1. **Safely change a prompt or skill.** An engineer edits the implementer's system prompt and runs
   `auto-swe evals run swe-implementer-golden --against main`. The **nightly** harness runs the
   frozen benchmark, scores each case (tests pass + judge + trajectory), and prints a paired report:
   *"pass@1 78% → 61% (Δ −17pp, 95% CI [−27, −7]) — regression."* The nightly gate flags it before
   the change ships. Realism matters here: at affordable N (tens–low-hundreds of expensive cases,
   k=1) the suite reliably catches **large** regressions like this, but a 5–7pp delta sits inside
   the error bars and is **not** detectable without far more cases or repeated sampling (§9). Today
   even the large regression is found only by watching real PRs fail in production.
2. **Survive a model swap or provider update.** `implementer` is moved to a cheaper model (or a
   provider silently updates a pinned ID — cf. the seeded `claude-sonnet` retirement note in
   CLAUDE.md). A nightly eval run flags the quality delta *before* target repos feel it, turning
   "we think the new model is fine" into a measured cost/quality trade-off.
3. **Prove the review network earns its cost.** §4.4 persists each `ReviewVerdict` as a score and
   tracks agreement with human merge/reject. If the network rejects diffs humans merge 40% of the
   time, that shows up as low κ — evidence to retune the rubric instead of paying a silent
   productivity tax.
4. **Catch drift and grow a regression suite from failures.** Online scoring (§4.5) surfaces
   *"implementer success on repo X fell over three weeks"* as a dashboard trend. Each production
   failure (already tagged via `MemoryItem.failureType`) is promoted into an `EvalCase`, so the
   same class of bug can't silently return.

---

## 6. Phased roadmap

Each phase is sized to land in one (or a few) PR(s). Phases are additive and independently
shippable; P0 delivers value with **zero new LLM cost**.

| Phase | Scope | New LLM cost | Headline value |
| --- | --- | --- | --- |
| **P0** | `EvalResult` + `EvalScoreType` models; **passively capture** existing gate + review-verdict + merge/reject signals as `EvalResult` rows (with provenance tags). Dashboard deferred until a consumer exists. | none | **Accumulate a labeled corpus for free** so a future harness has data — not dashboards nobody acts on |
| **P1** | Foundation: a **small frozen benchmark** (own fixtures / SWE-bench slice — no history reconstruction) + `auto-swe evals run` + paired error-barred **nightly** gate; **and** thin **online scoring + drift** off existing run data. Scorers = execution gates + **trajectory** (programmatic; trajectory advisory until baselined) | low (no judge yet) | **Nightly regression-gate** (large regressions) + live drift, both on robust mechanisms |
| **P2** | `eval` workflow node + LLM-as-**judge** scorer (rubrics, admin-extensible like `ScannerPattern`); **calibrate** the judge vs a decontaminated human channel (track κ/correlation); **production canary** for fast per-change A/B | medium | In-workflow quality scoring; a *measured*, improvable review network; fast change feedback |
| **P3** *(optional)* | Drift dashboard polish; dataset compression (anchor subsets); cost controls (small judge model, tiered scoring); **deferred historical-replay tier** (per-case SHA + golden test set) *iff* the replay spike cleared | medium (sampled) | Richer coverage that mirrors real traffic — only if it earns its infra cost |

**Sequencing & readiness gates** (why P0 ships now — see §9):
- **Build-vs-buy bake-off (before P1).** Self-host Langfuse + thin score adapters vs. the native
  build, each costed in eng-weeks (§8). Build native only if it wins.
- **Author the frozen benchmark (the P1 critical path).** P1's gate needs ~20–50 curated, pinned
  cases — this is authored, not harvested, so it does **not** wait on production corpus volume. Use
  representative own-fixtures and/or a SWE-bench Verified slice.
- **Replay spike (gates the *optional* P3 historical tier — not P1).** Prove one historical ticket
  can be replayed deterministically (capture a baseline SHA in `executeImplementation`, check it out
  at replay, run the pinned test set, produce one paired score). If it's not cheap, the
  frozen-benchmark foundation stands alone and historical replay stays deferred — nothing in P1 is
  blocked.
- **Corpus readiness (for online drift, not the gate).** The online-drift and harvest-to-`EvalCase`
  signals get statistically meaningful only past ~150 merged/rejected runs across several repos; P0
  accumulates this for free while the frozen-benchmark gate works from day one.
- **P2–P3** additionally defer until a named owner exists for judge calibration + dataset
  governance, and (for the `eval` *node* / product surface) a real user actually pulls for it.

**Exit criteria** (a phase is done when):
- **P0** — gate + review-verdict scores are written as `EvalResult` rows and visible/queryable on `/runs/[id]`; a per-scorer trend query returns rows across runs.
- **P1** — `auto-swe evals run` scores the frozen benchmark and emits a paired, error-barred candidate-vs-baseline report; a platform-scheduled nightly run (a Temporal Schedule, configured per deployment) records a regression verdict; online drift is visible.
- **P2** — the `eval` node runs a judge scorer in-workflow; judge-vs-human agreement (κ) is tracked and surfaced.
- **P3** — a configurable sample of production runs is scored online; the `/admin/evals` dashboard shows a drift trend; eval `costUsd` is reported.

> **Per-phase build plans** (code-grounded, mirroring `platform-pivot-p*.md`):
> [`evals-p0.md`](./evals-p0.md) (signal capture) · [`evals-p1.md`](./evals-p1.md) (frozen-benchmark
> harness + online drift) · [`evals-p2.md`](./evals-p2.md) (`eval` node + judge + calibration +
> canary) · [`evals-p3.md`](./evals-p3.md) (drift dashboard, cost control, suite health, optional
> historical replay).

---

## 7. Pitfalls & guardrails (design constraints, not afterthoughts)

These are baked into the principles above; collected here so they aren't lost.

- **Judge calibration degrades in expert/subjective domains** (often ~60–70% agreement with
  experts, lower on highly subjective tasks — at or below inter-expert agreement). "Is this a good
  code review?" is exactly such a domain → always
  validate the judge against human merge/reject labels; don't trust an uncalibrated judge as a
  gate.
- **Temperature 0 ≠ deterministic.** Judge verdicts can flip across identical runs. Run each
  judged case N× (3–10), report mean ± std, and prefer paired comparison.
- **Goodhart's law.** Once a score is a target, prompts/agents optimize the metric, not the goal.
  Use *stacked* scorers (execution + judge + guardrail), freeze a held-out subset, and keep
  periodic human trace review in the loop.
- **Dataset contamination & train/eval leakage.** Cases harvested from production can leak into
  agent context/memory (`MemoryItem`), inflating scores. Separately, the *same* harvested cases
  must not be used to both tune prompts and evaluate them — keep a **frozen held-out split** for
  judging changes. Tag provenance, hold out that subset, and exclude eval-case repos/tickets from
  memory retrieval during eval runs.
- **Eval-set sizing.** Start small and grow from harvested failures: golden sets are typically
  ~50–500 cases (SWE-bench Verified is 500). Power-analyze (§3) before trusting a delta on a small
  set; use anchor-subset compression only once a set is large enough to be costly.
- **Error bars are mandatory.** Report N + standard error; use clustered SEs when cases group by
  repo; power-analyze before trusting a delta. A bare "score went up 2%" is not a result.
- **Cost is the new bottleneck.** Default execution-based; sample online; small judge model;
  dataset compression. Track eval `costUsd` on `EvalResult` so eval spend is itself observable.

---

## 8. Tooling: build vs buy

This is a **TypeScript** monorepo, which rules out most mature eval frameworks (OpenAI Evals,
DeepEval, Inspect, Ragas are Python-first). Given the project's DB-backed, self-hosted,
config-driven philosophy, the recommendation is to **build a thin native eval layer** (§4) as the
system of record, and treat external tools as **optional exporters** for richer offline analysis:

- **Promptfoo** (OSS, Node lib + CLI, YAML, GitHub-Actions native, red-team mode) — natural fit
  for an *offline regression/red-team* harness that consumes exported datasets.
- **Langfuse** (OSS, self-hostable, **OTel-native**, JS SDK) — natural fit for *online* trace
  scoring; auto-swe already emits OTel + runs Grafana LGTM, so traces export cleanly.
- **Braintrust** (commercial, TS+Py, CI deploy-gating) and **Arize Phoenix** (OSS, has a TS
  `@arizeai/phoenix-evals` package) are alternatives if a hosted experiment loop is wanted later.

**Be honest about the choice.** The "no external SaaS owns our data" invariant only rules out
*hosted* platforms as the system of record (Braintrust). It does **not** apply to **Langfuse and
Promptfoo, which are OSS and self-hostable** — self-hosted Langfuse is Postgres-backed, OTel-native,
and you already run Grafana LGTM, so it plausibly delivers much of P0 (score persistence + trends)
and P3 (online scoring + drift) out of the box. And "a TS monorepo rules out Python-first
frameworks" is half-true: the eval *harness* runs as a separate CI process, not in the worker
isolate, so Python tools (Inspect, Promptfoo red-team) are invokable regardless. So before
committing P1, run the **bake-off** (§6): self-hosted Langfuse + thin adapters vs. the native build,
costed in eng-weeks. Build native only if it wins — otherwise the native layer is undifferentiated
plumbing and a standing maintenance liability.

---

## 9. Risks & open feasibility gaps

This plan was adversarially reviewed from three angles (codebase feasibility, eval methodology,
strategy). No flaw is *architectural* — the plumbing (`EvalResult`/`EvalCase`, the additive `eval`
node, execution-first scoring) is sound — but several load-bearing claims do not survive contact and
must be closed before P1. Severity: 🔴 blocks P1 · 🟠 serious · 🟡 moderate. *This revision demotes
the original top 🔴 (historical replay) out of the P1 critical path — see the first item.*

- 🟡 **Repo state is not frozen → replaying live history is not meaningful** (§4.3). *Originally the
  make-or-break 🔴 gap; demoted by design.* The P1 gate no longer depends on replaying history — it
  runs a **frozen benchmark** of owned/pinned cases, where this problem can't arise. Replaying real
  production history is now an **optional P3 tier**; *if* pursued, its fix is to capture a per-case
  baseline SHA + in-scope passing-test set and check the SHA out at replay — proven first by the
  replay spike (§6). Demoting it is the single biggest de-risking move in this revision.
- 🔴 **Flaky execution floor poisons the headline metric.** Gate-to-0 over an unscreened suite
  measures infra noise, not agent quality (~10% of SWE-bench Lite cases are flaky). *Fix:*
  flake-screen at curation (promote a case only if the reference solution passes k× consistently —
  SWE-bench Verified's method); re-run the floor on failure and only zero on *consistent* failure;
  record per-case flake rate; report infra-failures separately from quality-failures.
- 🔴 **Underpowered for small deltas; the original §5 example was statistically wrong.** At n≈200,
  k=1, the two-proportion SE of a difference is ≈4.7pp, so the minimum detectable effect is ~10–15pp,
  not the 5–7pp the value prop implied (the old "−7pp, p=0.01" was really ≈p=0.13). *Fix (applied):*
  §5 now shows a large, detectable regression and states the limit. Do a real power analysis before
  trusting any sub-10pp delta; budget k>1 on a core anchor set so within-config variance is
  estimable. Clustered SEs (§2) shrink the *effective* N further when cases group by repo.
- 🟠 **Judge-calibration label is confounded, not just noisy** (§4.4). Self-reinforcing gating +
  survivorship + merge-as-business-decision. *Fix:* decontaminated human channel that re-reviews
  *rejected* diffs too; track κ against that, not raw merges.
- 🟠 **The judge axis is leaned on hardest where it's weakest** (κ≈0.45 on subjective SE tasks), yet
  §10 defaults to a single cheap judge — the worst quadrant for a gating signal. *Fix:* pairwise
  (relative) judging by default; ensemble or a stronger model when a judge axis influences a gate;
  the **judge model must differ from the implementer model** (self-preference bias); keep the judge
  **advisory / non-blocking** until its κ clears a stated threshold — wire the gate to execution +
  trajectory.
- 🟠 **The Goodhart defense is necessary but unmechanized.** *Fix:* make the held-out set a real
  mechanism — separate `EvalDataset` scope, RBAC so prompt-authors can't read its cases or per-case
  scores, a stated rotation policy — plus an **implementer/rubric wall**: golden references and
  rubric text are never visible to the implementer agent in any run (reward-hacking guard).
- 🟠 **No decision rule for conflicting axes.** "Report per-axis, never blended" (§2) has no
  tie-breaker: when scope↑ but readability↓, does the gate block? *Fix:* execution + guardrail are
  blocking; trajectory + judge are advisory-with-thresholds; a named approver adjudicates mixed soft
  results. A gate must terminate in a decision.
- 🟡 **On-distribution coverage limit.** Evals catch regressions *resembling past failures*; new
  repos/ticket-shapes pass green and still need a production canary. *Fix:* state the precondition in
  §5; add per-tag (repo/capability) **stratified reporting** with its own N + error bar (without it,
  use-cases §5.2/§5.4 don't actually close); keep a canary as the off-distribution backstop.
- 🟡 **Dataset rot has no owner or re-validation loop.** A 6-month-old case's reference can stop
  applying to today's repo, silently becoming a permanent floor-failure. *Fix:* a periodic job that
  re-runs each golden case's reference against current repo state and quarantines now-failing (stale)
  cases; a named owner + cadence; treat the golden set as a carrying-cost liability, not a one-time
  asset.
- 🟡 **The eval system itself needs evals; cost can spiral.** A stale/flaky/miscalibrated suite
  yields *false confidence* — worse than none. *Fix:* surface suite-health (flake rate, stale-case
  rate, judge κ) on `/admin/evals` as first-class blocking signals; add a per-suite cost ceiling +
  tiered scoring (cheap floor on all, expensive judge on a sampled anchor subset) as hard policy.

**Strategic posture.** Three independent forces (immature labeled corpus, the unfinished platform
pivot reshaping these abstractions, and a build-vs-buy case that must be tested against self-hosted
OSS) say: ship **P0 now** (cheap, additive, pivot-agnostic, accumulates the corpus), run the two
spikes (§6), and **defer P1–P3** until the spikes clear and the corpus exists. The thesis is sound;
the timing and scope are what this review pulls back.

---

## 10. Open questions

- **Judge model selection.** A dedicated `evalJudge` Agent (own `modelSpec`, cheap model) vs
  reusing the `reviewer` model? Leaning dedicated, for cost control and independent calibration.
- **Dataset seeding policy.** Auto-harvest every run into a candidate pool vs curate manually?
  Likely auto-harvest → human-promote to the golden set, with contamination tagging.
- **CI gate strictness.** Block merge on any regression, or only on a statistically significant
  one (paired, powered)? Leaning significance-gated to avoid flakiness blocking developers.
- **Trajectory metric weights.** The trajectory scorer is defined (§2, §4.1) — programmatic, over
  `AgentTrace` — but the *relative weight* of its metrics (tool-call correctness vs. step-count
  efficiency vs. guardrail hits) and the per-repo baselines they compare against still need
  tuning against real runs (τ-bench as a model). This is calibration, not a question of whether to
  build it.

---

## 11. References

- SWE-bench / SWE-bench Verified — execution-graded coding-agent benchmark (the inward model for §4.3)
- τ-bench (tau-bench) — tool-use + policy-adherence agent eval
- Anthropic, *Adding Error Bars to Evals* — statistical rigor for eval scores
- Anthropic, *Demystifying evals for AI agents* — engineering guidance
- LLM-as-a-judge calibration & contamination literature (judge–human agreement studies; benchmark-contamination work on GSM8K/MMLU)
- Tooling: OpenAI Evals, Promptfoo, Langfuse, Braintrust, Arize Phoenix, Inspect (UK AISI), DeepEval, Ragas
