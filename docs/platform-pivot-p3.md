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

### Slice 2 — `Connection` replaces `Repository` ✅ DONE
- **Schema:** `Repository` model + table renamed to `Connection` / `connections`, with a generic
  `type String @default("git_repo")` discriminator + a generic `config Json?` bag. The SWE `git_repo`
  specifics (org/repo, defaultBranch, gateCommands, mcpServerRef, executorImage, …) stay as typed
  columns for parity; other connection types stash settings in `config`. The seed writes the sample
  row with `type: 'git_repo'`.
- **Migration:** folded into the consolidated init (undeployed) — `Repository`→`Connection` rename,
  new `type`/`config` columns; all four FKs (`active_workflows`, `memory_items`, `pull_requests`,
  `scheduled_work_requests`) now reference `connections`. Regenerated via
  `prisma migrate diff --from-empty --to-schema`; the pgvector HNSW + partial-unique custom migration
  is unchanged.
- **Code:** the Prisma delegate (`prisma.repository` → `prisma.connection`) and Prisma input types
  (`Prisma.RepositoryWhereInput` → `Prisma.ConnectionWhereInput`) move across gateway routes + worker
  activities. Verified parity: 868 tests + typecheck + web build green; real-pgvector migrate + seed.
- **Scoped to keep parity / defer to slice 3:** the **relation field** names (`ActiveWorkflow.repository`,
  `PullRequest.repository`, `MemoryItem.repository`, `Team.repositories`, `ScheduledWorkRequest.repository`)
  and the **scalar FK** (`repoId` / `repo_id`) are intentionally **kept** — they point at `Connection`
  but retain their names so the public API/JSON shape (`repoId`/`repoIds`, response `repository` fields)
  and the GitHub-webhook `repository` payload field are byte-stable. The generic `name`/`scope`/encrypted-
  secrets columns and the `repoId`→`connectionId` / route `/repositories`→`/connections` /
  response-field renames belong to **slice 3** (it reworks the input/API surface to `RunInput` +
  `connectionId`), so they ride along there rather than churning the API twice.
- **Acceptance:** SWE parity (full suite green against a `git_repo` connection); a non-`git_repo`
  connection type validates + stores `config` without touching git code paths (git paths key off the
  SWE run flow, not the `type` column).

### Slice 3 — Template `inputSchema` + generic `RunInput` ✅ DONE (3 sub-slices)
Landed as three green-at-each-step commits:
- **3a — `WorkflowTemplate.inputSchema` + validator.** New `inputSchema Json?` column holding a small
  JSON-Schema subset, plus a dependency-free `validateInputPayload` helper
  (`@auto-swe/shared/lib/inputSchema`: required fields, scalar/array types, `enum`, `format:'uuid'`,
  all violations at once). The default engineering template seeds the SWE contract
  `{ ticketId, connectionId, description, budget }`. 11 unit tests.
- **3b — `WorkRequest` → `RunInput`.** Model + `work_requests` table renamed to `RunInput` /
  `run_inputs`; added generic `payload Json?` + `connectionId` FK (onDelete SetNull). SWE columns
  (`externalTicketId`, `requestPayload`) kept as typed columns for parity. Per the slice-2 playbook
  only the delegate (`prisma.workRequest`→`prisma.runInput`) + Prisma types move; the relation field
  names (`.workRequest`/`.workRequests`), scalar FK (`workRequestId`), and `/work-requests` endpoint
  stay stable. (`ScheduledWorkRequest` + the `RepoWorkRequest` Temporal payload are distinct and
  unchanged.)
- **3c — submit-time enforcement + payload population.** `POST /work-requests` builds the generic
  payload, validates it against the resolved template's `inputSchema` (400 `INVALID_INPUT` with
  per-field details, **before** the Temporal idempotency gate so no orphan run), and persists
  `payload` + `connectionId` on the `RunInput`. Templates with no schema accept any payload (parity).
  Two route-level enforcement tests.
- **`ContextSnapshot` / `PullRequest`:** already separate tables keyed by `workRequestId` /
  `workflowId` — i.e. structurally SWE satellites already; left as-is (no rename needed; they hang
  off `RunInput`/`ActiveWorkflow`).
- **Deferred polish (optional, not blocking):** a fully generic `POST /runs` endpoint + migrating
  web/CLI/Slack to submit a raw `payload` (the current submit keeps the SWE-shaped body and maps it),
  and making `externalTicketId` nullable. The engine pieces (`inputSchema` + `payload` +
  `validateInputPayload` + `connectionId`) are all in place and enforced; these are surface-level.
- **Acceptance:** SWE submit→run parity via `RunInput` (881 tests green); `validateInputPayload`
  proves a non-SWE template validates a different payload (unit test) and submit rejects a payload
  that violates the declared schema (route test).

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
- [x] Slice 2 — `Connection` replaces `Repository` (`git_repo` type carries SWE repo config)
- [x] Slice 3 — template `inputSchema` + generic `RunInput` (replaces `WorkRequest`; SWE satellites)
- [ ] Slice 4 — generic triggers (webhook/manual/schedule → config-driven input mappings)
