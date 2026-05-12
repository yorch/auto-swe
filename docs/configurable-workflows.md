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

---

## Phase Status

| Phase | Status | Slice |
|---|---|---|
| 1. Interpreter + parity refactor | **Done** | PR #13 |
| 2. Quality-gate steps | Not started | lint / typecheck / test / build / vuln / perf |
| 3. Fan-out + decomposition + branch merging | Not started | parallel subagents, one workspace each, merged into feature branch |
| 4. Web editor (React Flow + run viewer) | Not started | `/workflows` page, DAG editor, live run viewer |
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

## Phase 2 — Quality-gate steps

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

## Phase 3 — Fan-out + decomposition + branch merging

### Adds

- **`fanOut` node type** in the spec: `{ over: Binding, subgraph: NodeId, join: NodeId, concurrency?: number }`. Resolves `over` to an array, runs `subgraph` once per element in parallel (capped by `concurrency`), waits at `join`.
- **`planDecomposition` activity + agent** — takes a work request + repo context, returns `Subtask[]` (feature-level split). Lives in `packages/worker/src/agents/decomposer.ts`.
- **Per-subagent workspace** via the existing `createWorkspace` helper, one container per fan-out branch. Each subagent works on `auto/<ticket>/<subtaskId>`.
- **`mergeBranches` activity** — fast-forwards (or merges with conflict resolution agent if needed) all subtask branches into the feature branch before the final PR.

### Spec sketch

```
planDecomposition
  └─ fanOut(over: $.subtasks, concurrency: 4)
      ├─ createBranch
      ├─ executeImplementation
      ├─ runReviewNetwork
      └─ gate(onPass → commit, onFail → reviewFix loop)
  └─ joinAll
  └─ mergeBranches(target: auto/<ticket>)
  └─ [phase-2 quality gates run on the merged branch]
  └─ openPR → waitForCI → ...
```

### Files to touch

- `packages/shared/src/workflow/spec.ts` — add `fanOut` node; bump schemaVersion if breaking
- `packages/shared/src/workflow/interpreter.ts` — add `runFanOut` (sequential implementation first, then `Promise.all`-with-concurrency-limit)
- `packages/worker/src/agents/decomposer.ts` (new)
- `packages/worker/src/activities/decomposition.ts` (new) — `planDecomposition`, `mergeBranches`, `createBranchInWorkspace`
- `packages/worker/src/workflows/runnable.ts` — dispatcher for new step names

### Open questions

1. **Subgraph context isolation.** Each fan-out branch needs its own context slice (`subtask`, `subtaskCodeResult`). Decide: copy parent context + add per-branch overrides, or give each branch a sealed child context that propagates only declared exports back to the parent at `joinAll`?
2. **Merge conflict resolution.** Phase 3 ships with "merge fails → workflow fails", no auto-resolution. Phase 3.5 can add a `resolveMergeConflict` agent.
3. **Concurrency vs. Temporal history.** Each parallel branch emits activity invocations into the workflow history. With `concurrency: 10` and a 30-step subgraph that's 300 history entries before `joinAll`. Watch the 50MB cap; bump artifact-store usage to keep diffs/logs out of the history.

---

## Phase 4 — Web editor + run viewer

### Adds

- `/workflows` — list per team (active version, last edited, last run status)
- `/workflows/[id]/edit` — React Flow DAG editor
  - Step palette generated from `stepRegistry.ts` metadata
  - Right sidebar: Zod-derived form for the selected node's config
  - Live $/run estimate from `stepRegistry.ts` cost hints + recent run averages
  - Save creates a new `WorkflowTemplateVersion` (immutable; old in-flight runs unaffected)
- `/workflows/[id]/runs` — paginated run history
- `/runs/[id]` — DAG view with per-node live status (TanStack Query polling on `workflow_steps`)

### Files to touch

- New `packages/web/app/workflows/page.tsx`, `[id]/edit/page.tsx`, `[id]/runs/page.tsx`, `runs/[id]/page.tsx`
- New `packages/gateway/src/routes/workflows.ts` — CRUD endpoints (list templates, get version, create version, list runs, get run + steps)
- Shared `packages/shared/src/workflow/registry-types.ts` already exports `StepMetadata`; web imports it to render the palette

### Open questions

1. **Editor library choice.** React Flow is the obvious pick (auto-layout via `dagre` or `elkjs`). Confirm vs. lighter alternatives.
2. **Form generation.** Zod → form is a known weak spot. Options: hand-roll per-field from `StepFieldDef`, use `@rjsf/core` (JSON Schema Form), or `react-hook-form` + custom field renderers. Default: hand-roll, ~6 field types is manageable.
3. **Permissions.** `workflow:read` (any team member), `workflow:write` (team admin), `workflow:write:shell` (team admin, gated separately in phase 6).

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
