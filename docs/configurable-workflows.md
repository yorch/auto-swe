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
| 22 | Phase-4 editor shipped a JSON-text spec editor + SVG DAG viewer with a custom layered layout (`workflowLayout.ts`). This was subsequently superseded: `@xyflow/react` (React Flow) and `dagre` were added to the web package, `workflowLayout.ts` was reimplemented on top of dagre, and a full canvas drag-edit editor (`TemplateEditor`) replaced the JSON-textarea-only surface. The read-only React Flow renderer (`WorkflowDag`) is retained for the read-only run viewer and diff pages. |
| 23 | The step registry lives in `packages/shared/src/workflow/stepRegistry.ts` so gateway + web can import metadata without depending on the worker package. Worker-only activity wiring still lives in `packages/worker/src/workflows/runnable.ts`. |
| 24 | A/B experiment routing is deterministic per `externalTicketId`, salted by `templateId` (sha1 mod 100). Re-runs of the same ticket always land on the same arm, and two templates' experiments are uncorrelated. We hash in the gateway resolver rather than at workflow-start so the Temporal layer never sees the bucket — only the resolved version. |
| 25 | Per-template `experimentVersion` + `experimentSplit` live on `WorkflowTemplate` rather than a separate `WorkflowExperiment` table. There can only be one experiment per template (no multi-arm right now), and the columns are nullable so disabled state is unambiguous. Validation (split > 0 requires version; version must exist on this template) lives in the gateway PATCH route — a CHECK constraint can't express the cross-row dependency cheaply. |
| 26 | Analytics cost rollup joins `workflow_runs → workRequest → activeWorkflow.costUsdAccrued` and **sums** across activeWorkflows per WorkRequest. This is correct for both single-workflow runs and epic decompositions (which create multiple activeWorkflows under one WorkRequest). We deliberately don't denormalize cost onto `workflow_runs` — the join is cheap on a 30d window and avoids a write-side audit problem if the LLM-call cost path ever changes shape. |
| 27 | Phase-6 shell steps run in a **fresh ephemeral container per step** (not the long-lived agent workspace) with `--rm --read-only --tmpfs /tmp:size=64m --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --memory=512m --cpus=1`. Workspace is exposed via a **Docker named volume** (not a host bind-mount) so the path works under DinD; the activity prepares the volume by cloning the work-request branch inside a throwaway `alpine/git` container, then runs the user command, then commits + pushes any working-tree changes in a second throwaway container before deleting the volume. |
| 28 | Phase-6 image policy: built-in allowlist of `node:24-alpine`, `python:3.13-alpine`, `alpine:latest` is always permitted. Per-team additions live on `Team.shellImageAllowlist` (managed by team admins via `PUT /api/v1/teams/:id/shell-image-allowlist`). Matching is **exact string** on `image:tag` — no prefix matching, so a typo in the allowlist can't accidentally grant a similar image. The check runs at template-save time AND at workflow-runtime (defense in depth: a stored spec that pre-dates a tightened allowlist gets rejected before the container launches). |
| 29 | Phase-6 RBAC: authoring a spec with any shell node requires **team-role ADMIN** in the template's owning team (platform ADMIN bypasses, as elsewhere). Global templates (`teamId === null`) require platform ADMIN — there's no team to grant elevated authoring against. The gateway returns `SHELL_AUTHOR_FORBIDDEN` on rejection. Every saved shell node writes one `WorkflowShellAudit` row capturing `(templateVersionId, nodeId, image, command, network, authorUserId)`. |
| 30 | Per-step network mode is `none` (default) or `egress`. `none` strips the network namespace entirely. `egress` uses `bridge` mode with DNS-based destination filtering: the container's DNS is pointed at a loopback address (`--dns=127.0.0.2`) that resolves nothing by default, and each hostname in `Team.egressAllowlist` is injected as a `--add-host=hostname:IP` entry (resolved at container-launch time). Wildcard entries in the allowlist are informational only — DNS filtering applies to exact hostname lookups. IP-direct connections bypass DNS filtering entirely; blocking those would require host iptables (out of scope). There is no opt-in to inbound traffic at any level. |
| 31 | Phase-7 per-step Slack failure notifications use a two-tier channel resolver: the originating Slack channel on `WorkRequest.slackChannelId` (set when the run was kicked off via `/auto-swe run`) wins so failures thread back to the source conversation, with `Team.slackNotifyChannel` as a fallback for runs created via the REST API or webhook. We notify only on the **first** FAILED record per `(runId, nodeId)` to avoid spamming the channel during `onFail.retry` storms. |
| 32 | Phase-7 CLI lives in a new `packages/cli/` workspace (binary name `auto-swe`). It auth's against the existing `/api/v1/auth/login` endpoint via `AUTO_SWE_USERNAME` + `AUTO_SWE_PASSWORD`, falling back to a raw `AUTO_SWE_TOKEN` bearer for CI; no token caching on disk. Subcommand layout mirrors the gateway routes (`workflows list/show/export/import`) so the CLI is a thin transport adapter rather than a parallel codepath. |
| 33 | Phase-7 Slack `/auto-swe` slash command authentication: requests are gated by HMAC signature (`SLACK_SIGNING_SECRET`) plus a User.slackId linkage check. Unknown Slack users get an ephemeral hint to visit `/api/v1/auth/slack/connect`, never a 403 — the slash command is meant to be discovery-friendly. The `run` subcommand opens a Block Kit modal (workflow + repo picker) so we don't have to chain interactive Slack flows through ephemeral messages. |
| 34 | Phase-8 personal access tokens (`ats_<base64url-32B>`): the `requireAuth` middleware sniffs the bearer-token prefix — anything starting with `ats_` skips JWT verification and hashes through the `PersonalAccessToken` table instead. JWTs are still RS256/HS256 round-tripped on the existing path. The plaintext is returned exactly once on issue; only the sha-256 hash + a non-secret 12-char prefix (`ats_` + 8 chars) are persisted. `lastUsedAt` is updated fire-and-forget on each successful auth so admins can prune stale tokens without making auth latency-sensitive. |
| 35 | Phase-8 `WorkflowRun.costUsdAccrued` denormalization: cost is captured at finalize time by reading the join through `workRequest → activeWorkflows.costUsdAccrued`, summing across multi-active-workflow epics, and writing one number on the run row. Analytics reads the column directly; legacy rows (still RUNNING, or pre-phase-8) fall back to summing the live join — the back-compat path keeps the same shape so cross-window comparisons remain meaningful while older data ages out. |
| 36 | Phase-8 fan-out activity cancellation: each in-flight branch gets a per-call `CancellationScope` on the Temporal side; the dispatcher writes a `cancel()` token back into a sink the interpreter passes down. When `onBranchFail: 'block'` fires, the interpreter calls `cancel()` on every sibling sink, which abort-cancels their activity awaits. Dispatchers that omit the cancellation field fall back to the phase-3.5 "drain in-flight branches" behavior — no contract change for callers that didn't opt in. Cancelled activities surface as a normal Error (`'fan-out branch cancelled by sibling failure (block-mode)'`) so the aggregate reports them as branch failures rather than crashing the workflow. |
| 37 | Phase-8 significance hint: a frequentist two-proportion z-test on success rate between the two most-trafficked versions in the analytics window. Only emitted when both arms cross `MIN_SAMPLES_FOR_SIGNIFICANCE` (30) — under that and the UI shows raw counts only, never a false-confidence "significant" badge. We deliberately keep this as a hint (not a verdict) because a 30-run threshold is small for low-base-rate failure modes; teams still need to apply judgement. |
| 38 | Phase-8 Slack success notifications gate behind a per-team `slackNotifySuccess: Boolean` opt-in. The default is `false` because adding a success notification to every team's existing channel would be a notification firehose; the existing per-step failure path keeps working unchanged. Channel resolution mirrors the failure path (originating channel on WorkRequest → team-fallback). Fired once per run from `finalizeWorkflowRun` regardless of terminal status — we want closure even on FAILED so the team sees the run actually stopped. |
| 39 | Phase-8 memory hooks: the resolver activity and shell-step activity bypass the LLM-summarizer path (`commitToMemory`'s agent) and write `agent_lessons` rows directly via `recordLessonDirectly`. The summarizer earns its keep on free-form workflow outcomes; the resolver and shell step already know exactly what changed, so we'd be paying for an extra LLM call to re-derive structured fields we already have. The direct writer still generates the embedding so semantic search continues to find these lessons. |

---

## Phase Status

| Phase | Status | Slice |
|---|---|---|
| 1. Interpreter + parity refactor | **Done** | PR #13 |
| 2. Quality-gate steps | **Done** | lint / typecheck / test / build / vuln / perf + onFail policy + gate-fix loop |
| 3. Fan-out + decomposition + branch merging | **Done** | `fanOut` node + sealed child contexts, `planDecomposition` + `mergeBranches` activities, sequential execution; per-subagent workspace via `executeImplementation(request, subtask)` |
| 3.5 Parallel fan-out + conflict resolution | **Done** | concurrency-bounded worker pool inside `runFanOut`, `resolveMergeConflict` activity backed by the implementer agent, `mergeBranches.unmergedBranches` tail |
| 4. Web editor + run viewer | **Done** | `/templates` list, React Flow canvas editor (`TemplateEditor`) with drag-to-create + drag-to-connect + schema-aware inspector, version sidebar + promote, `/templates/[id]/runs` paginated history, `/runs/[id]` live DAG viewer with per-node status overlay; gateway CRUD + step-registry catalog |
| 5. Versioning UI, A/B per team, analytics | **Done** | version diff viewer, A/B experiment routing (`experimentVersion` + `experimentSplit`), analytics page (success rate, p50/p95, $/run, per-step failure rates), observed-cost chip on editor |
| 6. Custom shell steps with RBAC + audit | **Done** | team-admin-only step authoring, ephemeral container, image allowlist, audit log |
| 7. First-class in Slack + CLI | **Done** | `/auto-swe` slash command (workflows list/show + run modal), per-step Slack failure notifications, new `packages/cli/` workspace |
| 8. Ergonomics + memory + cost denorm + cancellation | **Done** | PATs, CLI `runs` + `tokens`, Slack success path, app manifest, shell/resolver → `commitToMemory`, per-branch gates example, denorm cost on `workflow_runs`, A/B significance hint, global analytics, fan-out activity cancellation |
| 9. Analytics UI + CLI run + cancel run | **Done** | `/analytics` global page, A/B winner badge on template analytics, `auto-swe run` CLI subcommand, cancel-run API + web UI button |

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

### Coverage gaps resolved in Phase 2

All four items shipped in Phase 2: `assertBuiltinStepsRegistered` invariant test, `artifactStore` Postgres/S3 backend tests, `createWorkflowRun` idempotency tests, and `resolveDefaultTemplate` gateway tests.

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

### Resolved decisions

1. `runTests` always runs the full suite fresh — see decision #13. TDD uses a faster subset internally.
2. Gate-failure feedback uses an explicit `executeGateFixImplementation` step so the fix loop is visible in the DAG — see decision #11.
3. Gate-runtime configs follow the precedence: step config → `Repository.gateCommands` → built-in defaults — see decision #12.

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

### Follow-ups resolved in Phase 3.5

- **Parallel execution** — shipped in Phase 3.5: concurrency-bounded `Promise.all` worker pool in `runFanOut`.
- **Conflict resolution agent** — shipped in Phase 3.5: `resolveMergeConflict` activity backed by the implementer agent.
- **Per-branch quality gates** — example spec (`examples/perBranchGates.spec.ts`) shipped in Phase 8.

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
  - `templates/[id]/page.tsx` — view mode shows the read-only `WorkflowDag` React Flow canvas; clicking **Edit** activates `TemplateEditor`, a three-panel React Flow canvas (left: `NodePalette` for drag-to-create; centre: React Flow canvas with dagre layout, drag-to-connect via typed handles, node drag-to-reposition; right: `NodeInspector` with schema-aware forms per node type). A **JSON** toggle exposes the raw textarea as an escape hatch. `Promote to active` button + default-template toggle on the version sidebar.
  - `templates/[id]/runs/page.tsx` — paginated run history with duration + work-request preview.
  - `runs/[id]/page.tsx` — live DAG viewer. TanStack Query polls every 3s while the run is `RUNNING`, 30s otherwise. Per-node status overlay (left edge strip + status text) computed by collapsing fan-out branch prefixes (`fanId[i]/subNode`) onto the parent DAG nodes. Click-to-inspect surfaces every attempt + outputs + error per node.
- **DAG layout.** `packages/web/src/lib/workflowLayout.ts` — initially shipped as a pure custom layered layout (longest-path BFS rank assignment + index-within-rank); subsequently reimplemented on top of `dagre` once the canvas editor was added. Tolerates back-edges (cond loops, fan-out join) without infinite recursion. Outputs positioned nodes + typed edges for both `WorkflowDag` (read-only React Flow canvas) and `TemplateEditor` (drag-edit React Flow canvas).
- **DAG renderer.** `packages/web/src/components/workflow/WorkflowDag.tsx` — read-only React Flow canvas used by the run viewer and diff pages. Cubic-bezier edges with kind-coloured strokes (onTrue green / onFalse red / onTimeout amber / subgraph purple / join teal / next slate). Accessible: each node is a focusable button with `role` / `tabIndex` / `onKeyDown` for Enter+Space activation.
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
| `/templates/[id]` | Template detail: React Flow canvas editor (Edit mode) + read-only DAG view + JSON escape hatch, version sidebar, step palette |
| `/templates/[id]/runs` | Template's paginated run history |
| `/runs/[id]` | WorkflowRun detail with DAG + per-node live status |

### Static `$/run` cost estimate

`packages/shared/src/workflow/costEstimator.ts` — pure walker that sums each step node's `costHint.tokensIn` × input price + `costHint.tokensOut` × output price using `DEFAULT_ROLE_PRICING` (overrideable per call). Branching nodes take the **max** of both arms (pessimistic worst-case); `fanOut` multiplies the subgraph's estimate by an assumed width (`DEFAULT_FANOUT_WIDTH = 4`); cycles are guarded by a visited set so retry loops count once. The estimate renders as a chip in the editor card title (`~$X.YY/run`) with the assumption surface in the tooltip. 8 tests in `costEstimator.test.ts`.

### Editable per-node config form

`packages/web/src/components/workflow/NodeConfigForm.tsx` — per-`StepFieldDef.type` form input (string / number / boolean / enum / json). Edits write through to the parsed spec, re-serialize, push into `editorJson`, and auto-switch to edit mode so the existing Save flow can land the change as a new version. Falls back silently if the spec is mid-edit and unparseable (the JSON editor remains the source of truth).

### Known follow-ups

- **Canvas drag-edit.** ~~Done~~ — `TemplateEditor` ships a full React Flow canvas with drag-to-create, drag-to-connect, and schema-aware node inspector. The JSON textarea remains accessible via the **JSON** toggle as an escape hatch. Remaining inspector gaps: `onFail` policy (block/warn/retry) on step and shell nodes; `fanOut` advanced fields (`concurrency`, `onBranchFail`, `exports`, `pluck`); step/shell `inputs` binding map; shell advanced options (`network`, `memory`, `cpus`).
- **Recent-run cost averages.** The estimate is static (from `costHint`s). Phase 5 analytics should fold in observed token usage from `workflow_runs` so the displayed number tracks reality per template.
- **Version diff.** Selecting a non-active version shows the spec but not a diff vs. active. A side-by-side textual diff (or DAG-level node/edge diff highlighting) would close the loop.
- **A11y.** SVG nodes are focusable buttons, but the DAG itself has no keyboard navigation between nodes. Worth wiring an arrow-key traversal in phase 5 once the editor grows.

### Files touched (recap)

- `packages/shared/src/workflow/{stepRegistry.ts,stepRegistry.test.ts,index.ts}` (move from worker), `packages/shared/package.json` (exports), `vitest.config.ts` (alias), `packages/worker/src/lib/{stepRegistry.ts,stepRegistry.test.ts}` (delete)
- `packages/shared/src/prisma/schema.prisma` + init migration (Team↔WorkflowTemplate fkey)
- `packages/shared/src/types/api.ts` (new types)
- `packages/gateway/src/routes/{workflowTemplates.ts,workflowTemplates.test.ts,workflowRuns.ts}` (new), `packages/gateway/src/index.ts` (mounts)
- `packages/web/src/lib/{workflowLayout.ts,workflowLayout.test.ts}`, `packages/web/src/components/workflow/WorkflowDag.tsx`, `packages/web/src/app/templates/**`, `packages/web/src/app/runs/[id]/page.tsx`, `packages/web/src/hooks/useWorkflows.ts`, `packages/web/src/components/layout/Sidebar.tsx`

---

## Phase 5 — Versioning UI, A/B per team, analytics (Done)

### What shipped

- **Schema.** `WorkflowTemplate.experimentVersion: Int?` + `experimentSplit: Int?` (0–100, CHECK-constrained) added to the squashed init migration. Disabled state is `(NULL, NULL)`.
- **A/B routing.** `experimentBucket(ticketId, templateId)` in `packages/gateway/src/routes/workRequests.ts` — deterministic sha1 mod 100, salted by templateId so two templates' experiments stay statistically independent. `resolveDefaultTemplate` now consults the experiment fields and returns `{ templateId, version, isExperiment }`; routing happens at gateway time so the Temporal layer never sees the bucket.
- **Validation.** `PATCH /workflow-templates/:id` accepts `experimentVersion` + `experimentSplit`; rejects (a) a `version` that doesn't exist on this template (`EXPERIMENT_VERSION_NOT_FOUND`) and (b) `split > 0` without a `version` set (`EXPERIMENT_VERSION_REQUIRED`).
- **Spec diff.** `packages/shared/src/workflow/specDiff.ts` — pure structural diff (`diffSpecs(before, after)`) returning `addedNodes`, `removedNodes`, `changedNodes`, `unchangedNodes`, plus top-level `metaChanges`. Canonical key-sorted JSON so property ordering doesn't show up as a spurious change.
- **Diff route.** `GET /workflow-templates/:id/diff?a=N&b=M` returns both raw specs + the structural diff so the editor can paint added/removed/changed nodes in the DAG.
- **Analytics route.** `GET /workflow-templates/:id/analytics?window=<days>` — `computeAnalytics()` is exported as a pure function for testing. Computes: `totalRuns`, `succeeded`, `failed`, `successRate`, `p50DurationMs`, `p95DurationMs`, `totalCost`, `avgCostPerRun`, `perStepFailureRates[]`, `perVersionCounts[]`. Cost is joined via `workflow_runs → workRequest → activeWorkflow.costUsdAccrued` and summed across activeWorkflows per WorkRequest (correct for epic decompositions). Skipped/pending step records excluded from the failure rollup.
- **Web pages.**
  - `/templates/[id]/diff` — version dropdowns + summary card + two side-by-side DAGs with `diffMarkers` (green added, red dashed removed, amber changed).
  - `/templates/[id]/analytics` — 8 KPI tiles, per-version run-mix breakdown (active vs. experiment badges), per-step failure rate table sorted desc with threshold colour coding.
  - `/templates/[id]` — added experiment-config form (version picker + split slider, with disable button); experiment badge on version sidebar; observed `$/run` chip next to the static estimate; nav links to Analytics + Compare versions + Run history.
- **WorkflowDag.** New `diffMarkers?: Record<string, DiffKind>` prop. Stroke colour + dashed outline for `'added' | 'removed' | 'changed'`.
- **API types.** `WorkflowTemplateAnalytics`, `SpecDiffResponse` added to `@auto-swe/shared/types/api`; `WorkflowTemplateSummary` extended with `experimentVersion` + `experimentSplit`.

### Tests (300 total, +21 from phase 4)

- `specDiff.test.ts` (shared) — identical specs, added/removed/changed nodes, in-place config changes, property-order tolerance, meta changes, deterministic sort.
- `workRequests.test.ts` (gateway) — A/B routing happy path (split=100 → experiment arm), no-traffic split (split=0 → active arm), missing-ticketId path, and `experimentBucket` determinism + range + decorrelation across templateIds.
- `workflowTemplates.test.ts` (gateway) — spec diff route happy path; PATCH rejects bad experiment config (missing version, version not on template); PATCH round-trips a valid experiment config. `computeAnalytics` unit test: empty input nulls, success rate + percentiles + cost rollup + per-step skipping + per-version counts.

### Known follow-ups

- **Run-level cost denormalization.** Analytics joins through WorkRequest → ActiveWorkflow at query time. For high-cardinality dashboards this is fine; once we have a `/workflows/global-analytics` page that aggregates across teams + templates, the join cost will grow and we should mirror `costUsdAccrued` onto `workflow_runs` (a new column written by `finalizeWorkflowRun`).
- **Statistical-significance hint.** The analytics page shows raw counts per version; it doesn't say "you have enough samples to declare a winner." A small Bayesian conversion test (or even just a coverage warning until per-arm N ≥ 30) would let teams promote experiments confidently.
- **Activity cancellation.** Same one as 3.5 — block-mode fan-out can't actually cancel in-flight branches.

---

## Phase 6 — Custom shell steps (RBAC + audit) (Done)

### What shipped

- **Schema.** `shell` node type added to `WorkflowSpecSchema`:
  - `{ type: 'shell', image, command, network?: 'none'|'egress', memory?, cpus?, timeoutMs?, next, onFail?, inputs? }`
  - `SPEC_SCHEMA_VERSION` bumped to 4. v3 → v4 codemod is bump-only (existing specs without shell nodes upgrade silently).
  - Shell nodes share the step-node failure contract (`{passed, summary, exitCode, ...}`), so `onFail: 'block'|'warn'|{retry:N}` works uniformly across step and shell. The interpreter's retry helper is now shared (`runRetryable`) between `runStep` and `runShell`.
- **Interpreter.** `Dispatcher.dispatchShell` is the new optional hook; the walker calls it for `type === 'shell'` and throws `no dispatchShell handler` for dispatchers that don't implement it (keeps the legacy testHelpers and pre-phase-6 dispatchers from silently swallowing shell nodes).
- **Image allowlist.** `packages/shared/src/workflow/shellImageAllowlist.ts` — built-in defaults (`node:24-alpine`, `python:3.13-alpine`, `alpine:latest`) + per-team additions on `Team.shellImageAllowlist`. Lives in `shared` so the gateway can validate at save-time without depending on `worker`. Exact-string match only.
- **Ephemeral container wrapper.** `packages/worker/src/lib/ephemeralContainer.ts` — `buildDockerArgs()` returns the locked-down argv (`--rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --tmpfs=/tmp:size=64m,mode=1777 --memory=512m --cpus=1`), plus `runEphemeralContainer()` which spawns it with a wall-clock cap and a defensive `docker rm -f` in the finally. `egress` flips network from `none` to `bridge`. Image + mount-source regex guards block argv smuggling.
- **Shell-step activity.** `packages/worker/src/activities/shellStep.ts` — full lifecycle:
  1. Load repo + team metadata; re-validate the image against the team's current allowlist (defense in depth — a stale spec from before a tightened allowlist gets rejected here too).
  2. Create a Docker named volume, clone the work-request branch into it via a throwaway `alpine/git` container (falls back to the default branch if the work-request branch isn't pushed yet).
  3. Run the user command in the ephemeral container with the volume mounted at `/workspace` and `workdir=/workspace/repo`.
  4. On success, run a second throwaway `alpine/git` container to `git add -A && git commit && git push origin HEAD:<branch>` — only if the working tree changed. Surfaces `committedSha` + `filesChanged` in the result.
  5. Store the full `$cmd / stdout / stderr` log as a `WorkflowArtifact` (`kind: shell.step`).
  6. `docker volume rm -f` the volume on the way out.
- **Audit.** `WorkflowShellAudit` table (squashed into the init migration). Every saved shell node writes one row per `(templateVersionId, nodeId, image, command, network, authorUserId)`. Indexed on `templateVersionId` + `teamId`.
- **Gateway RBAC.** `assertShellAuthoringAllowed()` runs on POST `/workflow-templates` and POST `/workflow-templates/:id/versions`:
  - Platform ADMIN: always allowed.
  - Other users on a team template: must be `TeamMembership.role === 'ADMIN'` in that team.
  - Other users on a global template: rejected (already short-circuited by the global-template ADMIN check; we still cover it explicitly for clarity).
  - Returns `SHELL_AUTHOR_FORBIDDEN` (403) when rejected.
- **Gateway image-allowlist endpoint.** `GET /api/v1/teams/:id/shell-image-allowlist` (team-ENGINEER) + `PUT /api/v1/teams/:id/shell-image-allowlist` (team-ADMIN). The PUT body validates each entry against the same image regex used at runtime (`[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*`) so a stored allowlist can't smuggle docker flags.
- **Editor UI.** `packages/web/src/app/templates/[id]/page.tsx` shows a danger-zone banner whenever the editor JSON contains shell nodes — lists up to five `(nodeId, image, command)` rows and prompts a `window.confirm()` on Save with the count. The DAG node colour for `shell` is a rose/red-orange so they're visible at a glance. (RBAC is still server-enforced; the UI surface is informational, not a security boundary.)
- **Worker wiring.** `RunnableWorkflow` registers a `shellActivities` proxy (60m STC, 2m heartbeat) and a `dispatchShell` handler that pulls `image`/`command` straight off the typed node fields with `inputs.*` overrides for late binding.

### Tests (+19, currently 315 total)

Phase 6 additions:
- `spec.test.ts` — 5 new tests: minimal shell parse, full-options parse, missing-command / missing-image rejection, bad memory / network literal rejection, dangling `next` detection.
- `interpreter.test.ts` — 5 new tests: dispatch + record-PASSED happy path, `onFail: 'warn'` continues past `passed: false`, `onFail: 'block'` throws on `passed: false`, `onFail: { retry: N }` re-invokes until success, "no dispatchShell handler" error path.
- `codemods.test.ts` — chain expanded to v1→v4; new v3→v4 preservation test.
- `shellImageAllowlist.test.ts` — 8 tests covering built-in always-allowed, team extensions, prefix non-matching, malformed entries, blank rejection, `assertShellImageAllowed` typed error.
- `ephemeralContainer.test.ts` — 8 tests covering the locked-down flag set, `--` separator, network mode toggle, custom memory/cpu, image / mount-source / memory / cpu rejection regexes, custom workdir.
- `workflowTemplates.test.ts` — 5 new RBAC tests: non-admin POST rejected, non-platform-admin global rejected, team-admin POST with allowlisted image succeeds + writes audit, non-allowlisted image rejected, team-extended image accepted.
- `examples/shellStep.spec.test.ts` — 3 tests covering the new example spec: it parses, uses a built-in-allowlist image, and uses `onFail: 'warn'`.

### Files touched (recap)

- **shared**: `workflow/spec.ts`, `workflow/codemods.ts`, `workflow/interpreter.ts`, `workflow/index.ts`, `workflow/costEstimator.ts`, `workflow/shellImageAllowlist.ts` (new), `prisma/schema.prisma`, `prisma/migrations/20260510000000_init/migration.sql`
- **worker**: `lib/ephemeralContainer.ts` (new), `activities/shellStep.ts` (new), `activities/index.ts`, `workflows/runnable.ts`
- **gateway**: `routes/workflowTemplates.ts`, `routes/teams.ts`
- **web**: `app/templates/[id]/page.tsx`, `components/workflow/WorkflowDag.tsx`, `lib/workflowLayout.ts`

### Known follow-ups

- **Egress filtering.** ~~Done~~ — `Team.egressAllowlist` (hostname array) stored in DB, manageable via `GET/PUT /api/v1/teams/:id/egress-allowlist`. DNS-based filtering via `--dns=127.0.0.2` + per-hostname `--add-host` entries. Wildcard entries are informational; IP-direct connections bypass DNS filtering (out of scope for the spec runtime — see decision #30).
- **Audit retention.** ~~Done~~ — `POST /api/v1/admin/shell-audit/prune?days=N` deletes rows older than N days (default 90). Exposed as a button on the `/admin/access-tokens` dashboard page alongside the token list.
- **Shell-step memory.** Successful shell-step outcomes (especially ones that fix a gate) are the kind of thing `commitToMemory` could capture, but the activity doesn't yet hook into the memory pipeline. Same shape as the phase-3.5 resolver-memory follow-up.

---

## Phase 7 — First-class in Slack + CLI (Done)

### What shipped

**Slack — slash command + modal**:
- `POST /api/v1/auth/slack/commands` — HMAC-verified slash command endpoint (signature shared with `/interactive` via `gateway/src/lib/slack.ts`). Scoped form-urlencoded content-type parser registered inside the slack plugin so both `/commands` and `/interactive` see `request.body` as an object while `fastify-raw-body` still sees the bytes for signature verification.
- Subcommands: `workflows list`, `workflows show <name>`, `run [description]`, `help`. Unknown Slack users get an ephemeral hint to link via `/api/v1/auth/slack/connect`; unknown subcommands get the help text.
- `/auto-swe run` opens a Block Kit modal (`callback_id: auto_swe_run_modal`) with ticket / description / repo / workflow pickers. The repo picker is filtered to repos on the user's team; the workflow picker offers all visible templates plus a `(team default)` sentinel. Submission validates inputs, starts a Temporal `RunnableWorkflow` via the existing `resolveDefaultTemplate` helper (so A/B routing is honoured), and writes `WorkRequest.slackChannelId` so step failures can thread back to the originating conversation.

**Slack — per-step failure notifications**:
- `WorkRequest.slackChannelId` (new field, paired with the pre-existing `slackMessageTs`) captures the channel the work request was kicked off from.
- `Team.slackNotifyChannel` (new field, managed by team admins out-of-band for now) is the fallback channel.
- `packages/worker/src/lib/slackNotify.ts` — `notifySlackStepFailure()` is called from `recordWorkflowStep` whenever a step lands in `FAILED`. Two-tier channel resolution (workRequest → team), best-effort posting (try/catch around the fetch), no-op when `SLACK_BOT_TOKEN` is unset. Throttled to **first attempt only** so `onFail.retry` doesn't spam the channel; the final-failure surface is the workflow_runs FAILED row.

**CLI — new `packages/cli/` workspace**:
- New `@auto-swe/cli` workspace with `bin.auto-swe`. Builds via `tsc`, ships ESM, `@types/node` + DOM lib pulled in for `fetch`.
- `packages/cli/src/lib/env.ts` — auth resolution: `AUTO_SWE_TOKEN` wins, else `AUTO_SWE_USERNAME` + `AUTO_SWE_PASSWORD` against `/api/v1/auth/login`. No on-disk token cache.
- `packages/cli/src/lib/api.ts` — thin fetch wrapper that unwraps `{ data, error }` and surfaces non-2xx as a typed `GatewayError` with `statusCode` + `code`.
- `packages/cli/src/commands/workflows.ts` — subcommands:
  - `auto-swe workflows list` — tabular `(name, team, version, default, status)` view.
  - `auto-swe workflows show <name> [--version=N]` — prints the active (or specified) spec JSON.
  - `auto-swe workflows export <name> [-o <path>] [--version=N]` — same payload as `show`, but writes to a file when `-o` is set.
  - `auto-swe workflows import <path> [--name=NAME] [--team=<slug>]` — POSTs a new template, or `POST /:id/versions` when a template with that name already exists (idempotency for repeated CI imports). Team slugs are resolved via `GET /api/v1/teams`.
- Shared `parseFlags()` (exported for unit tests) handles `--key=val`, `--key val`, and `-x val` shapes plus boolean fall-through.

### Schema

- `teams.slack_notify_channel TEXT NULL` — best-effort channel for step failures.
- `work_requests.slack_channel_id TEXT NULL` — paired with `slack_message_ts`; populated by the `/auto-swe run` flow.
- Both folded into the squashed init migration (`20260510000000_init/migration.sql`) per the repo convention.

### Tests (+22, currently 341 total)

- `gateway/src/lib/slack.test.ts` — 6 tests: signature verification happy path, tamper, wrong secret, stale timestamp, malformed timestamp, mismatched signature length.
- `gateway/src/routes/slack.test.ts` — 7 tests for the slash command: missing signature → 401, bad signature → 401, unlinked Slack user → ephemeral hint, `workflows list` returns templates, unknown subcommand → help text, `workflows show <name>` returns the active spec, unknown template name → friendly message.
- `worker/src/lib/slackNotify.test.ts` — 6 tests: no-op without `SLACK_BOT_TOKEN`, throttled past attempt 1, posts to originating channel, falls back to team channel, silent skip when no channel resolves, swallows DB errors.
- `cli/src/commands/workflows.test.ts` — 7 tests on `parseFlags()`: positional-only, `--foo=bar`, `--foo bar`, short `-o`, boolean flag, follow-flag non-consumption, mixed positionals + flags.

### Known follow-ups

- **App-Manifest export.** The Slack app manifest (slash command registration + scopes + interactive endpoint URL) lives outside this repo. A `docs/slack-app-manifest.json` would let teams self-serve setup.
- **Slack mentions on success / merge / approval.** We only notify on step failures right now. A symmetric "ready for review" or "merged" message would close the loop with the originating channel.
- **CLI `auto-swe runs` subcommand.** Listing in-flight runs and tailing step status from a terminal is the natural next CLI surface — same query shape as the web's `/runs/[id]` page, just JSON-Lined to stdout.
- **CLI auth via PAT.** Long-lived JWTs are awkward for CI; once the gateway gains personal-access-token issuance, the CLI should consume those instead.

### Files touched (recap)

- **shared**: `prisma/schema.prisma`, `prisma/migrations/20260510000000_init/migration.sql` (Team.slackNotifyChannel + WorkRequest.slackChannelId)
- **gateway**: `lib/slack.ts` (new), `routes/slack.ts` (slash command + modal handler), `routes/slack.test.ts` (new), `lib/slack.test.ts` (new)
- **worker**: `lib/slackNotify.ts` (new), `lib/slackNotify.test.ts` (new), `activities/templates.ts` (recordWorkflowStep notifies on FAILED)
- **cli**: new workspace `packages/cli/` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/lib/env.ts`, `src/lib/api.ts`, `src/commands/workflows.ts`, `src/commands/workflows.test.ts`

---

## Phase 8 — Ergonomics + memory + cost denormalization + cancellation (Done)

### What shipped

**Operational ergonomics (8a)**:
- `PersonalAccessToken` table + `POST/GET/DELETE /api/v1/auth/tokens` routes. Plaintext is `ats_<base64url-32B>` and only appears on the create response — the row stores sha-256(hash) + 12-char non-secret prefix + `lastUsedAt` for staleness pruning. The `requireAuth` middleware sniffs the `ats_` prefix and skips JWT verification, looking the token up by hash instead. JWT auth continues unchanged.
- CLI `auto-swe runs` subcommand (`list`, `show <id>`, `tail <id>`) and `auto-swe tokens` subcommand (`list`, `create <name>`, `revoke <id>`). `tokens create` prints the plaintext on stdout and the one-shot warning on stderr so `> token.txt` pipes only capture the secret. `runs tail` polls `/workflow-runs/:id` and exits 0 on SUCCESS / 2 on terminal failure / 1 if it gives up.
- `Team.slackNotifySuccess: Boolean` (default false) opt-in for terminal-run notifications. `notifySlackRunComplete` fires from `finalizeWorkflowRun` for every terminal status when set; channel resolution mirrors the failure path (originating WorkRequest channel → team fallback). Per-step failure notifications continue to fire whether or not the team opts in.
- `docs/slack-app-manifest.json` — copy-paste manifest with placeholder hostnames so teams can self-serve the Slack app setup without reading the slash-command + interactivity docs cold.

**Memory + per-branch gates (8b)**:
- `recordLessonDirectly()` in `commitToMemory.ts` — bypasses the LLM summarizer and writes one `agent_lessons` row with a generated embedding. Resolver + shell-step activities call it on success; failures aren't recorded (the FAILED workflow_run row already tells that story).
- `examples/perBranchGates.spec.ts` — decompose → fan-out implementer + per-branch lint/typecheck/tests (all `onFail: 'block'`) → merge → review. Pluck stays at `result.branch` so the merge step's `sourceBranches` binding works identically to the unmodified decomposition example.

**Cost denormalization + analytics maturity (8c)**:
- `WorkflowRun.costUsdAccrued: Float` column. `finalizeWorkflowRun` reads through `workRequest → activeWorkflows` (the same join the analytics route used to do every request), sums across multi-active-workflow epics, and writes the result. Analytics reads the column directly; legacy rows fall back to the live join so cross-window comparisons stay meaningful while older data ages out.
- `computeAnalytics` now returns `significanceHint: SignificanceHint | null` — a two-proportion z-test on success rate between the two most-trafficked versions in the window. Returns `null` until both arms cross `MIN_SAMPLES_FOR_SIGNIFICANCE` (30) so the UI never shows false-confidence verdicts.
- `GET /api/v1/workflow-templates/analytics?window=<days>` — cross-template rollup ranked by traffic, with per-template success rate + cost. Visibility filter piggy-backs on the existing per-template `teamMembershipFilter` so engineers see only what they could already drill into.

**Activity cancellation (8d)**:
- `Dispatcher.dispatchStep` / `dispatchShell` accept an optional `cancellation: { token?: CancellationToken }` sink. The interpreter passes the sink down for every dispatch inside a fan-out branch; the dispatcher writes back a `cancel()` handle (or leaves it undefined when cancellation isn't supported).
- `runFanOut` maintains a `Map<branchIndex, sink>` of in-flight branches. When `onBranchFail: 'block'` fires, the walker calls `cancel()` on every sibling sink before bubbling the failure. Dispatchers that don't support cancellation degrade to the phase-3.5 drain behavior.
- Temporal dispatcher: each cancellable call goes through `runWithCancellation()` which spins up a `CancellationScope` and writes its `cancel()` into the sink. A cancelled activity surfaces as a normal Error (`fan-out branch cancelled by sibling failure (block-mode)`) so the aggregate reports it as a branch failure instead of crashing the workflow with the raw `CancelledFailure` envelope.

### Schema

- `personal_access_tokens (id, user_id, name, token_hash UNIQUE, prefix, expires_at, last_used_at, revoked_at, created_at)` — indexed on `user_id`.
- `teams.slack_notify_success BOOLEAN NOT NULL DEFAULT false`.
- `workflow_runs.cost_usd_accrued DOUBLE PRECISION NOT NULL DEFAULT 0`.

All folded into the squashed init migration per the repo convention.

### Tests (+~32)

- `gateway/src/routes/tokens.test.ts` — 6 tests covering create + hash-only persistence, list scoping to requester, 404 on cross-user revoke, idempotent re-revoke, expiresInDays.
- `gateway/src/routes/workflowTemplates.test.ts` — `computeAnalytics` phase-8 additions: denormalized cost column wins over the workRequest fallback, significance hint emits + suppresses correctly. Plus a `computeGlobalAnalytics` describe block.
- `worker/src/lib/slackNotify.test.ts` — `notifySlackRunComplete` opt-in gate + originating-channel preference + team fallback + no-op without token (4 new tests).
- `shared/src/workflow/interpreter.test.ts` — 2 new tests: block-mode cancels siblings when the dispatcher supports it; block-mode without cancellation support still drains (regression check on the legacy path).
- `cli/src/commands/runs.test.ts` + `tokens.test.ts` — 11 tests covering help / arg validation / flag parsing / SUCCESS+FAILED tail exit codes / plaintext-on-stdout invariant for token issuance.
- `shared/src/workflow/examples/perBranchGates.spec.test.ts` — 4 tests: parses, all branch gates blocking, subDone projects branch from currentCodeResult, fan-out blocks on first failure.

### Known follow-ups

- **Web UI for the new analytics surfaces.** The phase-8 gateway endpoints (`/workflow-templates/analytics` global rollup, `significanceHint` on per-template analytics) are wired but `/templates/[id]/analytics` only renders the per-template view today. A `/analytics` page and a "winner detected" badge on the template detail page are the natural next slice.
- **CLI `run` subcommand.** Kicking off a work request from the terminal would close the loop with the Slack `/auto-swe run` modal. Same shape as the workflow-templates pickers — just JSON-Lined to stdout.
- **PAT admin view.** ~~Done~~ — `GET /api/v1/admin/access-tokens` (list all users' tokens with owning user email) and `DELETE /api/v1/admin/access-tokens/:id` (revoke any token) shipped in PR #23. Web page at `/admin/access-tokens`; sidebar link visible to ADMIN role.
- **Cancellation surface area.** Phase 8d wires cancellation into fan-out block-mode. A natural follow-up: workflow-level "cancel run" from the web UI uses the same plumbing to abort an in-flight run end-to-end.

### Files touched (recap)

- **shared**: `prisma/schema.prisma` + migration (`personal_access_tokens`, `teams.slack_notify_success`, `workflow_runs.cost_usd_accrued`), `workflow/interpreter.ts` (cancellation hooks), `workflow/analytics.ts` (denorm cost path + significance + global), `workflow/index.ts` (exports), `workflow/examples/perBranchGates.spec.ts` (new), `types/api.ts` (analytics + global types).
- **gateway**: `plugins/auth.ts` (PAT bearer-token sniff), `routes/tokens.ts` (new), `routes/workflowTemplates.ts` (`/analytics` global route + denorm cost in per-template), `index.ts` (mount).
- **worker**: `lib/slackNotify.ts` (`notifySlackRunComplete`), `activities/templates.ts` (denorm write + terminal notify in `finalizeWorkflowRun`), `activities/commitToMemory.ts` (`recordLessonDirectly`), `activities/decomposition.ts` (resolver memory hook), `activities/shellStep.ts` (shell memory hook), `workflows/runnable.ts` (`runWithCancellation`).
- **cli**: `src/commands/runs.ts` + `tokens.ts` (new), `src/lib/env.ts` (PAT note), `src/index.ts` (HELP + dispatch).
- **docs**: `slack-app-manifest.json` (new), `configurable-workflows.md` (this section).

---

---

## Phase 9 — Analytics UI + CLI run + Cancel run (Done)

### What shipped

**Cancel-run API + web button**:
- `fastify.temporal.cancelWorkflow(workflowId)` added to the temporal plugin — calls Temporal's `handle.cancel()`, which delivers a `CancelledFailure` to the running workflow via its built-in cancellation-scope handling.
- `POST /api/v1/workflow-runs/:id/cancel` — requires ENGINEER role, visibility-scoped identically to the GET route. Returns `409 RUN_NOT_RUNNING` if the run is already in a terminal state. Fires both the Temporal cancel request and an optimistic DB status write (`CANCELLED`) in parallel so the UI reflects the change instantly even when the worker is momentarily unavailable. The worker's own `finalizeWorkflowRun` call reconciles on actual completion.
- `/runs/[id]` web page — "Cancel run" button appears only when `run.status === 'RUNNING'`. Prompts a `window.confirm` ("Cancel this run? In-flight steps will be aborted.") before firing `useCancelWorkflowRun`. Disabled + shows "Cancelling…" while the mutation is in flight. Invalidates `['workflow-run', id]` and `['workflows']` on success so the DAG and the active-runs list both update.

**Global `/analytics` page**:
- `GET /api/v1/workflow-templates/analytics?window=<days>` was already wired in Phase 8; this phase surfaces it in the UI.
- `packages/web/src/app/analytics/page.tsx` — platform-wide overview: four KPI tiles (total runs, success rate, succeeded, total cost) + a per-template table sorted by traffic showing success rate (colour-coded: ≥80% green, ≥50% amber, <50% red), total cost, and avg cost/run. Window selector (7d / 30d / 90d) at the top right. Each template name links to its `/templates/[id]` detail page.
- "Analytics" nav item added to the sidebar (visible to all roles: ENGINEER, LEAD, ADMIN).
- `useGlobalAnalytics(windowDays)` TanStack Query hook wired to a 30-second refetch interval.

**A/B winner badge on template analytics**:
- The `significanceHint` field (computed since Phase 8) is now rendered at the top of the per-version section in `/templates/[id]/analytics`.
- Shows "Winner detected (p=0.xxx)" in green when `isSignificant: true`, or "Not yet significant (p=0.xxx)" in amber otherwise. Only renders when `significanceHint !== null` (both arms ≥ 30 runs).
- Side-by-side success-rate + N display for version A vs B; arm labels carry "active" and "experiment" badges so the team immediately knows which direction to promote.

**CLI `auto-swe run` subcommand**:
- `packages/cli/src/commands/workRequests.ts` — `runWorkRequestsCommand()`:
  - Resolves `--repo=<org/name>` by calling `GET /api/v1/repositories` and matching `organizationName` + `repoName` (case-insensitive). Errors with a helpful message when the repo isn't found.
  - Optionally resolves `--workflow=<name>` by calling `GET /api/v1/workflow-templates` (uses team default when omitted).
  - POSTs to `/api/v1/work-requests` with `{ externalTicketId, description, repoIds, budgetTier }`. Supports `--budget=STANDARD|LARGE|EPIC` (default STANDARD).
  - Prints the submitted work-request ID and a hint to use `auto-swe runs tail <runId>` for live status.
- Dispatched from `index.ts` via `if (cmd === 'run')`.
- Help text updated in the top-level HELP constant.
- Decision 40 (see below): the `run` command resolves repos by name rather than asking for a UUID — following the same UX convention as `workflows show <name>`.

### Decisions

| # | Decision |
|---|---|
| 40 | `auto-swe run` resolves the repo ID by `GET /api/v1/repositories` + case-insensitive `org/name` match. A future `--repo-id=<uuid>` flag can bypass this for scripts that already have the ID. |
| 41 | Cancel writes `CANCELLED` optimistically to the DB in addition to signalling Temporal. This trades a brief window where the Temporal workflow still thinks it's running for an instant UI update that doesn't require the worker to be up. `finalizeWorkflowRun` in the worker writes the authoritative status on completion. |
| 42 | The global analytics page (`/analytics`) uses the same `window` parameter as the per-template route and mirrors the 30s refetch interval. It does not paginate `perTemplate` entries — the cap of 10 000 rows the gateway reads before aggregating makes the per-template list self-bounding for any realistic number of templates. |

### Tests (+8)

- `cli/src/commands/workRequests.test.ts` — 7 tests: help flag, missing `--ticket`, missing `--description`, missing `--repo`, bad `--repo` format (no slash), repo not found in gateway, successful happy-path (mocks repos + teams + work-requests endpoints, asserts exit 0 + prints ID).
- `gateway/src/routes/workflowRuns.test.ts` — 1 new test: `POST /:id/cancel` on a non-RUNNING run returns 409 `RUN_NOT_RUNNING`.

### Files touched (recap)

- **gateway**: `plugins/temporal.ts` (`cancelWorkflow` method + type), `routes/workflowRuns.ts` (`POST /:id/cancel` route)
- **web**: `app/analytics/page.tsx` (new global analytics page), `app/templates/[id]/analytics/page.tsx` (significance badge), `app/runs/[id]/page.tsx` (cancel button), `components/layout/Sidebar.tsx` (Analytics nav item), `hooks/useWorkflows.ts` (`useGlobalAnalytics` + `useCancelWorkflowRun`)
- **cli**: `src/commands/workRequests.ts` (new), `src/commands/workRequests.test.ts` (new), `src/index.ts` (dispatch `run`)

### Known follow-ups

- **PAT admin view.** ~~Done~~ — `GET /api/v1/admin/access-tokens` + `DELETE /api/v1/admin/access-tokens/:id` shipped in PR #23. See Phase 8 follow-up for full details.
- **Inspector gaps.** ~~Done~~ — `onFail` policy (block/warn/retry) on step and shell nodes, `fanOut` advanced fields (`concurrency`, `onBranchFail`, `exports`, `pluck`), step/shell `inputs` bindings map, and shell options (`network`, `memory`, `cpus`) are all now editable in the inspector.
- **A11y.** The DAG SVG nodes are focusable buttons but keyboard traversal between nodes (arrow keys) is not yet wired.
- **Global analytics pagination.** ~~Done~~ — client-side sort + paginate (PAGE_SIZE=25) with filter bar on the per-template table in `/analytics`. Time-window selector resets page; sort/filter also reset page.
- **Egress filtering for shell steps.** ~~Done~~ — `Team.egressAllowlist` (hostname array) is stored in the DB, manageable via `GET/PUT /api/v1/teams/:id/egress-allowlist`. At container-run time the worker resolves each hostname to an IP and injects `--add-host` + `--dns=127.0.0.2` so DNS lookups to unlisted names fail. Limitation: IP-direct connections bypass DNS filtering; destination-based enforcement requires host iptables (out of scope for the spec runtime).

---

## Entry Points

- Interpreter: `packages/shared/src/workflow/interpreter.ts` → `runSpec(spec, ctx, dispatcher)`
- Workflow runtime: `packages/worker/src/workflows/runnable.ts` → `RunnableWorkflow`
- Step catalog: `packages/shared/src/workflow/stepRegistry.ts` (moved from `packages/worker` in Phase 4)
- Spec schema: `packages/shared/src/workflow/spec.ts`
- Default seeded spec: `packages/shared/src/workflow/defaultEngineeringSpec.ts`
- Artifact store: `packages/worker/src/lib/artifactStore.ts`
