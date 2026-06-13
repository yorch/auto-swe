# Platform Pivot — RFC & Roadmap

Living planning doc for the **platform pivot**: turning auto-swe from a SWE-specific
autonomous coding system into a generic, durable, **multi-agent workflow orchestration
platform** where SWE ships as the first first-party **pack**. Each phase is sized to land in
one (or a small handful of) PR(s). Pick up here when starting a follow-up PR.

> Status: **Proposed** (2026-06-13). Phases P0–P3 are committed for build; P4–P5 are
> deferred but fully specified here so the architecture accommodates them from day one.

---

## Vision

The product is a **durable, governed, multi-agent workflow orchestration platform**. The
workflow engine — already a JSON-defined, versioned, team-owned DAG executed on Temporal — *is*
the product. Domain functionality ships as **packs**: installable, versioned bundles of
templates, step definitions, agent roles, skills, scanner patterns, connection types, memory
schema, and seed data. **SWE becomes the first, first-party pack** (`@auto-swe/pack-swe`),
repackaged from today's hardcoded workflow.

The moat is not "compose agent DAGs" (crowded). It is **durable execution + HITL governance +
multi-agent review + layered security scanning + semantic memory + cost/budget control**,
applied to production agent workflows. The positioning leads with *governed, durable agent
orchestration*; SWE is the flagship proof, not the ceiling.

Users extend the platform through a **four-tier extension model**, surfaced through **layered
abstractions** so ops, app developers, and platform teams each work at their preferred altitude:

| Tier | What it is | Audience | Status |
|---|---|---|---|
| **1. Declarative agent step** | A new `agent` node: pick model/prompt + skills + tools + I/O schema, no code | App devs, ops (via canvas) | P2 |
| **2. MCP tools** | Bring-your-own-tools via MCP; also "call an MCP tool as a node" | App devs, platform | P2 |
| **3. Shell / container step** | Arbitrary sandboxed compute as a step (already exists) | Platform | shipped; generalized P1 |
| **4. Plugin SDK (coded steps)** | Third-party coded steps via a container I/O contract + manifest | Advanced devs / vendors | **P4 (deferred)** |

Abstraction layers: **visual canvas** (React Flow editor, exists) · **declarative JSON + CLI**
(template import/export, exists) · **authoring SDK** (TypeScript SDK for packs/steps/templates,
P4–P5).

---

## Naming

- **Platform / core** — the engine: interpreter, Temporal runtime, step registry, `AgentSpec`
  resolver, generic schema (templates, runs, steps, traces, connections, memory, roles).
- **Pack** — a domain bundle installed onto the platform. SWE is `pack-swe`.
- **Role** — an opaque string key naming an agent persona; resolves to an `AgentSpec`.
- **AgentSpec** — the normalized runtime description of an agent invocation
  (`{ modelSpec, systemPrompt, skills[], tools[], outputSchema, memoryScope }`), produced
  either from a named role (cascade lookup) or from an inline declarative-step config.
- **Connection** — generalized external-system binding (credentials + config). SWE's
  `Repository` becomes a specialization of `Connection`.
- **StepDefinition** — a registered, schema'd capability the interpreter can dispatch, with an
  executor kind: `builtin | agent | mcp | shell | plugin`.

---

## Architecture Decisions

