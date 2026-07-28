# P0 — De-domainify the engine (implementation epic)

> **Frozen.** Point-in-time document, preserved for design rationale. It is not maintained: the code and the current references in [`docs/`](../README.md) are authoritative wherever they diverge.

> **Status: ✅ Complete — historical build plan (archived).** Preserved for design rationale; current state lives in [architecture.md](../architecture.md), [agents.md](../agents.md), and [STATUS.md](./STATUS.md).

Companion to [`platform-pivot.md`](./platform-pivot.md) (rev. 2). This is the build plan for
**Phase P0**: remove every hardcoded SWE assumption from the engine so it is domain-agnostic,
**with no behavior change**. SWE survives as *seed content* tagged `origin='swe-starter'`.

> P0 introduces **no new user-facing features**. It is a structural refactor whose success
> criterion is: *every existing test stays green, and the engine boots & runs with zero SWE
> content present.*

---

## Outcomes (definition of done)

1. **No `AgentRole` enum.** Agent identity is an opaque `String` end-to-end (schema + worker types).
2. **Registry-driven dispatch.** The `dispatchStepImpl` switch is replaced by a static
   `StepRegistry`; adding a step is a registry entry, not a switch edit.
3. **`AgentSpec` resolver** unifies model + skills + tools resolution behind one call; a generic
   **`runAgent`** activity exists and is proven on one low-risk activity.
4. **Computed `assertConfigReady`** validates the *union of agent keys the registered executors
   require*, not a fixed `ALL_ROLES` list.
5. **Cost is identity-agnostic** — pricing keys off the resolved `provider/model` spec only.
6. **SWE content is tagged `origin`**; cross-cutting scanner patterns are **core defaults**.
7. **Parity:** the full existing test suite is green, plus a new **"core-only boot"** test proves
   the engine runs with no SWE seed content.

## Non-goals (explicitly deferred)

- The first-class **`Agent` entity** / Agent library → **P1**.
- The declarative **`agent` node** + MCP completion → **P2**.
- **`Connection`** replacing `Repository`, generic inputs/triggers, `MemoryItem` → **P3**.
- Rewiring *every* SWE activity onto `runAgent` (only a proof-migration in P0; the rest stay as
  registered bespoke executors and migrate opportunistically later).
- Any distribution/bundle concept → **P4**.

## The guiding constraint: no behavior change

P0 is judged by **parity**. These suites are the behavior contract and must stay green
unmodified except where a rename forces a mechanical edit:

- `packages/shared/src/workflow/interpreter.test.ts`, `interpreter.hitl.test.ts`, `spec.test.ts`,
  `workflow/examples/*.test.ts`
- `packages/worker/src/workflows/runnable.workflow.test.ts`
- `packages/worker/src/lib/config/{resolver,assertReady,cache}.test.ts`
- `packages/worker/src/activities/{implementerSession,decomposition,templates,qualityGates,consolidateLessons}.test.ts`
- `packages/worker/src/lib/{costTracking,codeSecurityScanner,sensitiveFileScanner,shellCommandScanner,models}.test.ts`

New tests are additive (see each workstream).

---

## Workstreams

Ordered for low-risk landing. Each is independently reviewable.

### WS1 — Agent identity: enum → string
**Why:** the `AgentRole` enum is the deepest SWE coupling; everything else keys off it.

**Files**
- `packages/shared/src/prisma/schema.prisma:47–60` — delete `enum AgentRole`. Change `role`/`agentRole` columns to `String` on `ModelRoleConfig` (`:625`), `AgentSkillAssignment` (`:952`), `AgentToolConfig` (`:976`). `AgentTrace.agentRole` (`:495`) is already `String`.
- `packages/worker/src/lib/config/types.ts:3–67` — delete `PrismaAgentRole`, `ROLE_TO_PRISMA`, `PRISMA_TO_ROLE`. `AgentRole`/`SkillOnlyRole`/`AnySkillRole` collapse to `string` (keep an exported `const KNOWN_AGENT_KEYS` array + a `type AgentKey = string` for readability, **not** for enforcement).
- `packages/worker/src/lib/config/resolver.ts:26–146` — `resolveModelConfig` queries by the role string directly (drop `ROLE_TO_PRISMA[role]`).
- `packages/worker/src/lib/config/agentSkills.ts` — `loadAgentSkills`/`loadAgentToolConfig` take `string`.
- `packages/worker/src/lib/models.ts`, `costTracking.ts` — `AgentRole` params become `string`.
- `packages/shared/src/lib/syncBuiltins.ts:52–132` + `packages/shared/src/skills/*` — seed writes the canonical key. **4 skill files hardcode `UPPER_SNAKE` in `assignments`** (`securityReviewDepth.ts`, `domainLogicIntegrity.ts`, `performanceImpactAssessment.ts`, `subtaskDecomposition.ts`) — update them.

