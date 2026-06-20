# Evals — RFC & Roadmap

Living planning doc for **evals**: a first-class, native capability that measures the
quality of agent/LLM output in auto-swe — offline (regression-gating prompt/model/skill
changes before they ship) and online (scoring real runs to catch drift). Like the platform
pivot, evals are framed as a **platform feature**, not a SWE-only add-on: the engine gains a
generic eval mechanism, and SWE ships the first eval *content* (datasets + scorers) as seed
data.

> Status: **Proposed** (rev. 2026-06-20). Nothing here is built yet. This doc establishes
> the vision, the conceptual grounding, and a phased build plan sized so each phase lands in
> one (or a small handful of) PR(s). Per-phase build plans (`evals-p0.md`, …) will be split
> out as phases are committed for build, mirroring the `platform-pivot-p*.md` convention.

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
   (pairwise A/B). Flexible, but with caveats (see §6): expert-domain judge–human agreement is
   only ~64–68%, and temperature-0 does **not** guarantee determinism — run judges N× and report
   mean ± std.
3. **Programmatic / guardrail** — regex/assertion/policy checks (the existing scanners).
4. **Human** — the calibration ground-truth. The PR merge/reject signal is the cheapest source.

### Prior art to borrow from

- **SWE-bench / SWE-bench Verified** — agent produces a patch, graded by whether hidden tests
  pass. This is *almost exactly auto-swe's own loop* — so the offline harness can run a
  SWE-bench-style suite against the project's **own historical tickets** as regression cases.
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
2. **Evals are content, the harness is engine.** The mechanism (an `eval` node, an
   `evaluateOutput` activity, an `EvalResult` table) is generic; SWE ships seed datasets +
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

### 4.1 The `eval` workflow node (new node type)

A new declarative node alongside the existing `step` / `agent` / `mcp` / `fanOut` / `cond` /
`signal` / `terminate` / `shell` / `human*` nodes (`packages/shared/src/workflow/spec.ts`). It
evaluates a target value already in the run context and records a score:

```jsonc
{
  "type": "eval",
  "target": { "from": "nodes.implement.output.diff" },  // Binding, like every node input
  "scorers": [
    { "kind": "gate", "gate": "runTests" },             // execution-based, reuses qualityGates
    { "kind": "judge", "agentRef": "evalJudge", "rubric": "code-review-quality@3" },
    { "kind": "assert", "expr": "$.linesChanged < 500" }
  ],
  "onFail": "warn",        // a low score warns (or blocks, or retries) — reuses OnFailSchema
  "next": "review"
}
```

