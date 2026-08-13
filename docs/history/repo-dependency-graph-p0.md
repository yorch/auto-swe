# Repo Dependency Graph — P0: Graph foundation

> Build plan for **Phase P0** of the [repo dependency graph RFC](./repo-dependency-graph-rfc.md). P0
> is the durable, additive, no-LLM first slice: stand up the `RepoDependency` edge model, the
> **manual/declared** edge write-path with its cross-team authorization and depended-upon-team dismiss
> veto, and the read-side `resolveRepoDependencyContext` resolver. **No detectors, no agent injection,
> no behavior change to any run.** A human can declare "A depends on B" and the resolver can answer
> "who are A's 1-hop neighbours, both directions?" — the skeleton P1 detectors fill and P2 injection
> reads.
>
> Parent RFC: [`repo-dependency-graph-rfc.md`](./repo-dependency-graph-rfc.md) — see §3 (model), §4.5
> (authz + veto), §5 (resolver), §6 (roadmap), §8 (decisions).

---

## Outcomes (definition of done)

1. **`RepoDependency` model + constraints migrated**, matching house schema conventions (UUID PK via
   `dbgenerated("gen_random_uuid()")`, `@map` snake_case, `@db.Timestamptz`). Includes the nullable
   `toRepoId` + `toRef` suggestion shape so P1 does not re-migrate. Two `Connection` back-relations +
   an optional `packageNames String[]` on `Connection`.
2. **Custom-migration DDL** the Prisma DSL can't express: the two partial unique indexes (resolved
   edges vs. unresolved suggestions), the no-self-edge CHECK, the shape-guard CHECK, and the
   `status`/`source` CHECK enums — in the hand-written `custom_constraints_and_indexes` migration.
3. **Manual edge write-path.** `GET/POST/PATCH/DELETE /api/v1/admin/repos/:id/dependencies` (Fastify +
   Zod, `fastify-plugin`). Create/confirm enforces **LEAD/ADMIN on both teams** (§4.5); either team's
   LEAD may remove/dismiss; ENGINEER is rejected; cross-org and self-edges are rejected at the
   boundary (belt-and-suspenders with the DB CHECKs).
4. **Dismiss veto is real.** A `dismissed` edge is sticky — the resolver excludes the pair, and this
   is exercised by a test, so P0's veto works before any detector exists to fight it.
5. **Read-side resolver** `resolveRepoDependencyContext(repoId, ctx)` returns
   `{ upstream: NeighborRepo[], downstream: NeighborRepo[] }`: 1 hop each direction, `active` only,
   multi-source rows collapsed to max-confidence, filtered to repos the caller's team/org can see.
   **No-ops (empty) when the repo id is absent** (mirrors `requireRepoId`, §5.4). No injection.
6. **Repo graph management UI.** The `/connections` repo surface gains a dependencies view: list
   upstream/downstream neighbours, add a manual edge (repo picker over visible repos), confirm/dismiss.
   Manage controls gated client-side by the same `canManage` (ADMIN/LEAD) the page already uses.
7. **Living capability doc** `docs/repo-dependency-graph.md` with a `## Limitations` section (injection
   not wired, detectors not built) — passes `yarn docs:check`, unlike the roadmap RFC which stays in
   `history/`.
8. **Tests.** Migration applies against a live Postgres; edge CRUD; both-teams gate (LEAD-on-one →
   403); self-edge / cross-org → 400; resolver walks both directions, collapses sources, honors
   dismiss, filters visibility, and no-ops on a null repo id.

## Non-goals (deferred)

- Manifest / git-signal parsing, the `unresolved`→suggestion surface, the re-scan schedule → **P1**
  (P0 ships the `toRef`/nullable-`toRepoId` columns and the `unresolved` status value, but nothing
  writes them yet).
- LLM inference, `proposed` edges, auto-promote threshold config → **P3**.
- Any agent seeing this context — review network, implementer, planner injection, `full_checkout`,
  epic `dependsOn` seeding → **P2**. The resolver returns neighbours; nothing calls it from an agent
  path yet.

## The guiding constraint

P0 changes **no agent behaviour and gates no run**. Every write is a new admin route; the only
schema additions are additive (a new table + nullable columns). The resolver is pure read. Writes
happen in the **gateway**, never in the workflow V8 isolate. This is why P0 is greenlit ahead of the
detector/injection phases — none of the RFC §7 risks (context explosion, stale edges, inference
trust) touch it.

---

## Workstreams

### WS1 — Schema: `RepoDependency` + `Connection` edits + migration
**Why:** the missing edge layer; the whole feature is nodes-without-edges until this lands.