> ⚠️ **Correction from review.** WS1 is bigger than "the worker already uses camelCase." There is a **casing split**: the worker is camelCase, but the gateway, web, skill-defs, and tests all use `UPPER_SNAKE`. The schema change alone will break routing + UI unless these are updated in the **same PR**:
> - **Gateway (Zod route validation):** `packages/gateway/src/lib/skillAssignmentService.ts` (`SKILL_AGENT_ROLES`, 10 values, `SkillAgentRole`, `getAgentRolesOverview`), `packages/gateway/src/lib/modelConfigService.ts` (`MODEL_AGENT_ROLES`, `DEFAULT_ROLE_SPECS`, `ModelAgentRole`), `packages/gateway/src/routes/skills.ts` (`z.enum(SKILL_AGENT_ROLES)`, `AgentRoleParams`, `:role` routes).
> - **Web:** `packages/web/src/lib/agentRoles.ts` (`AGENT_ROLES`, `AgentRoleKey`, `ROLE_LABELS`, `ROLES_WITH_TOOLS`), `packages/web/src/hooks/useModelConfig.ts` (`ModelRole`, `MODEL_ROLES`), `packages/web/src/lib/rolePromptDefaults.ts`, components `components/agents/AgentConfigSection.tsx`, `components/templates/TemplateAgentSkillsSection.tsx`, `components/teams/TeamAgentSkillsSection.tsx`, pages `app/admin/agents/page.tsx` + `app/admin/agents/[role]/page.tsx`.
> - **Shared export:** `packages/shared/src/index.ts:4` re-exports the generated enum — remove.
> - **Tests:** `packages/worker/src/lib/config/assertReady.test.ts` (`ALL_PRISMA_ROLES`), gateway route tests, web fixtures.

**Prerequisite (blocking):** decide the **one canonical casing** before any code moves. Recommend **camelCase** (`implementer`, `securityReviewer`, …) everywhere — DB column values, gateway enums, web labels' keys, skill-def assignments, seed. This is a one-time decision the whole PR depends on.

**Approach:** since the system is undeployed (no back-compat), consolidate the Prisma migration — change the column type to text and drop the enum. Then sweep all `UPPER_SNAKE` surfaces above to the canonical casing in the same PR. Gateway enums become a small shared `const KNOWN_AGENT_KEYS` (still validates inbound `:role`, just not a Prisma enum); web reads labels keyed by the same const.

**Acceptance:** `grep -ri AgentRole packages/` returns nothing (incl. gateway/web); `yarn typecheck` + `yarn build` clean across **all** packages; `resolver.test.ts`, `assertReady.test.ts`, gateway route tests green; config rows keyed by the canonical string; seed produces the same logical rows; the web admin/agents pages and `:role` routes still resolve.

**Gotcha:** the partial unique indexes on `AgentSkillAssignment`/`AgentToolConfig` are unaffected (string key occupies the same column). Regenerate the Prisma client after the enum drop. Watch the **config cache key** (`config/cache.ts`) — it embeds the role string; verify keys still resolve post-casing-change.

---

### WS2 — Step registry replaces the dispatch switch
**Why:** removes the hardcoded step→activity switch; establishes the dispatch seam.

**Files**
- New `packages/worker/src/workflows/stepRegistry.ts` (or inline in `runnable.ts`) — a module-level `Map<string, StepExecutor>`.
- `packages/worker/src/workflows/runnable.ts:320–473` — replace `dispatchStepImpl`'s switch with a registry lookup; unknown step throws the same typed error as today's `default`. The activity-proxy groups (`:34–165`) stay; they're *registered* into the map instead of referenced by `case`.