| # | Decision |
|---|---|
| 1 | The engine treats **role as an opaque string key** end-to-end. The Prisma `AgentRole` enum is **deleted**; `ModelRoleConfig.role`, `AgentSkillAssignment.agentRole`, `AgentToolConfig.agentRole`, and `AgentTrace.agentRole` become `String`. No hardcoded role list anywhere in core. |
| 2 | A single **`AgentSpec` resolver** unifies named roles and inline declarative steps. Input is either a role key (→ 3-level cascade `WORKFLOW_TEMPLATE → TEAM → GLOBAL` + skills + tools) or an inline spec (used as-is). Output is one normalized `AgentSpec` consumed by the generic agent-run loop. |
| 3 | `assertConfigReady()` is **computed, not hardcoded**. It validates the **union of roles required by installed packs + roles referenced by active template specs**, not a fixed set of 6. Missing rows still fail fast at boot. |
| 4 | **Cost pricing is decoupled from roles.** `recordLlmUsage`/`MODEL_PRICES`/`getModelPrice` key off the resolved `provider/model` spec only. The `role` argument is retained for attribution/telemetry, never for pricing. |
| 5 | A **Pack** is the unit of packaging and distribution: `{ manifest, templates, stepDefinitions, roles, skills, scannerPatterns, connectionTypes, memorySchema, seed }`. Packs are versioned and scoped (GLOBAL / TEAM). Built-in rows carry a `pack` discriminator column. |
| 6 | **Step dispatch is registry-driven.** The hardcoded `dispatchStepImpl` switch is replaced by a `StepRegistry` populated at worker boot by each installed pack's `register()` hook. The interpreter's `Dispatcher` seam is unchanged. |
| 7 | **`Repository` is generalized to `Connection` now** (no backward-compat shim). A `Connection` has `{ type, name, config(json), credentialRef }`. SWE's repo fields (`mcpServerRef`, `gateCommands`, default branch, etc.) move into the SWE connection type's `config` payload or a `pack-swe`-owned satellite table. |
| 8 | **No backward compatibility.** The system is undeployed; migrations are rewritten/consolidated rather than evolved. Optimize purely for the target architecture. The frozen `WorkflowRun.specSnapshot` is retained because it's good design, not for back-compat. |
| 9 | **Generic run input.** `WorkRequest` (externalTicketId/repoIds) is replaced by a generic run input: a template declares an **input schema** (Zod/JSON-Schema); a trigger maps an event payload to it. SWE's `{ ticketId, connectionId(repo), description, budget }` becomes the SWE template's declared input. |
| 10 | **Generic triggers.** Triggers (manual/API, webhook-any-source, schedule, event) map an external payload → a template's input schema. GitHub/Jira webhooks become `pack-swe`-provided trigger adapters, not core. |
| 11 | **Generic memory.** `AgentLesson` is keyed by an arbitrary **memory scope** (namespace) + free-form **tags**, not by `repoId` + SWE `failureType`. pgvector retrieval is unchanged; only keys generalize. SWE tags lessons with `repo`/`failureType` via the generic mechanism. |
| 12 | **Plugin isolation = container contract** (deferred to P4). A plugin step is a container with a JSON stdin→stdout I/O contract (schema'd via the StepDefinition manifest), reusing the existing ephemeral-container infra (`ephemeralContainer.ts`) — untrusted code never runs in the worker process. WASM/sidecar are explicitly rejected for v1. |
| 13 | **Layered abstractions, one execution model.** Canvas, declarative JSON, and the future SDK are three *authoring surfaces* over the same `WorkflowTemplate` spec + StepRegistry. No surface gets a private execution path. |
| 14 | Node types stay as-is (the 11 are domain-agnostic). The **declarative agent step is a new node type** `agent` (not a new `step` name), because it carries an inline `AgentSpec` rather than referencing a registered activity. |
| 15 | MCP becomes **role-agnostic and node-capable**: `'mcp'` is accepted in the tool-config enum for any role; MCP server config moves from per-`Repository` to a per-`Connection` of type `mcp`; an `mcp` *node* can call a single MCP tool as a workflow step. |
| 16 | Scanner patterns, skills, and seed rows are **pack-tagged** (`pack` column). `syncBuiltins` becomes per-pack `register()`; the admin "Seed defaults" button becomes per-pack. |
| 17 | The **SWE pack is extracted in P0 before any engine refactor**, even though there's only one pack, to force the platform/app boundary to become explicit and reviewable in isolation. |

> Decisions are append-only; supersede with a new row rather than editing in place once a phase ships.

---

## Core concepts (design detail)

### Packs
A pack is a TypeScript module exporting a manifest and a `register(ctx)` hook:

```ts
interface PackManifest {
  id: string;                 // 'swe'
  version: string;            // semver
  displayName: string;
  roles: RoleDecl[];          // { key, description, defaultModelSpec, skills[], tools[], outputSchema? }
  stepDefinitions: StepDef[]; // { name, kind, inputSchema, outputSchema, executor }
  connectionTypes: ConnTypeDecl[];
  skills: BuiltinSkillDef[];  // moved out of packages/shared/src/skills
  scannerPatterns: ScannerPatternDef[];
  templates: TemplateSeed[];  // versioned WorkflowSpec JSON
  memoryScopes: string[];     // declared namespaces
  triggers?: TriggerAdapter[]; // P3
}
```

`register(ctx)` is called at worker/gateway boot. For the worker it wires `stepDefinitions`
into the `StepRegistry`; for the gateway it exposes step/role/connection metadata + trigger
routes. `seed` upserts pack rows (idempotent, pack-tagged), generalizing today's `syncBuiltins`.

Initially a static, in-repo pack list (SWE only). The registry, manifest schema, and `pack`
discriminator columns are introduced now so third-party / dynamic install (P4) is additive.

### AgentSpec resolver
The single chokepoint for "run an agent":

```
resolveAgentSpec(input: { roleKey: string } | { inline: InlineAgentSpec }, ctx): AgentSpec
```

- `roleKey` → cascade `ModelRoleConfig` lookup + `loadAgentSkills` + `loadAgentToolConfig`.
- `inline` → validate + use directly (the declarative `agent` node path).

A generic `runAgent(spec, input, tracer)` activity executes any `AgentSpec` against a Mastra
`Agent`, with `AgentTracer` + cost tracking. SWE's bespoke activities (`executeImplementation`,
`runReviewNetwork`, …) become **thin pack-owned wrappers** over `runAgent` (or remain bespoke
where they do more than a single agent turn, e.g. the review network), registered as
`builtin`-kind step definitions in the SWE pack.