- **Schema** (`packages/shared/src/prisma/schema.prisma`) — add `model RepoDependency` exactly as
  RFC §3, the two `Connection` back-relations, and `packageNames String[]` (nullable via `@default([])`
  or left unset — decide against the array-NOT-NULL house pattern; `packageNames` is genuinely
  optional so a plain nullable array is right).
- **Prisma migration** (`yarn db:migrate`) generates the table, FKs, and the plain indexes.
- **Custom migration** — a **new** migration folder (`00000000000002_repo_dependencies`), appended
  after the existing two, carrying the two partial unique indexes, the two CHECKs, and the
  status/source CHECK enums. Per the [`prisma-pgvector-hnsw`](../../.claude/skills/prisma-pgvector-hnsw/SKILL.md)
  skill, non-expressible DDL is **never** added by editing the already-applied `00000000000001`.
- **Doc-count sync:** the new model bumps the Prisma-model count — update `docs/architecture.md`'s
  count in this PR so `yarn docs:check` stays green.

### WS2 — Gateway: manual edge API + both-teams authz
**Why:** the only P0 writer; the authz asymmetry (§4.5) is the substantive logic.

- New route module `packages/gateway/src/routes/repoDependencies.ts` (or fold into the existing
  `routes/repositories.ts`, which already owns repo CRUD and the `canManageTeamRepos` helper).
- Reuse `canManageTeamRepos` (repositories.ts) for **both** `from` and `to` teams on manual
  create/confirm; a helper `canManageEdge(user, fromRepo, toRepo)` composes the two.
- Zod bodies: create `{ toRepoId, kind?, detail? }`; the `:id` path param is the `from` repo.
- Reject: self-edge (from===to), cross-org (fromRepo.team.orgId !== toRepo.team.orgId when both set),
  ENGINEER (route-level `requireAuth({ requiredRole: 'LEAD' })` + the dual team check).
- Map the DB partial-unique violation (`P2002`) to a friendly 409, mirroring the existing
  `REPO_EXISTS` handling.

### WS3 — Resolver: `resolveRepoDependencyContext`
**Why:** the reusable core every later phase consumes; shipping it standalone lets the graph logic be
unit-tested with zero agent surface.

- Home: `packages/shared/src/lib/repoDependencyResolver.ts` (pure over the exported prisma singleton),
  so both the gateway (P0 UI) and the worker (P2 injection) import one implementation.
- Signature `resolveRepoDependencyContext(repoId: string | null | undefined, ctx: { teamId, orgId? })
  → { upstream, downstream }`. Null/absent repoId → `{ upstream: [], downstream: [] }` (the
  `requireRepoId` no-op contract, §5.4).
- Steps: fetch `active` edges where `fromRepoId = repoId` (upstream) and `toRepoId = repoId`
  (downstream); collapse duplicate `(pair, kind)` rows to max-confidence; drop `dismissed`; join
  `Connection` and filter to repos visible under `ctx` (same team, or same org via `Team.orgId`).

### WS4 — Web: repo dependency management surface
**Why:** gives the P0 data a human producer/consumer; the confirm/dismiss controls are inert for
manual `active` edges but are the surface P1/P3 populate.

- Extend the `/connections` repo detail (`packages/web/src/app/connections/...`) with a Dependencies
  panel: two lists (Depends on / Depended on by), an "Add dependency" modal (repo picker over
  `GET /repositories` visible set), and per-edge confirm/dismiss/remove actions.
- New TanStack Query hooks in `packages/web/src/hooks/` over the WS2 endpoints, mirroring
  `useRepositories`.
- Gate manage controls with the page's existing `canManage = role === 'ADMIN' || role === 'LEAD'`;
  the server is the real gate (WS2).

### WS5 — Tests + living doc
**Why:** P0 is where the graph invariants are cheapest to pin down, before detectors add noise.

- **Migration** applies against a live Postgres (the repo's standard migration test path).
- **Gateway** (`app.inject`): create/confirm requires both teams' LEAD (LEAD-on-one → 403);
  ENGINEER → 403; self-edge / cross-org → 400; dismiss then re-create is idempotent; `P2002` → 409.
- **Resolver** (mock prisma): both-direction walk; max-confidence collapse across sources; `dismissed`
  excluded; visibility filter drops an out-of-scope repo; null repoId → empty.
- **Doc:** author `docs/repo-dependency-graph.md` (living, present-tense, `## Limitations`) and run
  `node scripts/check-doc-drift.mjs`.

---

## Sequencing

WS1 → WS2/WS3 in parallel (both depend only on the schema) → WS4 (needs WS2's endpoints) → WS5
throughout. One focused PR; the fiddly part is WS1's custom migration, everything else is mechanical.