**Approach:** build the registry **statically at module load** inside the workflow file. `proxyActivities(...)` is legal at workflow module top-level (deterministic stubs, no I/O), so the map is populated eagerly — satisfying the V8 isolate constraint. Each entry is `stepName → (args) => proxy.activity(args)`, mirroring the current `case` bodies exactly. No DB-driven/dynamic registration in P0.

**Acceptance:** `runnable.workflow.test.ts` green; `dispatchStepImpl` contains no `switch`; behavior identical.

**Gotcha (V8 isolate):** the registry must be a static in-isolate structure. Do **not** attempt to fetch step definitions from the DB inside the workflow — that's dynamic-plugin territory (P4), out of scope here.

---

### WS3 — `AgentSpec` resolver + generic `runAgent` (foundation)
**Why:** one normalized resolution path for "run an agent," used by the P2 `agent` node and by future Agents.

**Files**
- New `packages/worker/src/lib/config/agentSpec.ts` — `resolveAgentSpec(input: { agentKey: string } | { inline: InlineAgentSpec }, ctx): Promise<AgentSpec>`, composing the existing `resolveModelConfig` + `loadAgentSkills` + `loadAgentToolConfig` + `skillsToPromptSuffix` into one normalized `{ modelSpec, systemPrompt, skills, tools, outputSchema?, memoryScope? }`.
- New `packages/worker/src/activities/runAgent.ts` — a generic Mastra agent loop driven by an `AgentSpec`, with `AgentTracer` + `recordLlmUsage`.
- Proof-migration: re-implement **`validateContext`** (`activities/validateContext.ts`) on top of `resolveAgentSpec`/`runAgent`.

**Approach:** the resolver must return byte-identical model/skills/tools to today's per-call resolution (it just wraps the same functions). Keep bespoke multi-turn activities (`implementerSession`, `runReviewNetwork`, fix loops) **as-is**, registered in WS2 — they migrate opportunistically post-P0. `runReviewNetwork`'s sub-reviewers keep resolving the `reviewer` model + their own skill keys exactly as today (`runReviewNetwork.ts:22–29`, `agents/reviewNetwork.ts:54–55`).

**Acceptance:** new `agentSpec.test.ts` asserts resolver output equals the legacy path; `validateContext` parity test green (same trace + output shape); `runAgent` unit-tested.

**Note:** `runAgent` becomes the workhorse for the P2 `agent` node — in P0 it just needs one real caller to avoid dead code.

---

### WS4 — Computed `assertConfigReady`
**Why:** boot validation must reflect *what's actually used*, not a fixed list.

**Files**
- `packages/worker/src/lib/config/assertReady.ts:18–103` — replace the `ALL_ROLES` loop with a computed set.
- Step executors (WS2 registry entries) optionally declare `requiredAgents: string[]` (the agent keys they resolve a model for).

**Approach:** required set = `union(registeredExecutors.flatMap(e => e.requiredAgents))`. Validate each has a GLOBAL `ModelRoleConfig` + resolvable credential (same per-row logic as today). Embedding-config check unchanged. Agent keys no registered executor needs are ignored.

