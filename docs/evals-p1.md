# Evals — P1: Frozen-benchmark offline harness + online drift

> Build plan for **Phase P1** of the [evals RFC](./evals.md). P1 delivers the **regression gate on
> robust mechanisms**: a nightly offline harness that scores a candidate agent/model/prompt against
> a **small frozen benchmark** (owned, SHA-pinned fixtures or a SWE-bench Verified slice), plus thin
> **online scoring + drift** off the P0 capture rows. **No LLM judge yet** — scorers are execution
> gates + a programmatic trajectory scorer.
>
> Parent RFC: [`evals.md`](./evals.md) §4.3 (frozen benchmark), §4.5 (online/drift), §6 (roadmap),
> §9 (flaky-floor, small-N, coverage risks). Builds on [`evals-p0.md`](./evals-p0.md) (the
> `EvalResult` table + capture). **Demotes historical replay to the optional P3 tier** — the gate
> here never replays moving production history.

---

## Gating prerequisites (RFC §6 — do these before committing P1)

1. **Build-vs-buy bake-off.** Self-host Langfuse + thin adapters vs. native; cost in eng-weeks. If
   Langfuse wins for score storage + drift, P1 shrinks to "author benchmark + thin adapter." Build
   native only if it wins.
2. **Author the frozen benchmark** (the critical path — authored, not harvested, so it does **not**
   wait on production volume): ~20–50 cases, each a pinned fixture repo + golden test set.

The **replay spike** is *not* a P1 prerequisite — it gates the optional P3 historical tier only.

## Outcomes (definition of done)

1. **`EvalDataset` / `EvalCase` / `EvalRun` models** (frozen-fixture shape: per-case `baselineSha` +
   golden test command/set + tags + flake-screen flags). `EvalResult` gains `caseId` FK + `evalRunId`.
2. **SHA-pinned workspaces.** `createWorkspace(..., checkoutSha?)` checks out a fixed commit so a
   fixture case is deterministic by construction (RFC §4.3).
3. **Standalone scorers.** Execution gates runnable outside a workflow (`runGateStandalone`); a
   **programmatic trajectory scorer** over `AgentTrace` (advisory until baselined).
4. **Offline harness** = a durable **`evalRunWorkflow`** that, per case: provisions the fixture at
   `baselineSha`, runs the candidate implementer, scores via gates + trajectory, writes `EvalResult`
   rows, and computes a **paired, error-barred** candidate-vs-baseline verdict — **stratified by tag**.
5. **Flake screening** at curation: a case is promoted only if its reference passes k× consistently;
   the floor re-runs on failure and zeroes only on *consistent* failure (RFC §9).
6. **CLI + gateway:** `auto-swe evals run|list <dataset> --candidate <ref> --against <ref>` over
   `/api/v1/admin/evals/*`, plus a **platform-native nightly schedule** (a Temporal Schedule firing
   `ScheduledEvalWorkflow`, configured in the DB and managed at `/admin/workflow` — the same pattern
   as lesson consolidation).
7. **Online drift:** a thin trend query + extension of P0 capture so per-scorer drift over time is
   computable (dashboard polish itself is P3).
8. **Tests:** harness scores a 2-case fixture set end-to-end with fakes; paired-stats unit tests;
   flake-screen unit test; SHA checkout integration test.

## Non-goals (deferred)

- LLM-as-judge scorer, the `eval` *workflow node*, judge calibration, production canary → **P2**.
- `/admin/evals` drift **dashboard**, dataset compression, cost ceilings, golden-set re-validation,
  and the **optional historical-replay tier** → **P3**.
- Multi-tenant dataset governance UI beyond admin CRUD → P3.

## The guiding constraint

The harness must run agents in **Docker workspaces via activities** (never the workflow isolate),
and it must be **deterministic by construction**: fixtures are owned and SHA-pinned, so the
"repos move under you" problem (RFC §9) cannot arise. Execution + trajectory are programmatic (no
LLM cost on the scorer side; the *candidate run* still costs tokens, hence **nightly, not per-PR**).

---

## Workstreams

### WS1 — Schema: datasets, cases, runs
**Why:** the frozen benchmark + a run record to group per-case results.