The node dispatches to a new `evaluateOutput` activity (an LLM activity when a `judge` scorer is
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

### 4.3 Offline eval harness (CLI + dataset) — the highest-leverage piece

A new CLI surface (`auto-swe evals run <dataset> --agent implementer --against baseline`) over a
gateway endpoint (`/api/v1/admin/evals/*`). It:

1. Loads an `EvalDataset` (seeded from real `WorkflowRun` history + curated golden tickets).
2. Replays each case against a **candidate** agent/model/prompt configuration (using the existing
   per-agent `modelSpec` cascade and agent-version pinning).
3. Scores via execution gates first (objective), then judge.
4. Reports **mean ± standard error vs the baseline**, paired per case, with a pass/fail verdict
   on the regression gate.

This makes prompt edits and model swaps **safe**: a regression is caught in CI before it ships,
instead of via failed PRs. It's the SWE-bench-Verified pattern pointed inward.

### 4.4 Promote review-network verdicts to first-class scores

Minimal work, immediate value: the verdicts already exist. Persist each `ReviewVerdict` as an
`EvalResult` (severity → numeric), and **calibrate** the judge against human merge/reject
outcomes (track Cohen's κ / correlation over time). This converts the review network from an
opaque gate into a measured, improvable judge.

### 4.5 Online scoring + drift dashboard

Sample N% of production runs, score trajectory (from `AgentTrace`) + outcome (from
`WorkflowRun`), and surface drift on `/admin/evals` (and a per-run panel on `/runs/[id]`,
alongside the existing security-events panel). The PR-merge signal feeds judge calibration.

---

## 5. Phased roadmap

Each phase is sized to land in one (or a few) PR(s). Phases are additive and independently
shippable; P0 delivers value with **zero new LLM cost**.

| Phase | Scope | New LLM cost | Headline value |
| --- | --- | --- | --- |
| **P0** | `EvalResult` + `EvalScoreType` models; persist existing **gate results** and **review verdicts** as scores; per-run eval panel on `/runs/[id]` | none | Make the signals the system already computes *queryable and trended* |
| **P1** | Offline harness: `EvalDataset`/`EvalCase` (seed from run history), `auto-swe evals run`, gateway endpoints, baseline comparison **with error bars**, CI integration. Scorers = execution gates first | low (no judge yet) | **Regression-gate** prompt/model/skill changes before they ship |
| **P2** | `eval` workflow node + LLM-as-**judge** scorer (rubrics, admin-extensible like `ScannerPattern`); **calibrate** the judge vs merge/reject labels (track κ/correlation) | medium | In-workflow quality scoring; a *measured*, improvable review network |
| **P3** | Online sampling + drift dashboard at `/admin/evals`; dataset compression (anchor subsets); cost controls (small judge model, tiered scoring) | medium (sampled) | Continuous quality monitoring + drift detection at controlled cost |

> Suggested split-out docs as phases are committed: `evals-p0.md`, `evals-p1.md`, … (mirrors
> `platform-pivot-p*.md`).

---

## 6. Pitfalls & guardrails (design constraints, not afterthoughts)

These are baked into the principles above; collected here so they aren't lost.

- **Judge calibration degrades in expert/subjective domains** (~64–68% agreement with experts —
  below inter-expert agreement). "Is this a good code review?" is exactly such a domain → always
  validate the judge against human merge/reject labels; don't trust an uncalibrated judge as a
  gate.
- **Temperature 0 ≠ deterministic.** Judge verdicts can flip across identical runs. Run each
  judged case N× (3–10), report mean ± std, and prefer paired comparison.
- **Goodhart's law.** Once a score is a target, prompts/agents optimize the metric, not the goal.
  Use *stacked* scorers (execution + judge + guardrail), freeze a held-out subset, and keep
  periodic human trace review in the loop.
- **Dataset contamination.** Cases harvested from production can leak into agent context/memory
  (`MemoryItem`), inflating scores. Tag provenance, hold out a frozen subset, and exclude
  eval-case repos/tickets from memory retrieval during eval runs.
- **Error bars are mandatory.** Report N + standard error; use clustered SEs when cases group by
  repo; power-analyze before trusting a delta. A bare "score went up 2%" is not a result.
- **Cost is the new bottleneck.** Default execution-based; sample online; small judge model;
  dataset compression. Track eval `costUsd` on `EvalResult` so eval spend is itself observable.

---

## 7. Tooling: build vs buy

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

Buying a platform as the *source of truth* would break the "no external SaaS owns our data"
invariant the rest of the system holds to — hence native-first.

---

## 8. Open questions

- **Judge model selection.** A dedicated `evalJudge` Agent (own `modelSpec`, cheap model) vs
  reusing the `reviewer` model? Leaning dedicated, for cost control and independent calibration.
- **Dataset seeding policy.** Auto-harvest every run into a candidate pool vs curate manually?
  Likely auto-harvest → human-promote to the golden set, with contamination tagging.
- **CI gate strictness.** Block merge on any regression, or only on a statistically significant
  one (paired, powered)? Leaning significance-gated to avoid flakiness blocking developers.
- **Trajectory scoring rubric.** What defines a "good" agent trajectory beyond outcome — tool-call
  efficiency, guardrail respect, step count? Needs its own rubric design (τ-bench as a model).

---

## 9. References

- SWE-bench / SWE-bench Verified — execution-graded coding-agent benchmark (the inward model for §4.3)
- τ-bench (tau-bench) — tool-use + policy-adherence agent eval
- Anthropic, *Adding Error Bars to Evals* — statistical rigor for eval scores
- Anthropic, *Demystifying evals for AI agents* — engineering guidance
- LLM-as-a-judge calibration & contamination literature (see research notes)
- Tooling: OpenAI Evals, Promptfoo, Langfuse, Braintrust, Arize Phoenix, Inspect (UK AISI), DeepEval, Ragas