### Connections (replaces Repository)
```
Connection { id, teamId?, type, name, config Json, credentialRef? }
```
`type` is pack-declared (SWE: `git_repo`; future: `database`, `http_api`, `mcp`, …). SWE
repo-specific fields (`gateCommands`, default branch, GitHub coordinates, `mcpServerRef`) live
in `config` or a `pack-swe` satellite table keyed by `connectionId`. `mcpServerRef` is itself
replaced by a first-class `Connection` of type `mcp`.

### Generic run input & triggers
A template declares `inputSchema`. A **trigger** maps an inbound payload → that schema and
starts a run. Core ships `manual`/API + `schedule`; packs ship adapters (SWE: GitHub webhook,
Jira/Linear ticket fetch). `WorkRequest` → generic `RunInput` persisted on the run; SWE's
ticket/PR/context-snapshot models become `pack-swe`-owned tables.

### Generic memory
`AgentLesson` → `MemoryItem { scope, tags Json, text, embedding vector(1536), … }`. Retrieval
filters by `scope` + optional tag predicates, then pgvector ANN. SWE writes
`scope='swe', tags={ repo, failureType }`.

---

## Phase Status

| Phase | Status | Slice |
|---|---|---|
| **P0. Extract SWE into a pack** | Planned | Move SWE steps/roles/skills/scanners/templates/integration into `pack-swe`; introduce pack manifest + `register()` + `pack` columns. No behavior change. |
| **P1. Data-driven step registry + dynamic roles** | Planned | Replace `dispatchStepImpl` switch with `StepRegistry`; delete `AgentRole` enum (→ string); `AgentSpec` resolver + generic `runAgent`; computed `assertConfigReady`; decouple cost pricing from roles. |
| **P2. Declarative agent step + finish MCP** | Planned | New `agent` node (inline `AgentSpec`); generic agent-run loop on canvas; `'mcp'` tool enum + `mcp` Connection + `mcp` node. The no/low-code tiers. |
| **P3. Generic triggers/inputs + connections + memory** | Planned | `Connection` replaces `Repository`; template `inputSchema` + generic `RunInput`; generic trigger adapters; `MemoryItem` replaces `AgentLesson`. SWE specializes all three. |
| **P4. Plugin SDK + pack registry** | **Deferred (spec'd below)** | Container-contract coded steps; pack install/versioning/RBAC; authoring SDK; security review. |
| **P5. UX layering + multi-org** | **Deferred (spec'd below)** | Canvas palette for new node kinds; SDK polish; true multi-tenancy on the `orgId` stub. |

---

## P0 — Extract SWE into a pack (no behavior change)

**Goal:** make the platform/app boundary explicit before refactoring the engine. After P0 the
engine still hardcodes nothing *new*, but all SWE-specific definitions live behind a pack
manifest and `pack` discriminator, so P1's engine changes have a clean target.

### What ships
- New workspace `packages/pack-swe/` (or `packages/packs/swe/`) exporting `PackManifest` +
  `register()`.
- Pack-infra in core: `PackManifest`/`StepDef`/`RoleDecl` types (`packages/shared/src/pack/`),
  a static `INSTALLED_PACKS = [swePack]` list, and a `register()` invocation at gateway + worker
  boot (initially a no-op shim that simply re-points existing wiring through the pack).
- **Moves** (no logic change):
  - `packages/shared/src/skills/*` + `index.ts` (`BUILTIN_SKILLS`) → `pack-swe`.
  - SWE scanner patterns from `packages/shared/src/scannerPatterns/` → `pack-swe` (core keeps the
    `ScannerPattern` table + loader; built-ins become pack-provided).
  - SWE templates seeded in `seed.ts` → `pack-swe` template seeds.
  - SWE role/skill/tool/model-default seeding (`syncBuiltins`) → `pack-swe.register().seed`.
- **Schema:** add nullable `pack String?` to `Skill`, `ScannerPattern`, `WorkflowTemplate`,
  `ModelRoleConfig`, `AgentSkillAssignment`, `AgentToolConfig` (default `'swe'` for migrated
  rows; `null`/`'core'` for engine-owned). Since there's no back-compat requirement, migrations
  are consolidated rather than additive.

### Decouplability checks
- `packages/shared` no longer imports any SWE skill text; `grep` for skill names returns only
  `pack-swe`.
- Worker boot calls `swePack.register(ctx)` exactly once; no SWE step names appear outside the
  pack except in `dispatchStepImpl` (which P1 deletes).

### Files touched (recap)
`packages/pack-swe/**` (new), `packages/shared/src/pack/*` (new), `packages/shared/src/skills/**`
(deleted/moved), `packages/shared/src/scannerPatterns/**` (moved), `packages/shared/src/prisma/seed.ts`,
`packages/shared/src/lib/syncBuiltins.ts`, `schema.prisma` (pack columns), worker + gateway boot.

### Tests
- Pack-load test: `register()` seeds the same rows the old `syncBuiltins` did (snapshot parity).
- Existing workflow/interpreter/activity suites pass unchanged (proves zero behavior change).

---

## P1 — Data-driven step registry + dynamic roles

**Goal:** delete the two deepest SWE couplings — the `dispatchStepImpl` switch and the
`AgentRole` enum — and introduce the `AgentSpec` resolver + generic `runAgent`.

### What ships
- **StepRegistry** (`packages/worker/src/lib/stepRegistry.ts`): `Map<stepName, StepExecutor>`
  populated by `register()`. `dispatchStepImpl` (`runnable.ts:320–473`) becomes a registry lookup;
  unknown step → typed error. The shared `stepRegistry.ts` metadata catalog (gateway/web) gains a
  `pack` field per step.
- **Role = string** everywhere. Delete the Prisma `AgentRole` enum (`schema.prisma:47–60`);
  change `ModelRoleConfig.role`, `AgentSkillAssignment.agentRole`, `AgentToolConfig.agentRole`,
  `AgentTrace.agentRole` to `String`. Delete `ROLE_TO_PRISMA`/`ALL_ROLES` (`config/types.ts`);
  replace with pack-declared role lists.
- **`AgentSpec` resolver** (`packages/worker/src/lib/config/agentSpec.ts`): unifies
  `resolveModelConfig` + `loadAgentSkills` + `loadAgentToolConfig` into one normalized spec; also
  accepts an inline spec (used by P2's `agent` node).
- **Generic `runAgent` activity**: executes any `AgentSpec` (Mastra agent + tools + tracer +
  cost). SWE's `executeImplementation`/review-network/etc. are re-expressed as pack `builtin`
  step executors that call `runAgent` or keep their bespoke multi-turn logic — registered, not
  switched.
- **Computed `assertConfigReady`** (`config/assertReady.ts`): required roles =
  `union(installedPacks.flatMap(p => p.roles.map(r => r.key)), activeTemplateSpecs.referencedRoles)`.
  Walks that set against `ModelRoleConfig` GLOBAL rows + credentials. Embedding check unchanged.
- **Cost pricing decoupled** (`costTracking.ts`): pricing already spec-keyed; remove any
  role→price assumptions, keep `role` purely as a telemetry/attribution dimension on
  `recordLlmUsage`.

### Decouplability checks
- `grep -r "AgentRole" packages/shared packages/worker/src/lib` → no enum references in core.
- Adding a hypothetical second pack with a `summarizer` role requires **zero** core edits — only a
  manifest entry + a GLOBAL `ModelRoleConfig` row.

### Files touched (recap)
`runnable.ts` (switch → registry), `config/types.ts`, `config/assertReady.ts`,
`config/agentSpec.ts` (new), `costTracking.ts`, `schema.prisma` (enum→string), `pack-swe` (register
its steps/roles as data), worker boot.

### Tests
- Registry: unknown step name → error; pack-registered step dispatches.
- `assertConfigReady`: passes with exactly the union present; fails fast on a missing pack role;
  ignores roles no installed pack/active template needs.
- `AgentSpec` resolver: role-key path matches today's cascade output; inline path round-trips.
- Cost: pricing identical pre/post (snapshot) regardless of role string.

---

## P2 — Declarative agent step + finish MCP

**Goal:** ship the two no/low-code extension tiers.

### What ships
- **`agent` node type** (`packages/shared/src/workflow/spec.ts`, extend `NodeSchema`): carries an
  inline `AgentSpec` (model spec or role ref, system prompt, `skills[]`, `tools[]`, `inputSchema`,
  `outputSchema`, `memoryScope`). Interpreter dispatches it via the dispatcher to the generic
  `runAgent`. Canvas inspector + step-registry metadata gain the node.
- **MCP completion:**
  - Add `'mcp'` to the tool enum (`IMPLEMENTER_TOOL_IDS`/shared tool list +
    `gateway/.../skillAssignmentService.ts` mirror) — valid for *any* role.
  - MCP server config moves from `Repository.mcpServerRef` to a first-class `Connection` of type
    `mcp`; `loadMcpTools` resolves from the connection.
  - New **`mcp` node**: call a single named MCP tool as a workflow step (schema'd I/O), distinct
    from MCP-as-agent-tools.
- Canvas palette gains `agent` + `mcp` nodes (minimal; full palette polish is P5).

### Decouplability checks
- A user can build a working two-`agent`-node workflow with an MCP toolserver and **no code and no
  pack** — purely template JSON / canvas.

### Files touched (recap)
`spec.ts` (+`agent`,`mcp` nodes), `interpreter.ts` (dispatch), `runnable.ts` (executors),
`mcpTools.ts` (connection-resolved, role-agnostic), tool enums (shared + gateway), web canvas
inspector + palette, `schema.prisma` (`mcp` connection type usage).

### Tests
- Interpreter: `agent` node resolves inline spec → `runAgent`; `mcp` node calls one tool.
- MCP: `'mcp'` accepted in config for a non-implementer role; tools load from an `mcp` Connection.
- E2E (test env): template with two `agent` nodes + a `cond` runs to completion with fake models.

---

## P3 — Generic triggers/inputs + connections + memory

**Goal:** decouple the remaining SWE-shaped schema; SWE specializes via the pack.

### What ships
- **`Connection` model** replaces `Repository`. `pack-swe` owns a `git_repo` connection type +
  satellite config (gate commands, branch, GitHub coords). `ActiveWorkflow`/runs reference
  `connectionId`. `Repository`, `mcpServerRef`-on-repo removed.
- **Template `inputSchema` + generic `RunInput`.** `WorkRequest` removed; runs carry a typed
  `RunInput` validated against the template's declared schema. SWE template declares
  `{ ticketId, connectionId, description, budget }`. `ContextSnapshot`/`PullRequest` become
  `pack-swe` tables.
- **Generic triggers.** Core: manual/API + `schedule`. `pack-swe`: GitHub webhook adapter +
  Jira/Linear ticket-fetch adapter (mapping payload → SWE input schema). Trigger registration is
  part of `register()`.
- **`MemoryItem` replaces `AgentLesson`** (`scope` + `tags Json` + `embedding`). `recordLesson*`
  → `recordMemory*`; retrieval filters by scope/tags then pgvector. SWE uses
  `scope='swe', tags={repo,failureType}`.

### Decouplability checks
- A non-SWE template can declare its own `inputSchema`, bind a non-`git_repo` `Connection`, fire
  from a `schedule` trigger, and read/write `MemoryItem` under its own scope — **no core code
  paths assume tickets, repos, PRs, or failure types.**

### Files touched (recap)
`schema.prisma` (Connection, RunInput, MemoryItem, drop Repository/WorkRequest/AgentLesson; SWE
satellite tables in pack migration), gateway routes (connections, triggers, run-submit),
`pack-swe` (git_repo type, GitHub/Jira adapters, SWE tables), memory lib, web (connections UI,
generic submit form driven by inputSchema).

### Tests
- Connection CRUD + SWE `git_repo` specialization.
- Run-submit validates payload against template `inputSchema`; rejects mismatches.
- Trigger adapter maps a sample GitHub/Jira payload → SWE input.
- Memory: scope/tag filtering + pgvector retrieval parity with old lesson queries.

---

## P4 — Plugin SDK + pack registry (DEFERRED — full spec)

**Goal:** third-party **coded** steps and installable packs, safely. Deferred for build, but the
P0–P3 abstractions (pack manifest, StepRegistry, StepDefinition kinds incl. `plugin`, container
infra, `pack` columns) are introduced earlier specifically so this is **purely additive**.

### Design
- **Isolation — container contract** (Decision 12). A `plugin`-kind StepDefinition declares a
  container `image`, an `inputSchema`, an `outputSchema`, resource limits, required
  connections/secrets, and an egress allowlist. Execution reuses `ephemeralContainer.ts`: the
  interpreter serializes the step input to JSON on stdin, runs the container
  (`--rm --read-only --cap-drop=ALL --network=none|egress`, named-volume workspace as in
  Decision 27/30), and parses validated JSON from stdout. **No plugin code runs in the worker
  process.** Failures and non-conforming output are typed errors, audited like shell steps.
- **Authoring SDK** (`packages/sdk/`): TypeScript helpers to define a `PackManifest`,
  `StepDefinition`s (incl. plugin contracts), roles, skills, and templates programmatically, with
  Zod schema export + local test harness. This is the third authoring surface (Decision 13).
- **Pack registry & install:** versioned, optionally signed pack artifacts; an install flow
  (admin/team-scoped) that runs `register().seed` transactionally and records provenance; RBAC on
  who may install (platform ADMIN for GLOBAL, team ADMIN for TEAM). `INSTALLED_PACKS` becomes
  DB-backed rather than a static array.
- **Security review:** plugin images are untrusted — egress default `none`, secret injection is
  per-declared-connection only, image allowlist per Decision 28, full `WorkflowShellAudit`-style
  audit per plugin run, and a content/static scan of pack manifests at install (reusing the
  scanner-pattern infra).

### Open questions to resolve before building P4
- Pack artifact format & distribution (OCI image? tarball + lockfile? npm?) and signing/trust.
- Plugin contract transport: stdin/stdout JSON (simple) vs a sidecar HTTP/gRPC service (streaming,
  long-running) — start with stdin/stdout.
- Secret scoping & rotation for plugin-required connections.
- Cross-process cache invalidation when an install changes pack rows (today TTL-only).

### Files (anticipated)
`packages/sdk/**` (new), `packages/shared/src/pack/registry.ts` (DB-backed), gateway install
routes + RBAC, worker `plugin`-kind executor over `ephemeralContainer.ts`, `schema.prisma`
(`InstalledPack`, `PackInstallAudit`), web `/admin/packs`.

---

## P5 — UX layering + multi-org (DEFERRED — full spec)

**Goal:** complete the layered-abstraction UX and true multi-tenancy.

### Design
- **Canvas palette** for all new node kinds (`agent`, `mcp`, `plugin`) with schema-aware
  inspectors; pack-provided step metadata drives a categorized palette.
- **SDK polish:** scaffolding CLI (`auto-swe pack init`), local pack dev-loop, publish flow.
- **Multi-org / true multi-tenancy:** promote the `orgId` stub to a first-class tenant boundary —
  org-scoped connections, packs, templates, roles, billing/budget, and RBAC. Today's
  team/global scopes nest under org.
- **Pack marketplace surface** (optional): browse/install first- and third-party packs from the
  dashboard.

### Open questions to resolve before building P5
- Org ↔ team ↔ global scope cascade interaction with the existing 3-level config cascade (becomes
  4-level?).
- Per-org data isolation strategy (row-level vs schema-per-tenant) — likely row-level given
  Postgres + Prisma.
- Billing/budget rollup at org granularity.

---

## Resolved open questions (from RFC discussion)

| Question | Resolution |
|---|---|
| Roles: fixed taxonomy vs fully dynamic? | **Fully dynamic** — opaque string keys + `AgentSpec` resolver; `AgentRole` enum deleted (Decisions 1–3). Compile-time safety traded for Zod-validated pack manifests at install/seed time. |
| Generalize `Repository` now or add `Connection` alongside? | **Generalize now** — `Connection` replaces `Repository` in P3 (Decision 7); no shim. |
| Plugin isolation model? | **Container contract** reusing ephemeral-container infra (Decision 12); WASM/sidecar rejected for v1. |
| Backward compatibility? | **None required** — undeployed; consolidate/rewrite migrations for the target shape (Decision 8). |
| Phasing? | **Build P0–P3; fully document P4–P5** (this doc). Abstractions for P4–P5 are introduced in P0–P3 so deferred work is additive. |

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope creep — four tiers + three audiences + multi-org is large | P0–P3 is a credible standalone product ("durable agent orchestrator with SWE as flagship pack"). P4–P5 gated behind P0–P3 proving the platform shape. |
| Deleting `AgentRole` enum loses compile-time safety | Pack manifests are Zod-validated at boot/install; `assertConfigReady` fails fast on missing roles; integration tests cover the union computation. |
| Big-bang schema rewrite (no back-compat) | Allowed by Decision 8 (undeployed). Consolidate migrations; rely on the existing test suites (interpreter/workflow/activity) as the behavior contract through each phase. |
| SWE pack extraction churn | P0 is explicitly *no behavior change* with snapshot-parity tests, isolating the move from the engine refactor. |
| Plugin step = untrusted code surface (P4) | Container isolation, egress-default-none, per-connection secret scoping, manifest scanning, full audit — none of which run plugin code in-process. |
| Cross-process pack-row cache invalidation | Inherited TTL-only model (60s); acceptable for P0–P3; revisited in P4 when installs mutate rows at runtime. |

---

## How this maps onto today's code (current-state coordinates)

For implementers — the precise hardcoding points each phase targets:

- **Step switch:** `packages/worker/src/workflows/runnable.ts:320–473` (`dispatchStepImpl`) → P1
  registry. `Dispatcher` interface seam at `runnable.ts:229` is preserved.
- **Role enum:** `packages/shared/src/prisma/schema.prisma:47–60`;
  `packages/worker/src/lib/config/types.ts:17–67` (`ALL_ROLES`, `ROLE_TO_PRISMA`);
  `packages/worker/src/lib/config/assertReady.ts:18–103` → P1.
- **Cost:** `packages/worker/src/lib/costTracking.ts:35–65,148–252` (already spec-keyed) → P1
  cleanup only.
- **Domain models:** `schema.prisma` — `WorkRequest` (356–383), `ContextSnapshot` (136–146),
  `PullRequest` (148–162), `Repository`, `AgentLesson` → P3 (move to `pack-swe`) / `Connection` /
  `MemoryItem`. Generic core models (`WorkflowTemplate` 567–609, `WorkflowRun` 455–482,
  `WorkflowStep` 514–530, `AgentTrace` 489–510) stay.
- **Node types:** `packages/shared/src/workflow/spec.ts:306–330` (11 types, all generic) →
  P2 adds `agent` + `mcp`.
- **MCP:** `packages/worker/src/agents/mcpTools.ts` (`MCP_TOOL_KEY`, `loadMcpTools`),
  `Repository.mcpServerRef` (`schema.prisma:196`), enums in `stepRegistry.ts` +
  `gateway/src/lib/skillAssignmentService.ts` → P2.
- **Container infra (plugin basis):** `packages/worker/src/lib/ephemeralContainer.ts`,
  `packages/worker/src/activities/shellStep.ts` → reused by P4.
- **Skills/seed/scanners:** `packages/shared/src/skills/`, `prisma/seed.ts`,
  `lib/syncBuiltins.ts`, `scannerPatterns/` → P0 move into `pack-swe`.