- **Schema** (`packages/shared/src/prisma/schema.prisma`), house style (UUID PK, `@@map`, scope
  cascade like `Agent`):
  ```prisma
  model EvalDataset {
    id          String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    slug        String                                  // 'swe-implementer-golden'
    scope       ConfigScope
    teamId      String?      @map("team_id") @db.Uuid
    orgId       String?      @map("org_id") @db.Uuid
    name        String
    description String?
    createdAt   DateTime     @default(now()) @map("created_at") @db.Timestamptz
    cases       EvalCase[]
    runs        EvalRun[]
    @@index([scope, teamId])
    @@map("eval_datasets")
  }

  model EvalCase {
    id           String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    datasetId    String      @map("dataset_id") @db.Uuid
    dataset      EvalDataset @relation(fields: [datasetId], references: [id], onDelete: Cascade)
    input        Json                                   // the work-request / prompt payload
    repoUrl      String      @map("repo_url")           // fixture repo (owned/pinned)
    baselineSha  String      @map("baseline_sha")       // pinned commit — determinism
    goldenTest   String      @map("golden_test")        // in-scope test command/set
    reference    Json?                                  // optional golden diff / expected
    tags         String[]                               // 'repo:x','capability:y' — stratify (§9)
    flakeScreened Boolean    @default(false) @map("flake_screened")
    flakeRuns    Int         @default(0) @map("flake_runs")
    sourceRunId  String?     @map("source_run_id") @db.Uuid   // provenance if harvested (P3)
    createdAt    DateTime    @default(now()) @map("created_at") @db.Timestamptz
    @@index([datasetId])
    @@map("eval_cases")
  }

  model EvalRun {
    id           String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    datasetId    String      @map("dataset_id") @db.Uuid
    dataset      EvalDataset @relation(fields: [datasetId], references: [id])
    candidateRef String      @map("candidate_ref")      // agent/model/prompt under test
    baselineRef  String      @map("baseline_ref")
    status       String                                 // RUNNING|SUCCESS|FAILED
    summary      Json?                                  // paired stats verdict
    startedAt    DateTime    @default(now()) @map("started_at") @db.Timestamptz
    endedAt      DateTime?   @map("ended_at") @db.Timestamptz
    results      EvalResult[]
    @@index([datasetId, startedAt])
    @@map("eval_runs")
  }
  ```
- **`EvalResult` (from P0)** gains: `evalRunId String? @db.Uuid` (+ relation) and the real `caseId`
  FK to `EvalCase`. Online/production rows keep both null.
- **Migration:** `yarn db:migrate:dev --name add_eval_datasets` + `yarn db:generate`.
- **Acceptance:** models typed; a dataset with 2 cases + a run + per-case results round-trips.

### WS2 — SHA-pinned workspace
**Why:** the determinism guarantee the whole gate rests on.

- **`createWorkspace`** (`packages/worker/src/activities/workspace.ts` ~:33) gains an optional
  `checkoutSha?: string`. After the clone/branch (~:77): if set,
  `git reset --hard <shellQuote(sha)>` so the fixture is at the exact pinned commit (clone may need
  full history, not `--depth=50`, when the SHA is old — make depth conditional on `checkoutSha`).
- **Acceptance:** integration test: a fixture repo checked out at a known SHA exposes exactly that
  tree; a moved `defaultBranch` does not affect it.

### WS3 — Standalone scorers (execution + trajectory)
**Why:** score a candidate diff outside a workflow; add the programmatic trajectory axis.

- **`packages/worker/src/activities/standaloneGateRunner.ts`** (NET-NEW): `runGateStandalone({
  authedRepoUrl, branch, defaultBranch, checkoutSha, gate, command, image, timeoutMs })` — reuses
  `createWorkspace` + `execCapture` (the `runGate` internals, minus the workflow/`RepoWorkRequest`
  coupling) and returns the existing `GateResult`.
- **`packages/worker/src/lib/trajectoryScorer.ts`** (NET-NEW): given a run's `AgentTrace` rows,
  compute `{ toolCorrectness, stepCount, guardrailHits }`. **Advisory until baselined** (RFC §9) —
  emit metrics but do not let them gate; per-tag baselines are tuned later.
- **Flake screening:** `screenCase(case, k)` runs the reference solution `k×` via `runGateStandalone`
  and sets `flakeScreened` only on consistent pass; records `flakeRuns`. The harness floor
  (WS4) re-runs a failing gate up to `m×` and zeroes only on consistent failure; flaked cases are
  reported **separately** from quality failures.
- **Acceptance:** standalone gate scores a fixture diff; trajectory scorer returns metrics from
  seeded traces; a deliberately flaky reference is caught by `screenCase`.

### WS4 — Offline harness (`evalRunWorkflow`) + paired stats
**Why:** the nightly regression gate itself.

- **Durable workflow** `packages/worker/src/workflows/evalRun.workflow.ts` (NET-NEW) — a Temporal
  workflow (so a long multi-case run is durable + observable in the Temporal UI), dispatching
  activities only. Per case, for **both** candidate and baseline refs:
  1. provision fixture at `baselineSha` (WS2);
  2. run the implementer (reuse the `executeImplementation` path, parameterized by the resolved
     candidate/baseline agent ref — via the existing `agentVersions` pin / `modelSpec` cascade);
  3. score via `runGateStandalone` (floor) + `trajectoryScorer` (advisory);
  4. write `EvalResult` rows (`evalRunId`, `caseId`, per scorer).
