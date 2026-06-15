# Platform Pivot — P3 Epic: Generic Connections, inputs, triggers, memory

> Build plan for **Phase P3** of the [platform pivot](./platform-pivot.md). P3 decouples the
> remaining SWE-shaped schema so the engine is domain-generic; SWE specializes via seed/config.
> This is the largest phase — four independent decouplings, each its own slice(s).
>
> Parent RFC: [`platform-pivot.md`](./platform-pivot.md) §P3. Builds on P0–P2 + P1.5 (the engine,
> Agent library, and agent node are already generic).

---

## Outcomes (definition of done)

1. **`Connection` replaces `Repository`.** A generic integration row (`type` + typed `config` Json +
   scope + encrypted secrets) is the core entity; SWE's `git_repo` is one connection type carrying
   the old repo specifics (GitHub coords, default branch, gate commands). Runs reference a
   `connectionId`.
2. **Generic run inputs.** Templates declare an `inputSchema` (Zod/JSON-schema); a generic `RunInput`
   replaces `WorkRequest`. SWE declares `{ ticketId, connectionId, description, budget }`.
   `ContextSnapshot`/`PullRequest` become SWE satellite tables.
3. **Generic triggers.** Core webhook receivers/verifiers + manual/API + schedule; event→input
   mappings are config/seed (SWE: GitHub `issue.labeled`, Jira fetch).
4. **`MemoryItem` replaces `AgentLesson`.** A generic `{ scope, tags Json, content, embedding }`
   row with pgvector search; SWE lessons become memory items under an SWE scope.
5. **Decouplability proof:** a non-SWE template declares its own `inputSchema`, binds a non-`git_repo`
   Connection, fires from a schedule, and reads/writes `MemoryItem` under its own scope — **no core
   path assumes tickets, repos, PRs, or failure types.**

## Non-goals
- No new SWE capabilities — pure decoupling. SWE behavior stays identical (parity), specialized via
  seed + connection/input config.
- Distribution/bundles → P4.

## The guiding constraint
Parity for the SWE use case at every slice. Each slice keeps the full suite green and the seeded SWE
workflow byte-identical; the generalization is additive, with SWE re-expressed as seed/config.

---

## Slices (ordered most-contained → most-invasive; each lands green)

### Slice 1 — `MemoryItem` replaces `AgentLesson` (most self-contained) ← start here
- **Schema:** `MemoryItem { id, scope (string), tags Json, content, embedding vector(1536),
  sourceRef?, createdAt }` + the pgvector HNSW index (raw SQL, mirroring `agent_lessons`). Keep the
  SWE columns SWE needs (repo/run linkage) as `tags`/`sourceRef` or a thin satellite.
- **Worker:** `commitToMemory` writes a `MemoryItem` under an SWE scope (e.g. `swe:lessons:<repoId>`);
  `consolidateLessons` + the semantic-search enrichment read `MemoryItem` by scope + pgvector.
- **Gateway/web:** the lessons routes + `/lessons` UI read `MemoryItem` filtered to the SWE scope.
- **Migration:** since undeployed, fold into the consolidated init; drop `AgentLesson`.
- **Acceptance:** memory commit/search parity for SWE; a memory item under a non-SWE scope is
  read/written independently. pgvector parity test.

### Slice 2 — `Connection` replaces `Repository`
- **Schema:** `Connection { id, type (e.g. 'git_repo'), name, scope, teamId?, config Json,
  <encrypted secrets>, isActive }`. SWE `git_repo` config = `{ org, repo, defaultBranch, gateCommands,
  githubInstallationId? }`. `WorkRequest`/`ActiveWorkflow`/runs reference `connectionId`.
- **Worker:** the workspace clone + gate-command + PR steps read the `git_repo` connection config
  instead of `Repository` columns.
- **Gateway/web:** `/repositories` becomes `/connections` (or a `git_repo`-filtered view); CRUD on
  `Connection`. Team relation moves to `Connection`.
- **Migration:** drop `Repository`; SWE repos seed/migrate as `git_repo` connections.
- **Acceptance:** SWE run end-to-end against a `git_repo` connection (parity); a non-`git_repo`
  connection type validates + stores config without touching git code paths.

### Slice 3 — Template `inputSchema` + generic `RunInput`
- **Schema:** `WorkflowTemplate.inputSchema Json`; generic `RunInput { id, templateId, connectionId?,
  payload Json, ... }` replacing `WorkRequest`. SWE template declares
  `{ ticketId, connectionId, description, budget }`. `ContextSnapshot` + `PullRequest` → SWE
  satellite tables keyed by run.
- **Gateway:** run-submit validates `payload` against the template's `inputSchema`; `POST
  /work-requests` becomes `POST /runs` (or generalized) with the SWE input shape.
- **Worker:** the workflow reads `RunInput.payload` (SWE: ticketId/description/connectionId) instead
  of `WorkRequest` columns.
- **Acceptance:** SWE submit→run parity via `RunInput`; a non-SWE template's `inputSchema` validates
  a different payload and runs with no ticket/repo assumptions.

### Slice 4 — Generic triggers
- **Schema/config:** trigger receivers (core webhook verify + manual/API + schedule) + a config/seed
  mapping from event → `RunInput`. SWE: GitHub `issue.labeled` + Jira fetch map to the SWE input.
- **Acceptance:** a sample GitHub/Jira payload maps to a `RunInput` via config; a schedule trigger
  fires a non-SWE template.

## Risks & gotchas
1. **`Repository` blast radius** (slice 2) — referenced across gateway routes, worker workspace/clone,
   `ActiveWorkflow`, `WorkRequest`, team relations, cost/analytics. Slice it carefully; keep a
   `git_repo`-typed read shim until every caller moves.
2. **pgvector** (slice 1) — `MemoryItem.embedding` keeps the fixed `vector(1536)` + raw-SQL HNSW index
   (Prisma can't model it); the embedding helper's 1536-dim guard stays.
3. **`WorkRequest` removal** (slice 3) — the run lifecycle, Slack notifications, run history, and the
   `/runs` UI all key off WorkRequest; generalize the read model to `RunInput` + SWE satellite.
4. **Parity** — SWE stays identical; everything generic is re-expressed as seed/config (connection
   rows, the SWE template's `inputSchema`, trigger mappings, memory scope).

## Sequencing checklist

- [x] Slice 1 — `MemoryItem` replaces `AgentLesson` (+ pgvector index; SWE lessons under an SWE scope)
- [ ] Slice 2 — `Connection` replaces `Repository` (`git_repo` type carries SWE repo config)
- [ ] Slice 3 — template `inputSchema` + generic `RunInput` (replaces `WorkRequest`; SWE satellites)
- [ ] Slice 4 — generic triggers (webhook/manual/schedule → config-driven input mappings)
