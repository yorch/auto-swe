# Platform Pivot — P1.5 Epic: Retire the role tables (Agent as single source of truth)

> Finishes the role→Agent migration started in P1. P1 made `Agent` a first-class entity that
> **overlays** the three legacy config tables; P1.5 makes `Agent` the **sole** source and **deletes**
> `ModelRoleConfig`, `AgentSkillAssignment`, `AgentToolConfig`. Since nothing is deployed there is
> **no data backfill** — the seed creates fully-populated Agents and the legacy tables are dropped.
>
> Parent: [`platform-pivot-p1.md`](./platform-pivot-p1.md). Builds on P0 `runAgent`/`resolveAgentSpec`.

---

## Outcomes (definition of done)

1. **`Agent` is the only role/skill/tool/model store.** `ModelRoleConfig`, `AgentSkillAssignment`,
   `AgentToolConfig` are gone (schema + DB). `ProviderCredential` and `EmbeddingConfig` stay
   (credentials/embeddings are not role config).
2. **One resolver.** `resolveAgent` reads everything from the Agent row (model via `modelSpec` +
   `inheritsModelFrom`, skills via `skillRefs`, tools via `toolKeys`); no legacy fallback. `getModel`
   / `getModelSpec` / `resolveSystemPrompt` / `loadAgentSkills` / `loadAgentToolConfig` are thin
   shims over it (so activities don't change).
3. **Seeded Agents are self-contained.** The seed populates the 6 model-backed Agents with the
   baked-in default `modelSpec`, the 4 sub-roles with `inheritsModelFrom`, the implementer with
   `toolKeys`, and every Agent's `skillRefs` from the built-in skill assignments.
4. **Boot validates Agents.** `assertConfigReady` checks each required Agent resolves a model +
   credential (no more `ModelRoleConfig` lookups). The worker boots from the seed alone — the
   "Seed Anthropic defaults" bootstrap step is removed.
5. **Admin surface on the Agent library.** Per-role model/prompt/skills/tools are edited at
   `/admin/agents/library`. `/admin/model-config` keeps **credentials + embeddings** only.
6. **Base prompts stay as code constants** (`lib/agentPrompts.ts`); `Agent.systemPrompt` remains an
   optional override (as `ModelRoleConfig.systemPrompt` was).

## Non-goals
- No change to `ProviderCredential` / `EmbeddingConfig` shape or the credential cascade.
- No new Agent capabilities — this is consolidation/cleanup only.

---

## Slices (each lands green — typecheck + full suite + real-pgvector migrate)

### Slice 1 — Worker: `resolveAgent` authoritative ✅ target
- Seed full Agent data (`syncAgents`): default `modelSpec` (from `DEFAULT_ROLE_SPECS`), `toolKeys`
  for implementer, `skillRefs` from `BUILTIN_SKILLS` assignments, `inheritsModelFrom` for sub-roles.
- `resolveAgent`: resolve model from `modelSpec` (chasing `inheritsModelFrom`) + credential; skills
  from `skillRefs`; tools from `toolKeys`. Remove the legacy fallback. Throw `ConfigMissingError`
  when a required Agent/model is absent.
- `models.ts` (`getModel`/`getModelSpec`/`resolveSystemPrompt`) and `agentSkills.ts`
  (`loadAgentSkills`/`loadAgentToolConfig`) become shims over `resolveAgent`/`fetchActiveAgent`.
- `assertConfigReady`: validate required Agents resolve a model + credential.
- Worker stops reading the three tables. (Tables still exist + still seeded → gateway/web compile.)
- Update worker tests (`resolver`, `assertReady`, `models`, `agentResolver`, `costTracking`, the
  activity tests, `coreOnlySeed`).

### Slice 2 — Gateway: retire the role services
- Replace `modelConfigService` (role-model parts) + `skillAssignmentService` with Agent-library
  operations. Repoint `/admin/agents/:role/skills|tools` + the `model-config` role endpoints onto
  the Agent library; **keep** credentials + embeddings endpoints. Remove `seedDefaultModelConfigs` +
  `POST /admin/defaults`. Update route tests + audit-entity types.

### Slice 3 — Web: repoint the admin UI
- Model-config "Roles" tab, `/admin/agents/[role]`, and `Team/Template{ModelConfig,AgentSkills}Section`
  move onto the Agent library (`useAgentLibrary`). `/admin/model-config` keeps Credentials +
  Embeddings + Audit. Remove `useSeedDefaults` + the dead model-role hooks.

### Slice 4 — Drop the tables + dead code
- Remove the three models + back-relations from `schema.prisma`; fold into the consolidated init
  (regenerate via `prisma migrate diff`). Delete `syncSkills` assignment writes +
  `syncImplementerToolConfig`, the legacy resolver functions, and any now-dead types/services/hooks.

## Risks & gotchas
1. **`assertConfigReady` couples to the seed** — once Agents carry `modelSpec`, boot no longer needs
   the admin "Seed defaults" step. Update the bootstrap docs (`model-configuration.md`, AGENTS.md).
2. **`inheritsModelFrom` chasing** — sub-role model resolution must follow the pointer to the parent
   Agent's `modelSpec`; guard against missing parents.
3. **Skills without model** — `loadAgentSkills`/`loadAgentToolConfig` must read the Agent row's
   skills/tools **without** forcing model+credential resolution (use `fetchActiveAgent`, not the full
   `resolveAgent`), so a skills-only caller can't fail on missing credentials.
4. **Circular import** — move `ResolvedSkill` to `config/types.ts` so `agentSkills` can import
   `fetchActiveAgent` from `agentResolver` without a value cycle.
5. **Inline agent path** — `resolveAgentSpec` inline (`agentKey='inlineAgent'`) has no Agent row;
   it's not wired to any runtime caller yet, so `recordLlmUsage`/`getModelSpec` never see it. Keep an
   eye on it when the inline path is wired.

## Sequencing checklist

- [x] Slice 1 — worker: `resolveAgent` authoritative; seed full Agents; `assertConfigReady` on Agents
- [ ] Slice 2 — gateway: retire role services/routes; keep credentials + embeddings
- [ ] Slice 3 — web: admin UI onto the Agent library
- [ ] Slice 4 — drop the three tables + dead code; consolidate migration; update bootstrap docs
