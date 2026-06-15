# Platform Pivot — P1 Epic: Agent Library (first-class, reusable, governed)

> Build plan for **Phase P1** of the [platform pivot](./platform-pivot.md). P1 makes Agents
> **real, reusable objects** users create, version, govern, and share across templates — instead of
> three disconnected per-role config tables. It supersedes the `SkillOnlyRole` concept.
>
> Parent RFC: [`platform-pivot.md`](./platform-pivot.md) §P1 · diagrams:
> [`platform-pivot-diagrams.md`](./platform-pivot-diagrams.md) §5 (agent resolution snapshot).
> Predecessor: [`platform-pivot-p0.md`](./platform-pivot-p0.md) (the `AgentSpec`/`runAgent`
> foundation P1 plugs into).

---

## Outcomes (definition of done)

1. **`Agent` is a first-class entity.** One versioned row consolidates what `ModelRoleConfig` +
   `AgentSkillAssignment` + `AgentToolConfig` express today (model spec, system prompt, skills,
   tools), addressable by a stable `key`.
2. **Reference + reuse.** Templates and steps reference an Agent by `agentRef: "<key>"` (float) or
   `"<key>@<version>"` (pin); a one-off inline AgentSpec is still allowed.
3. **Override cascade `GLOBAL → TEAM → TEMPLATE`** per Agent — a higher scope overrides individual
   fields of the base, resolved at run start into a single effective Agent.
4. **Versioning.** Agents carry a monotonic `version`; editing the base cuts a new version.
   `agentRef` pins (`@v`) or floats (latest). Each run **snapshots** the resolved version.
5. **Governance.** Editing an Agent's `systemPrompt` runs the injection/exfil scanner and resets
   `isVerified=false` (mirrors custom skills today). RBAC: GLOBAL = platform ADMIN, TEAM = team
   OWNER, inline/TEMPLATE = template editors. Write-time **referential integrity** on `agentRef`.
6. **`SkillOnlyRole` removed.** The four sub-reviewer/decomposer personas
   (`securityReviewer`, `domainLogicReviewer`, `performanceReviewer`, `decomposer`) become ordinary
   Agents resolved by key.
7. **Library UI + API.** `/admin/agents` becomes the Agents **library** (target mock:
   `mocks/agents.html`); CRUD + cascade editing via the gateway.
8. **Parity (the contract).** Reference-by-key resolution produces **byte-identical** model / skills
   / tools / prompt to today's `resolveAgentSpec` output for all six SWE agent roles + the four
   sub-roles. The full existing suite stays green; new tests are additive.

## The guiding constraint: no behavior change for SWE

Like P0, P1 is judged by **parity**. The seeded SWE Agents must resolve to exactly what the three
legacy config tables resolve to today. The behavior contract (must stay green, mechanical edits
only): `packages/worker/src/lib/config/{resolver,agentSpec,agentSkills}.test.ts`,
`packages/worker/src/activities/{validateContext,implementerSession,decomposition}.test.ts`,
`packages/gateway/src/routes/modelConfig.test.ts`, `runReviewNetwork` + `agents/reviewNetwork.ts`
behavior.

## Non-goals (explicitly deferred)

- The declarative **`agent` node** on the canvas + MCP completion → **P2** (P1 ships the entity +
  resolver + library; P2 wires it into the workflow graph).
- `Connection` / generic inputs / triggers / `MemoryItem` → **P3**.
- Bundle export/import of Agents → **P4** (the schema is designed export-friendly, but no bundle
  runtime here).
- Dropping the legacy `model_role_configs` / `agent_skill_assignments` / `agent_tool_configs`
  tables. P1 **layers `Agent` over them as the storage** (see WS1 decision) so the cascade,
  partial-unique indexes, and `origin` provenance from P0 are preserved; a physical table merge, if
  ever wanted, is a later cleanup.

---

## Current-state survey (what P1 rewires)

| Concern | Today | After P1 |
| --- | --- | --- |
| Model + credential | `ModelRoleConfig` (per role, per scope) via `resolveModelConfig` (`lib/config/resolver.ts`) | An `Agent` field; resolved through the same credential cascade |
| Skills | `AgentSkillAssignment` via `loadAgentSkills` (`lib/config/agentSkills.ts`) | `Agent.skillRefs` → skills by id; same `skillsToPromptSuffix` join |
| Tools | `AgentToolConfig` via `loadAgentToolConfig` | `Agent.toolKeys`; same `null = all`/intersection rule |
| Composition | `resolveAgentSpec` (P0 WS3) calls the three above | `resolveAgentSpec` calls **`resolveAgent`** (one cascade), unchanged output shape |
| Sub-roles | `SkillOnlyRole` union (`lib/config/types.ts`) | Deleted — keys are just Agents |
| Identity set | `AgentRole` 6-role union + `ALL_ROLES` | Stays as the SWE seed key set; `assertConfigReady` resolves Agents by those keys |
| Gateway | `lib/modelConfigService.ts`, `lib/skillAssignmentService.ts`, `routes/modelConfig.ts`, `routes/skills.ts` | New `agentLibraryService.ts` + `routes/agents.ts`; old services kept until UI cuts over |
| Web | `/admin/model-config` (RolesTab/Credentials/…), `/admin/agents/[role]` | `/admin/agents` library list + per-Agent editor (mock `mocks/agents.html`) |

