# Evals — P0: Signal capture

> Build plan for **Phase P0** of the [evals RFC](./evals.md). P0 is the cheap, additive,
> pivot-agnostic first slice: stand up the `EvalResult` table and **passively capture** the quality
> signals the system *already computes* — quality-gate pass/fail, review-network verdicts, and the
> human PR merge/reject — as first-class, queryable, trend-able rows. **Zero new LLM cost.** No
> offline harness, no judge, no datasets, no dashboards beyond one minimal read path.
>
> Parent RFC: [`evals.md`](./evals.md) — see §4.2 (models), §4.4 (review verdicts → scores), §6
> (roadmap), §9 (risks). P0 is **greenlit** independent of the P1 spikes: none of the §9 risks touch
> it, and it accumulates the labeled corpus the later phases need.

---

## Outcomes (definition of done)

1. **`EvalResult` model + `EvalScoreType` / `EvalSignalSource` enums** migrated, matching house
   schema conventions (UUID PK, `@@map` snake_case, `@db.Timestamptz`, indexed for trend queries).
2. **Gate capture.** Every `runGate` result writes one `EvalResult` row (`source = GATE`,
   `scorer = 'gate:<name>'`).
3. **Review-verdict capture.** Every `ReviewVerdict` from the review network writes one `EvalResult`
   row (`source = REVIEW`, `scorer = 'review:<REVIEWER>'`, severity → numeric).
4. **Merge/reject capture.** The PR webhook writes one `EvalResult` row per merge/close, linked back
   to the `WorkflowRun` (`source = MERGE`) — the human label stream.
5. **Capture is best-effort.** A capture failure (DB hiccup, missing run link) is swallowed and
   logged; it must **never** fail the activity, workflow, or webhook (mirrors the LLM-output-scanner
   try/catch and `costTracking` patterns).
6. **One minimal read path.** `GET /api/v1/workflow-runs/:id/eval-results` returns the rows for a
   run, plus a thin per-run panel on `/runs/[id]` so the captured data has a consumer. (Trend
   dashboards are deferred to P3.)
7. **Tests.** Migration applies; each capture path writes the expected row shape against a mock
   Prisma; a capture throw does not propagate; the read endpoint returns rows.

## Non-goals (deferred)

