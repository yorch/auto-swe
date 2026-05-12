# Configurable Workflows — Roadmap

Living planning doc for the configurable-workflows initiative. Each phase is sized to land in one PR. Pick up here when starting a follow-up PR.

---

## Vision

The runtime that drives every work request is a **JSON-defined, versioned, team-owned DAG**, not a hardcoded TypeScript workflow. Users can configure existing workflows and create new ones from the UI, mixing agent steps (implementer, reviewers, security review) with quality gates (lint, typecheck, test, build, vuln scan, perf bench), parallel subagent fan-out, and (in later phases) custom shell steps. Workflows are a first-class concept across the web dashboard, Slack, and the CLI.

---

## Architecture Decisions

| # | Decision |
|---|---|
| 1 | Large outputs (diffs, logs, artifacts) → S3 + Postgres; workflow context holds artifact IDs only |
| 2 | One Docker workspace per subagent |
| 3 | Feature-level decomposition; `planDecomposition` agent decides the split |
| 4 | Per-gate `onFail: block \| warn \| retry(N)` |
| 5 | Shell steps run in per-step ephemeral containers (no Docker socket mount, `--network=none` by default, workspace bind-mounted as the only writable path) — stricter than the agent-workspace threat model |
| 6 | Hard team-level $/run cap, configurable, default off |
| 7 | Spec evolution via auto-applied codemods on `schemaVersion` bump |
| 8 | Conditional `expr` language: jsonpath + comparison + arithmetic only — no JS sandbox, no function calls |
| 9 | Single PR per work request; subagents merge into the feature branch first |
| 10 | Workflows are first-class in UI, Slack, and CLI |
| 11 | Gate fix uses an explicit `executeGateFixImplementation` step; the spec wires the loop so it's visible in the DAG |
| 12 | Gate-runtime configs follow precedence: step config → `Repository.gateCommands` → built-in defaults |
| 13 | `runTests` always runs the full suite fresh (independent of implementer TDD); TDD may use a faster subset |
| 14 | Fan-out branches use a **sealed child context** (frozen parent copy + `[itemKey]:item`); only declared `exports` flow back to the parent at join |
| 15 | Phase-3 fan-out is **sequential**; parallel `Promise.all`-with-concurrency-limit is a follow-up |
| 16 | Phase-3 `mergeBranches` does **not** auto-resolve conflicts (records the conflict + fails the run); a `resolveMergeConflict` agent is reserved for phase 3.5 |
| 17 | `mergeBranches.sourceBranches` is an **explicit binding** — no heuristic discovery from `nodes.*.output`. Specs use `fanOut.pluck: '<path>'` to project a flat array and bind it via `inputs.sourceBranches`. |
| 18 | Phase-3.5 fan-out defaults to `concurrency=4` and tops out at the spec field's max (20). `onBranchFail: 'block'` stops scheduling but lets in-flight branches drain — we don't cancel mid-flight because activity cancellation isn't wired through the dispatcher yet. |
| 19 | `mergeBranches.unmergedBranches` is the canonical binding for chaining `merge → cond(passed) → resolveMergeConflict`. The resolver consumes the tail directly rather than re-deriving it from `conflicts[*]` (which the expr language can't project anyway). |
| 20 | The phase-3.5 conflict resolver reuses the existing implementer agent (one Mastra `Agent` instance per branch attempt) with a tight `MERGE_CONFLICT_RESOLVER_PROMPT`. Resolutions are verified via `git diff --check` + `git ls-files -u` before the commit lands. |
| 21 | The web URLs are split: `/workflows` keeps its existing meaning (in-flight `ActiveWorkflow` rows, relabeled "Active Runs"), `/templates` owns the workflow-template editor + version history, and `/runs/[id]` is the WorkflowRun viewer. Phase 4 doc originally proposed `/workflows` for templates, but renaming a live-traffic route was riskier than introducing two new ones. |
| 22 | Phase-4 editor ships a JSON-text spec editor + SVG DAG viewer (custom 150-line layered layout in `packages/web/src/lib/workflowLayout.ts`) instead of pulling in React Flow / dagre. Keeps the bundle small and avoids drag-and-drop scope creep; full canvas drag-edit can land in phase 5 if the JSON editor proves friction-y. |
| 23 | The step registry lives in `packages/shared/src/workflow/stepRegistry.ts` so gateway + web can import metadata without depending on the worker package. Worker-only activity wiring still lives in `packages/worker/src/workflows/runnable.ts`. |

---

## Phase Status

| Phase | Status | Slice |
|---|---|---|
| 1. Interpreter + parity refactor | **Done** | PR #13 |
| 2. Quality-gate steps | **Done** | lint / typecheck / test / build / vuln / perf + onFail policy + gate-fix loop |
| 3. Fan-out + decomposition + branch merging | **Done** | `fanOut` node + sealed child contexts, `planDecomposition` + `mergeBranches` activities, sequential execution; per-subagent workspace via `executeImplementation(request, subtask)` |
| 3.5 Parallel fan-out + conflict resolution | **Done** | concurrency-bounded worker pool inside `runFanOut`, `resolveMergeConflict` activity backed by the implementer agent, `mergeBranches.unmergedBranches` tail |
| 4. Web editor + run viewer | **Done** | `/templates` list, JSON spec editor + SVG DAG viewer, version sidebar + promote, `/templates/[id]/runs` paginated history, `/runs/[id]` live DAG viewer with per-node status overlay; gateway CRUD + step-registry catalog |
| 5. Versioning UI, A/B per team, analytics | Not started | version history page, per-team active version selector, $/run analytics |
| 6. Custom shell steps with RBAC + audit | Not started | team-admin-only step authoring, ephemeral container, audit log |
| 7. First-class in Slack + CLI | Not started | `/auto-swe workflow list` etc.; Slack picker on work-request create |

---

## Phase 1 — Interpreter + parity refactor (Done, PR #13)

### What shipped

- `packages/shared/src/workflow/` — spec schema, expression evaluator, pure interpreter, codemod harness, registry types, default spec
  - `spec.ts` — Zod-validated `WorkflowSpec` DAG (step / set / cond / signal / terminate)
  - `expr.ts` — safe evaluator: jsonpath, comparisons, arithmetic, boolean, nullish (no eval, no function calls)
  - `interpreter.ts` — pure DAG walker parameterized by a `Dispatcher` interface
  - `signalSlots.ts` — slot state machine the dispatcher uses to bridge Temporal `setHandler` and the interpreter's signal waits
  - `codemod.ts` — registration + chain walker for `schemaVersion` migrations
  - `defaultEngineeringSpec.ts` — seeded `default-engineering@v1` template, behaviorally equivalent to the old `EngineeringWorkflow`
- `packages/worker/src/workflows/runnable.ts` — Temporal-backed `RunnableWorkflow` driving the shared interpreter
- `packages/worker/src/lib/stepRegistry.ts` — step catalog for the editor UI
- `packages/worker/src/lib/artifactStore.ts` — S3-compatible (lazy SDK) + Postgres fallback
- `packages/worker/src/activities/templates.ts` — `createWorkflowRun`, `recordWorkflowStep`, `finalizeWorkflowRun`, `resolveTemplateForRepo`
- Prisma: `workflow_templates`, `workflow_template_versions`, `workflow_runs`, `workflow_steps`, `workflow_artifacts` plus `work_requests.template_id` / `template_version`
- `EngineeringWorkflow` deleted; `EpicOrchestratorWorkflow` now starts `RunnableWorkflow` children
- Gateway always resolves a default template before starting work; returns `500 NO_DEFAULT_TEMPLATE` if none seeded

### Tests (146 total)

- `expr.test.ts` — path lookups, arithmetic, comparisons, boolean precedence, nullish, parens, rejection cases
- `spec.test.ts` — minimal valid spec, entry validation, dangling-edge detection, all 5 node types
- `interpreter.test.ts` — 8 primitive tests + 6 parity tests against `DEFAULT_ENGINEERING_SPEC` (happy path, review/CI retry exhaustion, signal timeouts, non-blocking failures)
- `signalSlots.test.ts` — falsy payloads, undefined-to-null, slot isolation, clear-then-wait-then-take contract, at-least-once tolerance
- `codemod.test.ts` — registration guards, single + chained migrations, invalid output rejection

### Known follow-ups before/around Phase 2

Coverage gaps that didn't block phase 1 but should land soon:
- `stepRegistry.ts` — at minimum `assertBuiltinStepsRegistered` (the worker-startup invariant)
- `artifactStore.ts` — Postgres backend round-trip with mocked Prisma; S3 backend's lazy-load error when SDK absent
- `activities/templates.ts` — `createWorkflowRun` idempotency on retry (the upsert-by-workflowId), error paths
- Gateway `resolveDefaultTemplate` — team-default present / absent / both absent

Smoke test (manual, one-time): start a real Temporal worker + gateway + Postgres, fire one work request, verify it walks the seeded `default-engineering@v1` template end-to-end and that `workflow_runs` + `workflow_steps` populate.

---

## Phase 2 — Quality-gate steps (Done)

### What shipped

- `packages/shared/src/workflow/spec.ts` — `StepNodeSchema.onFail: 'block' | 'warn' | { retry: N }`. Default behavior is `block`. `SPEC_SCHEMA_VERSION` bumped to 2.
- `packages/shared/src/workflow/codemods.ts` — registers built-in v1 → v2 codemod (bumps version; v1 specs upgrade silently since `onFail` is optional).
- `packages/shared/src/workflow/interpreter.ts` — honors `onFail`:
  - `block`: throws on failure (or `passed === false`) and aborts the run.
  - `warn`: records FAILED + writes the output/error to `nodes.<id>` then continues via `next`.
  - `{ retry: N }`: re-runs up to N additional times (recording each attempt); falls back to `block` semantics if every attempt fails.
- `packages/worker/src/activities/qualityGates.ts` — six gate activities (`runLint`, `runTypecheck`, `runTests`, `runBuild`, `runVulnScan`, `runPerfBench`) + `executeGateFixImplementation`. Each gate captures stdout/stderr/exit code via `Workspace.execCapture` (new), stores full logs as a `WorkflowArtifact`, returns `{passed, summary, artifactId?, exitCode}`. Command resolution: step config → `Repository.gateCommands` → built-in default.
- `packages/worker/src/activities/workspace.ts` — `execCapture` helper (non-throwing, returns `{exitCode, stdout, stderr, signal?}`).
- `packages/shared/prisma/schema.prisma` — `Repository.gateCommands JSON?` for per-repo command overrides (squashed into the init migration).
- `packages/worker/src/lib/stepRegistry.ts` — six gate entries (category `gate`) plus `executeGateFixImplementation`; gates expose `command` + `timeoutMs` config fields.
- `packages/worker/src/workflows/runnable.ts` — dispatcher cases for all seven new steps with a dedicated `gateActivities` proxy (15m STC, low Temporal-level retry — workflow-level retry comes from `onFail`).
- `packages/shared/src/workflow/examples/qualityGates.spec.ts` — example DAG: implement → lint → typecheck → tests → build (each `onFail: { retry: 1 }`) → vulnScan (`onFail: 'warn'`) → done. Failed gates fan into `executeGateFixImplementation` with a 3-iteration budget.

### Tests (203 total)

Phase 2 additions:
- `spec.test.ts` — 5 new tests for `onFail` shape validation (block / warn / retry / bad retry / bad literal).
- `interpreter.test.ts` — 6 new tests for `onFail` semantics (block aborts on `passed:false` or thrown; warn continues; retry retries N then blocks; retry stops on recovery; `passed:true` skips policy).
- `codemods.test.ts` — built-in v1 → v2 chain registration, idempotent field preservation, no mutation of input.
- `examples/qualityGates.spec.test.ts` — example spec parses + every gate node uses a known gate step + blocking gates carry `onFail`.
- `stepRegistry.test.ts` (worker) — `assertBuiltinStepsRegistered` invariant + every gate has `command` + `timeoutMs` fields.
- `artifactStore.test.ts` (worker) — postgres backend round-trip; lazy-load error when `ARTIFACT_S3_BUCKET` set without the SDK.
- `templates.test.ts` (worker) — `createWorkflowRun` migration of stored v1 spec, upsert-by-workflowId, error paths; `recordWorkflowStep` attempt-aware; `resolveTemplateForRepo` precedence + missing-template throw.
- `qualityGates.test.ts` (worker) — `resolveCommand` precedence (step → repo → default → null for runPerfBench); empty step override falls through; `truncate` helper.
- `workRequests.test.ts` (gateway) — `resolveDefaultTemplate` team default wins, global fallback, missing template returns null, missing activeVersion returns null.

### Adds

Six new workspace-shell-backed step activities, each returning `{ passed: boolean, summary: string, artifactId?: string }`:

| Step | Activity | Default config |
|---|---|---|
| `runLint` | shell: `yarn lint` (configurable) | `onFail: block` |
| `runTypecheck` | shell: `yarn typecheck` | `onFail: block` |
| `runTests` | shell: `yarn test` (configurable) | `onFail: block` |
| `runBuild` | shell: `yarn build` | `onFail: block` |
| `runVulnScan` | shell: configurable (default `yarn audit --level high`) | `onFail: warn` |
| `runPerfBench` | shell: configurable (no default) | `onFail: warn` |

All execute inside the **existing** long-lived workspace container (not the per-step ephemeral container — that's reserved for user-authored shell steps in phase 6). Output captured, truncated to 4KB metadata, full body stored as a `WorkflowArtifact`.

### Spec changes

Per-gate `onFail` mode lives on the step node:

```ts
{ type: 'step', step: 'runTests', onFail: 'block' | 'warn' | { retry: 2 } }
```

`onFail: warn` means "record the failure but proceed via `next`". `onFail: { retry: N }` re-runs the step up to N times before honoring its terminal mode (block). Extend `StepNodeSchema` to support this.

### Files to touch

- `packages/worker/src/activities/qualityGates.ts` (new) — six activity implementations
- `packages/worker/src/activities/index.ts` — re-export
- `packages/worker/src/lib/stepRegistry.ts` — register the six steps with config fields (command override, threshold, etc.)
- `packages/worker/src/workflows/runnable.ts` — add dispatch cases
- `packages/shared/src/workflow/spec.ts` — extend `StepNodeSchema` with `onFail` modes; bump `SPEC_SCHEMA_VERSION` to 2 and register a 1→2 codemod that defaults existing nodes to `onFail: 'block'`
- `packages/shared/src/workflow/defaultEngineeringSpec.ts` — leave at v1; the seed spec doesn't need gates yet
- New `examples/qualityGates.spec.ts` — sample spec consumers can copy that injects gates between implement and PR

### Open questions

1. **Should `runTests` reuse the implementer's TDD test runs**, or always run fresh? (Probably fresh — TDD might use a faster subset.)
2. **Gate-failure feedback to the implementer.** When a gate fails with `onFail: block`, should we automatically run `executeReviewFixImplementation` with the gate output? Adding a `runFixForFailedGate` step keeps the loop explicit in the spec.
3. **Where do gate-runtime configs live?** Repo-level (`Repository.gateCommands JSONB`)? Per-template (in the spec)? Phase-2 default: per-template config fields; phase-5 may add repo-level overrides.

---

## Phase 3 — Fan-out + decomposition + branch merging (Done)

### What shipped

- `packages/shared/src/workflow/spec.ts` — `fanOut` node type:
  - `{ type: 'fanOut', over: Binding, subgraph: NodeId, join: NodeId, itemKey?: string, exports?: string[], pluck?: string, onBranchFail?: 'block'|'continue', concurrency?: number }`
  - `concurrency` is parsed but **not yet enforced** (phase 3.5 wires the parallel implementation). `SPEC_SCHEMA_VERSION` bumped to 3.
- `packages/shared/src/workflow/codemods.ts` — v2 → v3 codemod (bump-only; v2 specs without `fanOut` upgrade silently).
- `packages/shared/src/workflow/interpreter.ts` — `runFanOut`:
  - Resolves `over`, requires an array (throws otherwise).
  - Per branch builds a **sealed child context**: fresh `nodes:{}` + cloned `context:{}` + `[itemKey]: item` + `[itemKey + 'Index']: i`. Branch writes never reach the parent.
  - Runs a nested `walk` on the same spec from `node.subgraph`. Branch `terminate` ends the branch (not the run), and the result is captured.
  - Aggregates into `nodes.<fanOutId>.output = { count, succeeded, failed, results: [{ status, result, exports? }], plucked? }` and continues at `join`.
  - `pluck: '<dotPath>'` projects one path (relative to each result entry — e.g. `result.branch`) into a flat `output.plucked: unknown[]`, so downstream nodes can bind a flat array directly (`{ from: 'nodes.fan.output.plucked' }`) without a shaping step.
  - `onBranchFail: 'block'` (default) propagates the first failure — both thrown errors **and** branches that reach `terminate { status: !== 'SUCCESS' }`; `'continue'` keeps going and surfaces failures via the aggregate.
  - Branch step records carry a `<fanOutId>[i]/` prefix on `nodeId` so workflow_steps shows per-branch attempts distinctly.
- `packages/worker/src/agents/decomposer.ts` — Mastra agent + Zod-validated structured output. Caps at 8 subtasks; subtask ids must match `^[a-z][a-z0-9-]{0,39}$`. Falls back to a singleton plan when the LLM returns nothing structured.
- `packages/worker/src/agents/prompts.ts` — `DECOMPOSER_AGENT_PROMPT` (splits along feature surface, not technical layers).
- `packages/worker/src/activities/decomposition.ts` — `planDecomposition`, `mergeBranches` (real `git fetch + git merge --no-ff` in a fresh workspace; **batched fetch** for target + every source in one round-trip with per-ref fallback; aborts on conflict; pushes only on full success). Exports `subtaskBranchName(featureBranch, subtask)` helper.
- `packages/worker/src/activities/executeImplementation.ts` — accepts optional `subtask?: Subtask`; switches to `auto/<ticket>/<subtask.id>` and injects subtask description + title + file scope into the implementer prompt.
- `packages/worker/src/lib/stepRegistry.ts` — `planDecomposition` (agent, costHint) + `mergeBranches` (vcs, `mergeMessagePrefix` config field). Both added to `BUILTIN_STEPS`.
- `packages/worker/src/workflows/runnable.ts` — dispatcher cases for the two new steps; `executeImplementation` resolves `inputs.subtask ?? lookupPath(ctx, 'subtask')`. New `mergeActivities` proxy (15m STC). `mergeBranches` requires an explicit `inputs.sourceBranches: string[]` binding — the example spec wires `fanOut.pluck: 'result.branch'` and binds `sourceBranches` to `nodes.fan.output.plucked`.
- `packages/worker/src/lib/activityContext.ts` — `currentWorkflowRunId()` lookup hoisted here so artifact-producing activities don't redefine it.
- `packages/worker/src/lib/errors.ts` — `getExecErrorOutput(err, maxBytes)` companion to `getExecErrorStdout` (also concatenates stderr + falls back to message). Used by `mergeBranches` for conflict reporting.
- `packages/shared/src/types/workflow.ts` — `Subtask` + `DecompositionResult`.
- `packages/shared/src/workflow/examples/decomposition.spec.ts` — example DAG: `plan → fanOut(per-subtask implementer, pluck: 'result.branch') → merge → review → done`.

### Tests (226 total)

Phase 3 additions:
- `spec.test.ts` — 4 new tests covering minimal fanOut spec, dangling-edge detection on `subgraph`/`join`, required-field rejection, `exports` cardinality cap.
- `interpreter.test.ts` — 9 new tests: basic aggregation, sealed child context isolation, branch step inputs bound to `itemKey`, `onBranchFail: block` abort on thrown error, `onBranchFail: block` abort on `terminate FAILED`, `onBranchFail: continue` failure tally, non-array `over` rejection, empty-array short-circuit, `pluck` projection into `output.plucked`.
- `codemods.test.ts` — chained v1 → v2 → v3 migration + fanOut-node preservation across v2 → v3.
- `examples/decomposition.spec.test.ts` — example spec parses, uses the expected step names, and binds `mergeBranches.sourceBranches` to the fanOut's `output.plucked`.
- `stepRegistry.test.ts` — `planDecomposition` (agent) + `mergeBranches` (vcs) categorized correctly; covered by the existing `assertBuiltinStepsRegistered` invariant.
- `activities/decomposition.test.ts` (worker) — `subtaskBranchName` helper; `mergeBranches` short-circuits on empty `sourceBranches`, merges + pushes on happy path, aborts + skips later sources on conflict.

### Spec sketch

```
planDecomposition
  └─ set context.featureBranch
  └─ fanOut(over: nodes.plan.output.subtasks, itemKey: 'subtask', pluck: 'result.branch')
      └─ executeImplementation  (uses subtask → branches to auto/<ticket>/<id>)
      └─ set context.currentCodeResult
      └─ terminate SUCCESS with result { branch }  (branch boundary)
  └─ merge (mergeBranches, inputs.sourceBranches = nodes.fan.output.plucked,
                          inputs.targetBranch  = context.featureBranch)
  └─ review → terminate
```

### Known follow-ups (phase 3.5)

- **Parallel execution.** `runFanOut` currently runs branches sequentially. The follow-up swaps to `Promise.all` with a concurrency limiter; Temporal-history budgeting may require chunked artifact persistence inside subgraphs.
- **Conflict resolution agent.** A `resolveMergeConflict` step that runs the implementer against the conflict markers before reporting failure.
- **Per-branch quality gates.** The example spec only runs the implementer per subtask; teams will want lint/typecheck per branch before merge.

### Files touched (recap)

- `packages/shared/src/workflow/spec.ts`, `interpreter.ts`, `codemods.ts`, `index.ts`, `registry-types.ts`, `examples/decomposition.spec.ts` (+ tests)
- `packages/shared/src/types/workflow.ts`
- `packages/worker/src/agents/decomposer.ts`, `agents/prompts.ts`
- `packages/worker/src/activities/decomposition.ts`, `activities/executeImplementation.ts`, `activities/index.ts` (+ tests)
- `packages/worker/src/lib/stepRegistry.ts` (+ tests)
- `packages/worker/src/workflows/runnable.ts`

---

## Phase 3.5 — Parallel fan-out + conflict resolution (Done)

### What shipped

- `packages/shared/src/workflow/interpreter.ts` — `runFanOut` now runs branches through a `concurrency`-bounded worker pool (`Promise.all` over N workers sharing a `nextIndex` counter). Default cap is `DEFAULT_FANOUT_CONCURRENCY = 4`; specs can raise it via `fanOut.concurrency` (max 20 per the schema). Branches still walk a sealed child context — only `exports` flow back to the parent.
  - `onBranchFail: 'block'` flips a `stop` flag so no further branches are scheduled; in-flight branches drain to completion. Activity cancellation would need to be plumbed through the dispatcher first, so the trade-off is that a block-mode failure may still pay for one full batch of LLM calls. The aggregate now carries `skipped: number` so spec authors can tell apart "ran-and-failed" from "never-launched."
  - Result aggregate preserves item-index order regardless of completion order (slots pre-allocated by index, holes filtered at the end). `pluck` still works because it operates on completed entries in their stored order.
- `packages/worker/src/agents/prompts.ts` — `MERGE_CONFLICT_RESOLVER_PROMPT` (tight, surgical, marker-removing only).
- `packages/worker/src/activities/decomposition.ts` — `resolveMergeConflict` activity:
  - Mirrors `mergeBranches`' workspace lifecycle (batched fetch, hard reset to target, per-source merge with abort-on-failure).
  - When a `git merge` fails with conflict markers, lists the conflicted files via `git diff --name-only --diff-filter=U`, reads each file's content (truncated to 8KB per file), and invokes the implementer agent with the resolver prompt.
  - After the agent returns, re-checks `git diff --diff-filter=U` (unmerged stages) + `git diff --check` (working-tree markers); if both are clean, stages + commits with the configured prefix. Otherwise retries up to `maxAttemptsPerBranch` (default 1) before aborting and surfacing the unmerged tail.
  - Returns a `MergeBranchesResult`-shaped payload so spec authors can chain `merge → cond(passed) → resolveMergeConflict → cond(passed) → review` without shaping nodes.
- `mergeBranches` now also returns `unmergedBranches: string[]` — the conflicted source + every queued source after it — so the resolver step can bind directly via `inputs.sourceBranches: { from: 'nodes.merge.output.unmergedBranches' }`.
- `packages/worker/src/lib/stepRegistry.ts` — `resolveMergeConflict` (category `agent`, `costHint` on implementer role, config fields `mergeMessagePrefix` + `maxAttemptsPerBranch`). Added to `BUILTIN_STEPS`.
- `packages/worker/src/workflows/runnable.ts` — new `conflictActivities` proxy (30m STC, 5m heartbeat; matches the agent-bound timeouts) and a dispatch case that pulls `targetBranch` / `sourceBranches` / `maxAttemptsPerBranch` from inputs+config.
- `packages/shared/src/workflow/examples/decomposition.spec.ts` — updated to demonstrate `concurrency: 3` on the fan-out and `merge → cond(passed) → resolveConflict → cond(passed) → review | terminateMergeFailed`. The `merge` and `resolveConflict` steps both use `onFail: 'warn'` so their outputs land in `nodes.<id>.output` for the downstream cond to read.

### Tests (237 total)

Phase 3.5 additions:
- `interpreter.test.ts` — 4 new tests: concurrency cap enforced (≤2 in-flight w/ deferred-resolution stubs), aggregate order preserved when branches finish out of order, `skipped` field reports zero in `continue` mode, default cap honored when `concurrency` is unset.
- `examples/decomposition.spec.test.ts` — 2 new tests: fan-out declares a concurrency cap; the conflict resolver is wired after `merge` and binds `unmergedBranches`.
- `activities/decomposition.test.ts` — 3 new tests for `resolveMergeConflict`: empty-sources short-circuit, clean-merge path skips the agent, unresolvable conflict surfaces `conflicts` + `unmergedBranches` tail and skips the push. Also extended the existing `mergeBranches` conflict test to assert the new `unmergedBranches` field.
- `stepRegistry.test.ts` — `resolveMergeConflict` registered as an `agent` step with both config fields.

### Known follow-ups

- **Activity cancellation.** Block-mode wastes the tail end of in-flight branches because the dispatcher doesn't expose Temporal cancellation scopes. Wiring `CancellationScope.cancel()` into the dispatcher's `dispatchStep` would let block-mode actually abort in-flight LLM calls, but it'd also surface as a new failure category callers need to handle.
- **Per-branch quality gates.** The example spec still only runs the implementer per subtask before merging. Teams will want lint/typecheck/tests per branch before any merge — that's a spec-level change, not a runtime one, but worth a follow-up example.
- **Resolver memory.** A successful conflict resolution is exactly the kind of outcome `commitToMemory` should capture (`failureType: 'MERGE_CONFLICT'` already exists in `MEMORY_SUMMARIZER_PROMPT`), but the wiring from the resolver activity into the memory pipeline is not yet there.

---

## Phase 4 — Web editor + run viewer (Done)

### What shipped

- **Step registry relocated.** `packages/shared/src/workflow/stepRegistry.ts` (moved from `packages/worker/src/lib/`) — gateway can validate templates and web can render the palette without depending on the worker package. Re-exported via `@auto-swe/shared/workflow`; package.json/exports + vitest.config alias updated. The startup invariant `assertBuiltinStepsRegistered` moves with it.
- **Gateway routes.** Three new route files mounted at `/api/v1/workflow-templates`, `/api/v1/workflow-runs`, `/api/v1/workflow-steps`:
  - `workflowTemplates.ts` — list, create (POST with spec — parses against `WorkflowSpecSchema` + checks `schemaVersion`), get detail (with versions sidebar + active spec inlined), patch metadata (name / description / isDefault / status; toggling `isDefault` clears the flag on the other templates in that team scope), get/create version, promote-to-active, paginated runs. Team-scoped: non-admins see global + their teams' templates only; non-admins cannot create global templates.
  - `workflowRuns.ts` — list runs (filterable by status / templateId / workRequestId) and get-with-steps. Visibility expands to repos on the user's team so engineers can see runs for work requests they don't own.
  - `stepRegistryRoutes` — `GET /api/v1/workflow-steps/registry` returns the full step catalog for the editor palette.
- **Schema.** Bidirectional `Team ↔ WorkflowTemplate` relation added (was a dangling scalar). Foreign key added to the squashed init migration (`workflow_templates_team_id_fkey` with `ON DELETE SET NULL`). No new migration file — per the repo convention, this lands in the existing init migration.
- **Web pages** (all under `packages/web/src/app/`):
  - `templates/page.tsx` — team-filtered template list with last-run summary chip per row.
  - `templates/[id]/page.tsx` — version sidebar + SVG DAG viz + JSON spec editor (textarea-based; parses on every keystroke and POSTs `{spec}` as a new version on Save) + step palette (read-only metadata catalog) + per-node config-field summary in the inspector. `Promote to active` button when viewing a non-active version. Default-template toggle.
  - `templates/[id]/runs/page.tsx` — paginated run history with duration + work-request preview.
  - `runs/[id]/page.tsx` — live DAG viewer. TanStack Query polls every 3s while the run is `RUNNING`, 30s otherwise. Per-node status overlay (left edge strip + status text) computed by collapsing fan-out branch prefixes (`fanId[i]/subNode`) onto the parent DAG nodes. Click-to-inspect surfaces every attempt + outputs + error per node.
- **DAG layout.** `packages/web/src/lib/workflowLayout.ts` — pure layered layout (longest-path BFS rank assignment + index-within-rank). Tolerates back-edges (cond loops, fan-out join) without infinite recursion. Outputs `(x, y, rank)` per node plus a typed edge list with kind metadata for stroke colour. No new bundled dependency (no React Flow / dagre / elkjs).
- **DAG renderer.** `packages/web/src/components/workflow/WorkflowDag.tsx` — single SVG component used by both the template editor and the run viewer. Cubic-bezier edges with kind-coloured strokes (onTrue green / onFalse red / onTimeout amber / subgraph purple / join teal / next slate). Accessible: each node is a focusable button with `role` / `tabIndex` / `onKeyDown` for Enter+Space activation.
- **Hooks.** New TanStack Query hooks in `useWorkflows.ts`: `useWorkflowTemplates`, `useWorkflowTemplate`, `useWorkflowTemplateVersion`, `useTemplateRuns`, `useWorkflowRun` (status-aware refetch interval), `useStepRegistry` (5min stale), `useCreateWorkflowVersion`, `usePromoteWorkflowVersion`, `useUpdateWorkflowTemplate`.
- **Shared API types.** `packages/shared/src/types/api.ts` — `WorkflowTemplateSummary` / `WorkflowTemplateDetail` / `WorkflowTemplateVersionSummary` / `WorkflowTemplateVersionDetail` / `WorkflowRunSummary` / `WorkflowRunDetail` / `WorkflowStepRecord` / `StepRegistryEntry` + body types for the create/patch/promote endpoints.
- **Sidebar nav.** Existing `/workflows` link is now labelled "Active Runs" (still points at `ActiveWorkflow` rows); new "Templates" link points at `/templates`.

### Tests (260 total, +8 from phase 3.5)

Phase 4 additions:

- `workflowLayout.test.ts` (web) — empty-spec short-circuit, entry-at-rank-0, longest-path BFS rank ordering, cond/signal/fanOut edge-kind collection, cycle tolerance, dangling-edge omission, layout width formula.
- `workflowTemplates.test.ts` (gateway) — rejects invalid spec (wrong `schemaVersion`); creates a template + initial version + auto-promotes to active; list returns last-run summary; new-version POST increments monotonically; new-version POST rejects invalid spec; promote-to-active flips `activeVersion`; 404 on unknown template ID.
- `stepRegistry.test.ts` moved to shared (same 7 cases, now in `packages/shared/src/workflow/`).

### URL routing decision

The phase-4 plan originally put templates at `/workflows`, but `/workflows` already serves the in-flight `ActiveWorkflow` table. Renaming a live route was riskier than splitting the namespace, so the final layout is:

| Path | Purpose |
|---|---|
| `/workflows` | In-flight ActiveWorkflow rows (relabelled "Active Runs" in the nav) |
| `/templates` | Workflow template list |
| `/templates/[id]` | Template detail: version sidebar, JSON editor, DAG viz, step palette |
| `/templates/[id]/runs` | Template's paginated run history |
| `/runs/[id]` | WorkflowRun detail with DAG + per-node live status |

### Known follow-ups

- **Canvas drag-edit.** The current editor is a JSON textarea + read-only DAG viz. A proper drag-and-drop node editor (React Flow or equivalent) is the natural phase 5 follow-up — JSON works but is friction-y for non-spec-literate users.
- **Form-driven node config.** Per-node config fields are surfaced read-only in the inspector. Phase 5 should let users edit `node.config.<field>` through hand-rolled per-field forms (~6 widget types from `StepFieldDef.type`).
- **Cost estimation.** `stepRegistry.costHint` exists but the editor doesn't surface a `$/run` estimate yet. Phase 5 analytics page should aggregate recent-run averages and project per-spec estimates.
- **Version diff.** Selecting a non-active version shows the spec but not a diff vs. active. A side-by-side textual diff (or DAG-level node/edge diff highlighting) would close the loop.
- **A11y.** SVG nodes are focusable buttons, but the DAG itself has no keyboard navigation between nodes. Worth wiring an arrow-key traversal in phase 5 once the editor grows.

### Files touched (recap)

- `packages/shared/src/workflow/{stepRegistry.ts,stepRegistry.test.ts,index.ts}` (move from worker), `packages/shared/package.json` (exports), `vitest.config.ts` (alias), `packages/worker/src/lib/{stepRegistry.ts,stepRegistry.test.ts}` (delete)
- `packages/shared/src/prisma/schema.prisma` + init migration (Team↔WorkflowTemplate fkey)
- `packages/shared/src/types/api.ts` (new types)
- `packages/gateway/src/routes/{workflowTemplates.ts,workflowTemplates.test.ts,workflowRuns.ts}` (new), `packages/gateway/src/index.ts` (mounts)
- `packages/web/src/lib/{workflowLayout.ts,workflowLayout.test.ts}`, `packages/web/src/components/workflow/WorkflowDag.tsx`, `packages/web/src/app/templates/**`, `packages/web/src/app/runs/[id]/page.tsx`, `packages/web/src/hooks/useWorkflows.ts`, `packages/web/src/components/layout/Sidebar.tsx`

---

## Phase 5 — Versioning UI, A/B per team, analytics

### Adds

- Version history sidebar on `/workflows/[id]/edit` showing all `WorkflowTemplateVersion` rows
- "Promote to active" button (atomically updates `WorkflowTemplate.activeVersion`)
- Per-team default selector (currently set by `isDefault` boolean; expose in UI)
- Analytics page: success rate, p50/p95 wallclock, $/run, per-step failure rates — query `workflow_runs` + `workflow_steps`
- A/B framework: `WorkflowTemplate.experimentSplit` (percent) → on work-request creation, deterministically choose between active version and experiment version

### Files to touch

- Gateway routes for version management
- Web pages for history + analytics
- Probably one Prisma migration for `experimentSplit` + `experimentVersion` columns

---

## Phase 6 — Custom shell steps (RBAC + audit)

### Adds

- `shell` node type already in the schema; phase 6 wires the runtime
- Per-step ephemeral container (not the long-lived workspace):
  - `docker run --rm --network=none --memory <cap> --cpus <cap> --pids-limit 256 --read-only --tmpfs /tmp <image> <command>`
  - Workspace bind-mounted at `/workspace` as the only writable path
  - No Docker socket mount
- New permission: `workflow:write:shell` (team admin only)
- New table: `WorkflowShellAudit { templateVersionId, nodeId, command, authorUserId, createdAt }` — every shell-step authoring event logged
- Editor UI shows a danger-zone warning + diff preview when saving a version with shell steps

### Files to touch

- `packages/worker/src/activities/shellStep.ts` (new)
- `packages/worker/src/lib/ephemeralContainer.ts` (new) — wraps `docker run` with the strict flags
- `packages/gateway/src/routes/workflows.ts` — RBAC check on `shell`-containing specs
- Prisma migration for audit table

### Open questions

1. **Network access opt-in.** Some shell steps will need outbound (e.g., upload an SBOM somewhere). Add a per-step `network: 'none' | 'egress'` config field; default `'none'`.
2. **Image allowlist.** Allow any image (admin-trusted) vs. an allowlist (`packages/worker/src/lib/shellImageAllowlist.ts`)? Phase-6 default: allowlist with `node:24-alpine`, `python:3.13-alpine`, `alpine:latest`, plus admin-editable additions per team.

---

## Phase 7 — First-class in Slack + CLI

### Adds

**Slack**:
- New slash command: `/auto-swe workflows list`
- When creating a work request via Slack, show a workflow picker (team's templates) before submission
- Optional Slack mentions on per-step failures: `[implement-feature-x]: runTests failed in step 12/18`

**CLI**:
- `auto-swe workflows list`
- `auto-swe workflows show <name>` — dumps the spec
- `auto-swe workflows export <name> > my-workflow.json`
- `auto-swe workflows import my-workflow.json` — validates against `WorkflowSpecSchema`, creates a new version

### Files to touch

- `packages/gateway/src/routes/slack.ts` — extend `app_mention` + slash command handlers
- New `packages/cli/` workspace (does not exist yet — phase 7 also bootstraps it). Or fold into an existing tooling location.

---

## Resume Checklist

When picking up a new phase:

1. **Read the open questions for that phase** above. Confirm answers with the requester before writing code.
2. **Branch from main.** All work goes through PRs.
3. **Update this doc as you go.** Move "Open questions" answers into the "Decisions" table when locked. Move phase status from "Not started" to "In progress" to "Done", with the PR number.
4. **Schema changes.** Until production exists, prefer squashing migrations into `20260510000000_init` rather than chaining new ones (per the convention this repo follows for non-pgvector DDL).
5. **Tests.** Match phase 1's coverage style: pure logic gets dedicated unit tests; Temporal-backed wiring gets a thin abstraction (like `SignalSlots`) so it's testable without `TestWorkflowEnvironment`.
6. **Lint + typecheck.** `yarn lint:fix && yarn typecheck && yarn test` — all must be clean.

### Current entry points (as of this PR)

- Interpreter: `packages/shared/src/workflow/interpreter.ts` → `runSpec(spec, ctx, dispatcher)`
- Workflow runtime: `packages/worker/src/workflows/runnable.ts` → `RunnableWorkflow`
- Step catalog: `packages/worker/src/lib/stepRegistry.ts`
- Spec schema: `packages/shared/src/workflow/spec.ts`
- Default seeded spec: `packages/shared/src/workflow/defaultEngineeringSpec.ts`
- Artifact store: `packages/worker/src/lib/artifactStore.ts`