---

## Workstreams

> Each workstream is one reviewable PR (slicing below). Order is dependency-driven: WS1 lands the
> entity + resolver everything else builds on.

### WS1 — `Agent` entity + `resolveAgent` (parity foundation)
**Why:** one versioned object + one resolution path, returning identical inputs to `resolveAgentSpec`.

**Schema** (`packages/shared/src/prisma/schema.prisma`)
- New `Agent` model: `id`, `key` (string), `scope ConfigScope`, `teamId?`, `workflowTemplateId?`,
  `version Int @default(1)`, `name`, `description?`, `modelSpec?`, `systemPrompt?`,
  `credentialId?`, `toolKeys String[]?` (null = all-tools, mirroring today), `origin?`,
  `isBuiltIn`, `isVerified`, `isActive`, `createdById?`, timestamps. Skill links via a join
  `AgentSkillRef { agentId, skillId, sortOrder }` (keeps `sortOrder` + cascade delete).
- Partial unique on `(key, scope, COALESCE(team_id…), COALESCE(template_id…))` in raw SQL (same
  pattern as the legacy config tables — Prisma can't express `WHERE IS NULL`). Indexes on
  `(scope, teamId)` / `(scope, workflowTemplateId)`.
- Migration is **consolidate-and-edit** of the existing init migration set (P0 already consolidated
  migrations) plus a new forward migration; no enum churn.

**Resolver** (`packages/worker/src/lib/config/agentResolver.ts`, new)
- `resolveAgent(key, ctx): Promise<ResolvedAgent>` — cascade `TEMPLATE → TEAM → GLOBAL`, **per-field
  override** (a TEAM row may set only `modelSpec`, inheriting `systemPrompt`/skills/tools from
  GLOBAL). Reuses `resolveProviderCredential` for the credential, and the same prompt-cascade rule
  as `resolveModelConfig` today.
- `resolveAgentSpec` (P0) is re-pointed at `resolveAgent` instead of calling
  `resolveModelConfig`+`loadAgentSkills`+`loadAgentToolConfig` directly. **Output unchanged.**

**Seed** (`packages/shared/src/prisma/seed.ts` + `lib/agentLibrary` seed helper)
- Create GLOBAL `Agent` rows for the 6 SWE roles + 4 sub-roles from the existing baked-in defaults,
  tagged `origin='swe-starter'`, `isBuiltIn=true`, `isVerified=true`. Skill refs mirror the seeded
  `AgentSkillAssignment` GLOBAL rows; tool keys mirror the implementer's `AgentToolConfig`.

**Acceptance:** `agentResolver.test.ts` — cascade + per-field override; **parity test** asserts
`resolveAgent(key)` feeding `resolveAgentSpec` equals the legacy three-source output for every SWE
key (golden compare). Core-only seed still boots (no SWE Agents required by core).

---

### WS2 — Retire `SkillOnlyRole`; sub-reviewers are Agents
**Why:** remove the special-case union so every persona is uniformly an Agent.

- Delete `SkillOnlyRole` from `lib/config/types.ts`; `AnySkillRole` becomes `string`. The four
  sub-role keys become seeded GLOBAL Agents (WS1). `runReviewNetwork.ts` + `agents/reviewNetwork.ts`
  resolve each sub-reviewer **by key** through `resolveAgent` — preserving today's behavior
  (sub-reviewers still bind the `reviewer` model when their own Agent leaves `modelSpec` null, via
  an explicit inherit pointer or a documented fallback).
- `loadAgentSkills`/`loadAgentToolConfig` become thin shims over `resolveAgent` (or are deleted once
  no caller remains).

**Acceptance:** review-network parity — the three sub-reviewers resolve the same model + skill
fragments as today; `runReviewNetwork` tests green unmodified.

---

### WS3 — Versioning (pin / float) + run snapshot
**Why:** edits are safe and reproducible; a running workflow uses a fixed Agent version.

- Editing an Agent's base cuts `version+1` (immutable prior versions retained for pins). `agentRef`
  grammar: `key` (float = latest active) or `key@N` (pin). A small `parseAgentRef` helper.
- **Snapshot at run start:** resolved Agent (key + version + effective fields) is recorded on the
  run (extends the P0 config snapshot path; see diagrams §5) so mid-run library edits don't change
  an in-flight run — matching the documented model-config snapshot semantics.

**Acceptance:** pin resolves the pinned version after the float advances; snapshot is read by
in-flight activities, not re-resolved.

---

### WS4 — Override cascade write path + RBAC
**Why:** governed editing across scopes.

- Gateway write rules: GLOBAL Agent = platform `ADMIN`; TEAM override = team `OWNER`; TEMPLATE/inline
  = template editors (reuse existing RBAC guards from `modelConfig.ts`/`skills.ts`).
- Write-time **referential integrity**: rejecting a template `agentRef`/skill ref that names a
  missing/inactive Agent (diagrams §"referential integrity").

**Acceptance:** RBAC matrix tests (each scope, allowed/denied); dangling `agentRef` rejected at save.

---

### WS5 — Prompt-edit security scan + verification reset
**Why:** Agent prompts are an injection surface, same as custom skills.

- On `systemPrompt` change, run `scanSkillContent` (`@auto-swe/shared/lib/skillScanner`); reset
  `isVerified=false`; surface warnings (non-blocking), exactly like the custom-skill flow today.

**Acceptance:** editing a built-in Agent's prompt flips `isVerified` and records scan warnings;
unchanged prompt leaves verification intact.

---

### WS6 — Library API + UI
**Why:** the human surface for the library.

- Gateway: `lib/agentLibraryService.ts` + `routes/agents.ts` — list/get/create/update/version/delete
  with the WS4 RBAC + WS5 scan hooks; cascade-aware read (effective Agent per scope).
- Web: `/admin/agents` becomes the library list; per-Agent editor (model, prompt, skills, tools,
  versions, scope overrides). Target visual: `mocks/agents.html`. Team/template override editors
  reuse the existing `TeamModelConfigSection`/`TemplateModelConfigSection` shells.

**Acceptance:** route tests (CRUD + cascade + RBAC); the existing `/admin/model-config` keeps working
until the cutover lands (no orphaned UI).

---

## PR slicing

| PR | Workstream(s) | Risk | Notes |
| --- | --- | --- | --- |
| 1 | WS1 | High | Entity + resolver + seed + **parity golden**. Everything rebases on it. |
| 2 | WS2 | Med | Remove `SkillOnlyRole`; review-network by key. Depends on WS1 seed. |
| 3 | WS3 | Med | Versioning + run snapshot. |
| 4 | WS4 | Low | Cascade write path + RBAC + referential integrity. |
| 5 | WS5 | Low | Prompt scan + verification reset (mirrors skills). |
| 6 | WS6 | Med | API + library UI; cutover from `/admin/model-config`. |

## Risks & gotchas

1. **Parity is everything.** The seeded Agents must reproduce the exact three-source resolution.
   Lock it with a golden-compare test over all 10 keys before refactoring any caller.
2. **Per-field override semantics.** A higher-scope Agent overrides *individual* fields, not the
   whole Agent — mirror `resolveModelConfig`'s independent prompt cascade so partial TEAM overrides
   behave as today.
3. **Sub-role model inheritance.** Sub-reviewers inherit the `reviewer` model implicitly today.
   Make the inherit explicit (a documented `inheritsModelFrom`/null-spec fallback) — don't silently
   change which model they bind.
4. **Partial unique indexes.** `Agent` needs the same `COALESCE`-based partial uniques as the legacy
   config tables; use `findFirst + conditional create` (not `upsert`) for GLOBAL rows.
5. **Config cache.** `lib/config/cache.ts` keys are role+scope strings — extend keys to include
   Agent version so pins/floats don't collide in the 60 s TTL cache.
6. **Mid-run edits.** WS3's snapshot must be the source of truth for in-flight runs; activities read
   the snapshot, not a live `resolveAgent`.

## Sequencing checklist

- [ ] WS1 — `Agent` entity + `resolveAgent`; `resolveAgentSpec` re-pointed; seed + parity golden
- [ ] WS2 — `SkillOnlyRole` removed; sub-reviewers resolve by key (review-network parity)
- [ ] WS3 — versioning (pin/float) + run snapshot
- [ ] WS4 — cascade write path + RBAC + referential integrity
- [ ] WS5 — prompt-edit security scan + verification reset
- [ ] WS6 — Agent library API + `/admin/agents` UI cutover