- Offline harness, `auto-swe evals run`, frozen benchmark, paired stats → **P1**.
- `EvalDataset` / `EvalCase` authoring + the `caseId` foreign key → **P1** (P0 ships `caseId` as a
  bare nullable column, no relation yet, so production rows don't need a case).
- LLM-as-judge scorer, the `eval` workflow node, judge calibration → **P2**.
- Trend dashboard at `/admin/evals`, online sampling, dataset compression → **P3**.
- Trajectory scoring (needs a baseline; programmatic but net-new) → **P1**.

## The guiding constraint

P0 only **records** what the system already produces — it changes **no agent behavior and gates
nothing**. Every write is additive and best-effort. Writes happen in **activities** and the
**gateway**, never in the workflow V8 isolate. The capture helper mirrors `costTracking.ts` /
`AgentTracer`: a thin function over the `@auto-swe/shared/db` singleton, wrapped by callers in
try/catch.

---

## Workstreams

### WS1 — Schema: `EvalResult` + enums + migration
**Why:** the missing aggregation layer; one row **per scorer** so axes stay decomposable (RFC §2).

- **Schema** (`packages/shared/src/prisma/schema.prisma`), matching the `Agent`/`AgentTrace` house
  style (UUID PK via `dbgenerated("gen_random_uuid()")`, `@map` snake_case, `@db.Timestamptz`):

  ```prisma
  enum EvalScoreType {
    BOOLEAN
    NUMERIC
    CATEGORICAL
  }

  enum EvalSignalSource {
    GATE
    REVIEW
    MERGE
    JUDGE        // reserved — P2
    TRAJECTORY   // reserved — P1
  }

  model EvalResult {
    id         String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    runId      String?          @map("run_id") @db.Uuid
    run        WorkflowRun?     @relation(fields: [runId], references: [id], onDelete: Cascade)
    nodeId     String?          @map("node_id")
    caseId     String?          @map("case_id") @db.Uuid   // FK added in P1 (EvalCase)
    agentKey   String?          @map("agent_key")
    source     EvalSignalSource
    scorer     String           // 'gate:runTests' | 'review:SECURITY' | 'merge'
    scoreType  EvalScoreType    @map("score_type")
    value      Float            // normalized 0..1 (0/1 for BOOLEAN)
    passed     Boolean?
    rationale  String?
    judgeModel String?          @map("judge_model")
    costUsd    Float?           @map("cost_usd")
    metadata   Json?
    createdAt  DateTime         @default(now()) @map("created_at") @db.Timestamptz

    @@index([runId])
    @@index([scorer, createdAt])   // per-scorer trend queries
    @@index([source, createdAt])
    @@map("eval_results")
  }
  ```
- Add the back-relation on `WorkflowRun` (schema.prisma ~:520): `evalResults EvalResult[]`.
- **Migration:** `yarn db:migrate:dev --name add_eval_results` then `yarn db:generate`. (Migrations
  live in `packages/shared/src/prisma/migrations/`.)
- **Acceptance:** migration applies on a clean DB; `prisma.evalResult` is typed in the generated
  client.

### WS2 — Capture helper + gate capture
**Why:** one choke point for writes; wire the cheapest, most objective signal first.

- **New** `packages/worker/src/lib/evalCapture.ts` — a thin, best-effort writer over the db
  singleton (model on `costTracking.ts`):

  ```ts
  import { prisma } from '@auto-swe/shared/db';
  // EvalResultInput = Omit<EvalResult, 'id' | 'createdAt'>
  export async function recordEvalResult(input: EvalResultInput): Promise<void> {
    try { await prisma.evalResult.create({ data: input }); }
    catch (err) { /* log + swallow — capture must never break the caller */ }
  }
  ```
- **Hook gate results** in `runGate` (`packages/worker/src/activities/qualityGates.ts`, right after
  `putArtifact()` ~:200): map `GateResult{passed, exitCode, artifactId}` →
  `{ source: 'GATE', scorer: 'gate:'+gate, scoreType: 'BOOLEAN', value: passed?1:0, passed,
  metadata: { exitCode, artifactId }, runId: <resolved> }`. Resolve `runId` via the same
  `activityContext` helper `persistActivityTrace` uses (`currentWorkflowRunId()`).
- **Acceptance:** a passing and a failing gate each produce one row with the right `scorer`/`value`;
  a forced `prisma` throw is swallowed and the gate result is still returned.

### WS3 — Review-verdict capture (severity → numeric)
**Why:** turn the existing (un-framed) LLM-as-judge into measured scores (RFC §4.4).

- **Hook** the activity wrapper `runReviewNetwork`
  (`packages/worker/src/activities/runReviewNetwork.ts`, after `runReview()` returns ~:49): loop
  `result.verdicts` and write one row each:
  - `source: 'REVIEW'`, `scorer: 'review:'+verdict.reviewer` (`SECURITY`/`DOMAIN_LOGIC`/`PERFORMANCE`)
  - `passed: verdict.approved`, `scoreType: 'NUMERIC'`
  - `value`: **severity → numeric map** — `PASS→1.0, INFO→0.9, WARNING→0.5, CRITICAL→0.0`
  - `metadata: { severity, findingsCount: verdict.findings.length }`
- Define the severity map as an exported constant so P2 calibration reuses it.
- **Acceptance:** a 3-reviewer run writes 3 rows with the mapped values; an aggregate-level row is
  *not* written (decomposability — RFC §2).

### WS4 — Merge/reject capture (the human label)
**Why:** the cheapest ground-truth stream; feeds P2 judge calibration.

- **Hook** the PR webhook (`packages/gateway/src/routes/webhooks.ts`, the `/git` handler ~:206).
  Today it resolves `PullRequest → workflow (ActiveWorkflow)` and signals Temporal. There is **no
  direct `PullRequest → WorkflowRun` FK** (flagged): resolve the run by `workflowId`:
  ```ts
  const run = await fastify.prisma.workflowRun.findFirst({
    where: { workflowId: pullRequest.workflow.temporalWorkflowId },
    select: { id: true },
  });
  ```
  Then write `{ source: 'MERGE', scorer: 'merge', scoreType: 'BOOLEAN', value: 1, passed: true,
  runId: run.id, metadata: { prNumber } }`. **Status: shipped for merge.** Close-without-merge
  (the reject = `value 0` label) is **deferred**: the PR event normalizer maps non-merge closes to
  `ignored`, so capturing rejects needs a normalizer change. It matters for survivorship bias in P2
  calibration (RFC §9) and is a tracked follow-up.
- Best-effort: the whole block is wrapped in try/catch so a capture miss (or a missing
  `workflowRun`/`evalResult` accessor) never blocks the webhook's signal path.
- **Acceptance:** a merge webhook writes a `value:1` row linked to the run; an unlinked PR is a
  no-op; the merge + signal path still succeeds even if capture throws.

### WS5 — Minimal read path (the consumer)
**Why:** captured data needs one consumer so P0 isn't write-only; full trend dashboards wait for P3.

- **Gateway:** `GET /api/v1/workflow-runs/:id/eval-results` (member-auth, same guard as the run
  detail route) → `{ data: EvalResult[] }`, ordered `createdAt asc`. Thin handler; no new service
  module needed.
- **Shared types:** add `EvalResultDto` to `packages/shared/src/types/api.ts` (domain block).
- **Web (thin):** a small "Evaluation signals" panel on `/runs/[id]`
  (`packages/web/src/app/runs/[id]/page.tsx`) backed by a `useEvalResultsForRun(runId)` TanStack
  hook (model on `useEvalScoresForRun` / the security-events panel). Renders the per-scorer rows as
  a list — gate pass/fail, review severities, merge outcome. No charts.
- **Acceptance:** the endpoint returns a run's rows; the panel lists them; empty runs render an empty
  state.

### WS6 — Tests
- **Schema:** migration applies; `evalResult` CRUD typed.
- **Capture:** unit-test each of WS2/WS3/WS4 against a mock Prisma — assert row shape; assert a
  thrown `prisma.create` is swallowed and the caller still returns.
- **Severity map:** table-test `PASS/INFO/WARNING/CRITICAL → 1.0/0.9/0.5/0.0`.
- **Endpoint:** `app.inject()` returns the seeded rows for a run id.

---

## Exit criteria (from RFC §6)

Gate + review-verdict + merge signals are written as `EvalResult` rows (with provenance in
`metadata`) and visible on `/runs/[id]`; a per-scorer trend query (`scorer, createdAt` index)
returns rows across runs. **No agent behavior changed; no LLM cost added.**

## Risk notes carried from RFC §9

- These rows are **production observations**, not dataset cases (`caseId` null) — so the flaky-floor
  and small-N concerns (§9) do **not** apply to P0; they bite only when these signals are used as a
  *gate* in P1+. P0 is pure capture.
- The merge label is **confounded** (§9): capture it, but P2 calibration must use a decontaminated
  channel, not these raw rows alone. Record close-without-merge too (done in WS4) to avoid
  survivorship bias from day one.