- **Stats** `packages/worker/src/lib/evalStats.ts` (NET-NEW): **paired** candidate-vs-baseline on the
  per-case binary floor outcome — `pairedProportionDelta(pairs) → { delta, se, ci95, n }` (McNemar /
  paired-proportion), with a **clustered-SE** variant keyed by repo tag (RFC §2). Aggregate
  **stratified by tag** (per-repo / per-capability pass-rate with its own N + CI — RFC §9 coverage
  fix). Verdict = regression iff the 95% CI of Δ excludes 0 in the worse direction. The harness
  writes the verdict + N + CI to `EvalRun.summary`.
- **Decision rule (RFC §9):** execution + guardrail are **blocking**; trajectory is advisory. (Judge
  arrives in P2.)
- **Acceptance:** a 2-case fixture run produces per-case rows + an `EvalRun.summary` with Δ, SE, CI,
  per-tag breakdown; a seeded regression flips the verdict; stats unit-tested against known inputs
  (incl. the §9 worked example — a −17pp/large delta resolves significant, a 5–7pp/small delta does
  **not** at small N).

### WS5 — Gateway + CLI + nightly schedule
**Why:** drive the harness and gate on it.

- **Gateway** `packages/gateway/src/routes/evals.ts` + `lib/evalService.ts` (NET-NEW; copy the
  `agentLibrary` route/service + `securityEvents` pagination patterns, `requireAuth({ requiredRole:
  'ADMIN' })`, `writeAuditLog`): dataset CRUD, `POST /api/v1/admin/evals/runs` (start an
  `evalRunWorkflow` via `fastify.temporal`), `GET …/runs/:id`, and a paginated
  `GET …/evals/results/query` trend endpoint. Register at the admin choke point in
  `packages/gateway/src/index.ts` (after `securityEventRoutes`).
- **Shared types:** `EvalDataset*`, `EvalCase`, `EvalRun*`, `EvalResultDto` in
  `packages/shared/src/types/api.ts`.
- **CLI** `packages/cli/src/commands/evals.ts` (NET-NEW; copy `workflows.ts` dispatch +
  `apiRequest`): `auto-swe evals list`, `evals run <dataset> --candidate <ref> --against <ref>`
  (prints the paired report; exit code 1 on regression so CI fails), `evals show <runId>`. Wire into
  `cli/src/index.ts` dispatch.
- **Nightly schedule (platform-native):** a single named **Temporal Schedule**
  (`auto-swe-eval-regression`) fires `ScheduledEvalWorkflow`, which resolves the configured benchmark
  dataset by slug, creates a fresh `EvalRun`, and runs the harness. Config (cron + enabled + dataset
  + candidate/baseline refs) lives on the `WorkflowDefaults` singleton (`resolveEvalScheduleConfig`),
  is synced to Temporal at gateway boot + on admin save (`syncEvalSchedule`), and is managed at
  `/admin/workflow` via `GET/PUT /api/v1/admin/config/eval-schedule` (+ `/trigger`). **Off by
  default** — needs a seeded dataset and a worker that can reach Docker + the model provider.
  **Nightly, not per-PR** (cost — RFC §4.3). The benchmark is a per-deployment, DB-configured
  capability rather than CI: it needs a running platform (gateway + worker + Docker + model
  provider), which a repo CI job doesn't have.
- **Acceptance:** the schedule syncs at boot and on save; a manual `/trigger` starts a run; a missing
  dataset is a no-op.

### WS6 — Tests
- Schema round-trip (WS1); SHA checkout integration (WS2); standalone gate + trajectory + flake
  screen (WS3); harness end-to-end on a 2-case fixture with fake implementer/gates, paired-stats
  units, stratified aggregation (WS4); route `app.inject()` + CLI dispatch (WS5).

---

## Exit criteria (RFC §6)

`auto-swe evals run` scores the frozen benchmark and emits a paired, error-barred
candidate-vs-baseline report (stratified by tag); a **nightly** CI job fails on a seeded regression;
online per-scorer drift is queryable. The gate rests entirely on owned, SHA-pinned fixtures —
**nothing replays moving production history**.

## Risk notes carried from RFC §9

- **Flaky floor:** WS3 flake-screens at curation and WS4 re-runs before zeroing; flaked cases report
  separately so the headline metric isn't infra noise.
- **Small-N power:** WS4 reports CIs and is honest that ~10–15pp is the realistic MDE at this N;
  clustered SEs shrink effective N when cases group by repo.
- **Coverage limit:** stratified-by-tag reporting (WS4) is mandatory; off-distribution regressions
  still need the P2 canary + a production backstop.
- **Trajectory unbaselined:** advisory-only in P1 (WS3); promoted to a gating axis only once per-repo
  baselines are tuned.