> **Forward note (degrade-don't-crash).** In P0 the required set is computed from *static* registered executors, so a missing binding is a legitimate hard boot failure (same as today). But once P1/P2 let **templates** reference arbitrary `agentRef`s, computing the required set from mutable template content means a bad template edit could prevent the worker from booting. Design the validator now so that path can later **fail the offending template, not the whole worker** — keep the "referenced by a registered executor" set as the hard-fail set, and treat template-referenced agents as a separate, non-fatal validation surface.

**Acceptance:** `assertReady.test.ts` updated — passes with the computed union; fails fast on a missing GLOBAL row for a *required* (executor-declared) key; ignores unused keys.

---

### WS5 — Cost decoupling
**Why:** confirm pricing never depends on a fixed identity set.

**Files**
- `packages/worker/src/lib/costTracking.ts:148–252` — `recordLlmUsage` param typed as `string` (attribution only); pricing path stays `getModelSpec → getModelPrice(spec)` (already spec-keyed, `:35–65,95–109`).

**Approach:** mostly a type change + a comment asserting the invariant. No pricing logic change.

**Acceptance:** `costTracking.test.ts` green; pricing snapshot identical.

---

### WS6 — Content provenance + scanner reclassification
**Why:** make SWE content distinguishable/removable and promote cross-cutting scanners to core.

**Files**
- `schema.prisma` — add nullable `origin String?` to `Skill`, `ScannerPattern`, `WorkflowTemplate`, `ModelRoleConfig`, `AgentSkillAssignment`, `AgentToolConfig`.
- `packages/shared/src/scannerPatterns/index.ts` — tag `INJECTION` / `EXFILTRATION` / `SHELL_COMMAND` / `SENSITIVE_FILE` as **core defaults** (`origin=null`); tag `CODE_SECURITY` as `origin='swe-starter'`.
- `packages/shared/src/lib/syncBuiltins.ts:17–132` — split seeding into `seedCoreDefaults()` (always) and `seedSweStarter()` (tagged `'swe-starter'`); skills/templates/role-config/assignments seeded by the latter carry the tag. Behavior identical (everything still seeded) — just tagged and grouped.

**Approach:** no content is deleted in P0; this is tagging + grouping so a future deployment can opt out of SWE content. The cross-cutting scanners becoming `origin=null` means they survive a "core-only" seed.

**Acceptance:** seeded rows carry correct `origin`; all scanner tests green; **new `coreOnlySeed.test.ts`** seeds only core defaults and asserts: engine boots (`assertConfigReady` passes with no SWE agents required), cross-cutting scanners are present, and no SWE skills/templates exist. *This is the headline proof of de-domainification.*

---

## PR slicing

| PR | Workstream(s) | Risk | Notes |
|---|---|---|---|
| 1 | WS1 (+ WS5) | Med | Big but mechanical; the rename + migration. Land first — everything rebases on it. |
| 2 | WS2 | Low | Switch → registry; isolated to `runnable.ts`. |
| 3 | WS4 | Low | Computed boot check; depends on WS2's `requiredAgents`. |
| 4 | WS3 | Med | Resolver + `runAgent` + `validateContext` proof-migration. |
| 5 | WS6 | Low | Provenance tags + scanner reclassification + core-only seed test. |

---

## Risks & gotchas (from the current-state survey)

1. **V8 isolate / no async in workflows.** The step registry is a *static* module-level map built from `proxyActivities` — never fetched at runtime. (WS2)
2. **Enum → string migration.** Consolidate the migration; commit to **camelCase** as the one canonical key casing and align seed + resolver + assignments. (WS1)
3. **Sub-role model inheritance is implicit.** `runReviewNetwork` sub-reviewers resolve the `reviewer` model + their own skill keys. Preserve exactly — don't "fix" it in P0. (WS3)
4. **Partial unique indexes** on `AgentSkillAssignment`/`AgentToolConfig` are unaffected by enum→string (same column, now text). (WS1)
5. **Config cache** (`config/cache.ts`) is keyed by role string — verify keys still resolve after the casing decision. (WS1)
6. **Don't over-reach into P1.** Resist consolidating the three config tables into an `Agent` entity here — that's P1 and would break parity scope.

---

## Sequencing checklist

**Status: ✅ complete — all work-streams merged into the pivot branch.**

- [x] WS1 — `AgentRole` enum deleted; identity is string; seed uses camelCase keys
- [x] WS5 — `recordLlmUsage` identity-agnostic (fold into WS1 PR)
- [x] WS2 — `StepRegistry` replaces `dispatchStepImpl` switch
- [x] WS4 — `assertConfigReady` computed from registered executors' `requiredAgents`
- [x] WS3 — `resolveAgentSpec` + `runAgent`; `validateContext` migrated as proof
- [x] WS6 — `origin` tags; cross-cutting scanners → core defaults; **core-only boot test green**
- [x] Full existing suite green; new tests (`agentSpec`, `coreOnlySeed`) added
