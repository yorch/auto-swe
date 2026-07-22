# Repo Dependency Graph — RFC & Roadmap

Planning doc (RFC + roadmap) for making **Git repos a first-class entity with a durable,
queryable dependency graph** — so that when a workflow runs (code review first, but the
implementer and planner too), the system automatically knows a repo's related/dependent repos
and injects that cross-repo context into the agents.

Like the platform pivot and evals, this is framed as a **platform capability**, not a one-off SWE
feature: the engine gains a generic repo-relationship graph + a detection layer + a context-injection
resolver; SWE is the first consumer (the review network, the implementer, the epic planner).

> Status: **RFC — not yet built.** This doc establishes the model, the detection strategy, the
> injection points, and a phased build plan sized so each phase lands in one (or a small handful of)
> PR(s). Per-phase build plans (`repo-dependency-graph-p0.md`, …) split out as phases are committed,
> mirroring `platform-pivot-p*.md` and `evals-p*.md`.
>
> **Decisions already locked** (see §8): extend `Connection` (no new base table); inject into the
> **review network + implementer + planner/decomposer**; detect from **all four sources** (manifest,
> manual, git/CI signal, LLM inference) with a **tiered trust model**; walk the graph **both
> directions, 1 hop**.

---

## 1. Why a repo dependency graph (the gap today)

auto-swe already treats a Git repo as a `Connection` (`type='git_repo'`) — org/repo identity,
default branch, executor image, gate commands. What it has **no** concept of is how repos *relate*.
Two concrete symptoms:

- **The review network is context-starved.** `runReviewNetwork` → `reviewNetwork.ts` gives its three
  reviewers (security / domain-logic / performance) *only the diff* (`filesChanged`,
  `implementationNotes`, `testResults`) plus `successCriteria` and static security findings. A change
  to `payments-sdk` that breaks `payments-api`'s call sites is invisible — the reviewer never sees the
  consumer, so it can't flag the breaking change.
- **Dependency knowledge is ephemeral and epic-only.** The *only* place repo dependencies exist today
  is inside the Epic orchestrator at runtime: a planner LLM produces an in-memory `dependsOn` DAG
  (`EpicRepoEntry.dependsOn`) used solely to sequence/skip epic children (`epicOrchestrator.ts`).
  Nothing is stored, nothing is reusable, and a normal (single-repo) run never sees it. Every epic
  re-derives the graph from scratch by paying an LLM call.

| Existing primitive | File(s) | What it does / doesn't give us |
| --- | --- | --- |
| **`Connection` (`type='git_repo'`)** | `schema.prisma:251-290` | First-class repo identity — but no relationships |
| **Epic `dependsOn` DAG** | `types/workflow.ts:202-205` (`EpicRepoEntry`), `epicOrchestrator.ts:58` (`computeTransitiveDependents`) | Runtime-only, planner-derived (`planEpic`), never persisted, epic-only |
| **Review network** | `agents/reviewNetwork.ts:120-199` (`runReviewNetwork`), `activities/runReviewNetwork.ts:15` | Sees only the diff (`{diff, filesChanged, implementationNotes, testResults}`) — no cross-repo context |
| **Implementer context injection** | `activities/executeImplementation.ts`, `formatDesignContext` | Injects ticket + Figma design context — a clean template for injecting dep context |
| **Workspace clone** | `activities/workspace.ts:100-298` | Clones exactly one repo — no notion of pulling a neighbor |

**The honest summary:** repos are first-class as *nodes* but there are no *edges*. This RFC adds the
edges, the detectors that populate them, and the resolver that turns them into agent context.

---

## 2. Conceptual grounding

A **repo dependency graph** is a directed graph whose nodes are git-repo `Connection`s and whose
edges are "repo A depends on repo B" facts, each carrying **kind**, **provenance (source)**,
**confidence**, and **status**.

Three axes structure the design:

- **Direction.** Edges are directed (`from` depends on `to`). "What do I depend on?" is the forward
  walk (`from→to`, *upstream*); "who depends on me?" is the reverse walk (`to→from`, *downstream* /
  blast-radius). The review use case wants **both**.
- **Depth.** How many hops to walk. Locked at **1 hop each direction** for v1 — bounded context size,
  and the direct neighbors carry the overwhelming majority of the breaking-change signal. Transitive
  walks are a deferred option (§7).
- **Trust.** Not all edges are equally reliable. A parsed `package.json` dependency is a fact; an LLM
  "these two repos look related" is a hypothesis. Edges carry a `source` and `confidence`, and the
  **trust model is tiered** (§4.2): deterministic sources land `active`, LLM inference lands
  `proposed` until confirmed (or auto-promoted above a threshold).

### Why extend `Connection` rather than add a `Repository` table

P3 deliberately unified `Repository` into the generic `Connection`, and the whole API surface
(`repoIds`/`repoId`/`repository`) plus every FK (`ActiveWorkflow`, `RunInput`, `MemoryItem`,
`PullRequest`, `ScheduledWorkRequest`) keys off it. Re-carving a separate `Repository` table would
re-break that unification for no functional gain. Instead we **add edges between git-repo
Connections** and a repo-focused management surface. "First-class Git repo" = a git-repo Connection
that now has a graph around it, not a new base entity. (Decision §8.1.)

---

## 3. Data model

One new model — a directed edge — plus two back-relations on `Connection`. Matches the house schema
style (UUID PK via `dbgenerated("gen_random_uuid()")`, `@map` snake_case, `@db.Timestamptz`).

```prisma
model RepoDependency {
  id         String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  /// The dependent repo (e.g. payments-api). "from depends on to."
  fromRepoId String @map("from_repo_id") @db.Uuid
  /// The dependency repo (e.g. payments-sdk).
  toRepoId   String @map("to_repo_id") @db.Uuid
  fromRepo   Connection @relation("RepoDependencyFrom", fields: [fromRepoId], references: [id], onDelete: Cascade)
  toRepo     Connection @relation("RepoDependencyTo", fields: [toRepoId], references: [id], onDelete: Cascade)

  /// Edge semantics: "code" | "runtime" | "build" | "api" | "data" | ...
  kind       String  @default("code")
  /// Provenance: "manual" | "manifest" | "git_signal" | "inferred".
  source     String
  /// 1.0 for deterministic sources; <1 for LLM inference.
  confidence Float   @default(1)
  /// "active" (in-graph) | "proposed" (awaiting confirm) | "dismissed" (human-rejected).
  status     String  @default("active")
  /// Provenance detail — matched package name, manifest path, importing file,
  /// submodule path, model + reasoning for inferred edges, etc.
  detail     Json?

  detectedAt    DateTime  @default(now()) @map("detected_at") @db.Timestamptz
  confirmedById String?   @map("confirmed_by_id") @db.Uuid
  confirmedAt   DateTime? @map("confirmed_at") @db.Timestamptz
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  /// One edge per (pair, kind, source) so detectors coexist without clobbering
  /// each other — a manifest edge and an inferred edge for the same pair are
  /// distinct rows, reconciled at read time by max-confidence.
  @@unique([fromRepoId, toRepoId, kind, source])
  @@index([fromRepoId])
  @@index([toRepoId])
  @@map("repo_dependencies")
}
```

On `Connection`, two back-relations:

```prisma
  dependenciesFrom RepoDependency[] @relation("RepoDependencyFrom")  // edges where this repo is the dependent
  dependenciesTo   RepoDependency[] @relation("RepoDependencyTo")    // edges where this repo is depended upon
```

Constraints that the Prisma DSL can't express go in the custom-constraints migration
(`migrations/00000000000001_custom_constraints_and_indexes`), matching how the partial unique index
on `Connection` is done today:

- **No self-edges:** `CHECK (from_repo_id <> to_repo_id)`.
- **Status/source enums as CHECK constraints** (kept as strings, per the P0 enum→string pivot house
  style — no Prisma enum).

**Reconciliation model.** Multiple detectors can assert the same pair. The read-side resolver
collapses rows for a pair to the **max-confidence `active`** edge (plus surfaces the individual source
rows for the admin UI). A `dismissed` human decision suppresses the pair regardless of what detectors
re-assert (the detector re-writes its own `source` row, but the resolver honors an explicit dismissal
— see §4.2).

**Visibility / tenancy.** Repos belong to teams, teams to orgs (P5). An edge may legitimately cross
teams *within an org* (a platform SDK consumed by many product repos). The resolver filters neighbor
repos to those the run's team/org can see (reusing the existing team/org access helpers) so injection
never leaks a repo across an org boundary. Cross-org edges are rejected at write time. (Open item
§7.)

---

## 4. Detection layer

Detectors are **writers** into `RepoDependency`. They run as activities (deterministic parsers) or a
resolved agent (LLM inference), triggered on connection create/update and on a schedule — mirroring
how scanners and lesson-consolidation already run. Each detector owns its `source` value, so re-runs
are idempotent upserts on the `(pair, kind, source)` unique key.

### 4.1 The four sources

| Source (`source`) | Mechanism | `kind` | Cost |
| --- | --- | --- | --- |
| **`manual`** | Admin declares "A depends on B" via UI/API | any | none |
| **`manifest`** | Parse `package.json` / `go.mod` / `requirements.txt` / `pom.xml` / `Cargo.toml` / `*.csproj`; resolve internal package names → registered repos (match on a repo's declared package name / org scope) | `code` / `build` | cheap, deterministic |
| **`git_signal`** | Submodules (`.gitmodules`), monorepo path structure, `CODEOWNERS`, CI pipeline cross-repo refs | `build` / `runtime` | cheap, deterministic |
| **`inferred`** | A resolved agent reads READMEs, import statements, naming conventions, shared org conventions → proposes edges | any | LLM tokens |

Manifest + git-signal parsing reads files from the repo. Two viable read paths: (a) the SCM API
(`get_file_contents`-style fetch of specific manifests — cheap, no clone) for the common case, or
(b) inside an ephemeral workspace when a full tree walk is needed. v1 prefers the API fetch for
manifests; git-signal submodule/CODEOWNERS reads are also single-file fetches.

**Internal-package resolution** is the crux of manifest parsing: mapping a dependency string
(`@acme/payments-sdk`, `github.com/acme/payments-sdk`, `acme-payments-sdk`) to a registered
`Connection`. v1 strategy: match against a repo's `organizationName`/`repoName` and an optional
declared **package name(s)** field (new, nullable, admin-editable on the repo) — external/third-party
deps that don't resolve to a registered repo are simply dropped (they're not repos we can inject).

### 4.2 Tiered trust (how edges get applied)

| Source | Lands as | Confidence |
| --- | --- | --- |
| `manual` | `active` | 1.0 |
| `manifest` | `active` | 1.0 |
| `git_signal` | `active` | 1.0 |
| `inferred` | `proposed` | model-reported, `<1.0` |

- Deterministic edges enter the graph immediately.
- **Inferred edges land `proposed`** — they need a human confirm/dismiss, *or* auto-promote to
  `active` above a configurable confidence threshold (a `WorkflowDefaults`-style config, default
  conservative). This keeps a hallucinated import from silently poisoning review context (RFC risk
  §7), while still letting a high-confidence, clearly-correct inference flow through without manual
  toil. (Decision §8.3.)
- A human **dismiss** is sticky: the resolver excludes a dismissed pair even if a detector re-asserts
  it, so operators aren't fighting the detectors.

### 4.3 Triggering

- **On connection create/update:** enqueue a detection pass for that repo (manifest + git-signal
  synchronously-ish; inference optionally/async).
- **On a schedule:** a periodic re-scan (Temporal Schedule, like the consolidation / re-validation
  schedules) catches manifest drift and newly-registered repos that become resolution targets for
  existing repos' deps.
- **Manual re-scan** button in the admin UI.

---

## 5. Context injection layer

A new resolver — call it `resolveRepoDependencyContext(repoId, ctx)` — walks the graph 1 hop each
direction, filters by visibility, and assembles a context payload at a chosen **depth tier**. It is a
read-side sibling of the existing `resolveAgent` / config resolvers.

### 5.1 Depth tiers

| Tier | What it injects | Cost |
| --- | --- | --- |
| **`interface`** (default) | Neighbor repos' manifests + exported public API signatures/types | low — fetched files, prompt-injected |
| **`docs`** (default) | Neighbor repos' README / package descriptions | low |
| **`downstream`** (default) | Reverse-walk list: "these repos consume what you changed" + their call sites into the changed surface | low–medium |
| **`full_checkout`** (flagged) | Clone neighbor repos read-only into the workspace so agents can grep/read actual source | high — multiplies clone cost + container size; gated by template / budget tier |

Defaults inject the three cheap tiers; `full_checkout` is opt-in per workflow template / budget tier.

### 5.2 Injection points (all three agent groups — decision §8.2)

1. **Review network (primary).** Extend the review payload so the three reviewers receive a compact
   cross-repo context block (upstream contracts + downstream consumers). Rendered like
   `formatDesignContext` renders Figma context today. This is the named use case — the reviewer can
   now flag "this signature change breaks `payments-api`."
2. **Implementer.** Inject upstream dependency contracts into the implementer's system prompt *before*
   it writes code, so it honors the contracts up front rather than getting caught at review. Reuses
   the `formatDesignContext` injection pattern in `executeImplementation`.
3. **Planner / decomposer.** Feed the persisted graph to the planning agents so cross-repo work is
   ordered correctly — and so the **Epic orchestrator can seed its `dependsOn` DAG from stored edges**
   instead of re-deriving it via an LLM call every time. This closes the loop: the ephemeral epic-only
   concept becomes a read of the durable graph.

### 5.3 `full_checkout` mechanics

`workspace.ts` currently clones exactly one repo. `full_checkout` extends it to clone 1-hop neighbors
read-only into sibling directories (e.g. `/workspace/deps/<repo>`), reusing the existing hardened
clone path + credential scrubbing. Bounded: only 1-hop, only `active` edges, capped count, behind the
flag.

### 5.4 Integration seams on the current tree

Two existing mechanisms this design threads through, worth naming so implementation aligns with them:

- **`requireRepoId`** (`packages/worker/src/lib/requireRepoId.ts`) — `RepoWorkRequest.repoId` is now
  nullable (a generic trigger may launch a run with no connection), and each step that needs a repo
  resolves it through this guard (throws non-retryable `NO_CONNECTION` otherwise). The
  `resolveRepoDependencyContext` resolver must therefore **no-op gracefully when the run has no
  connection** — dependency injection is a git-repo-run concern, exactly like the guard.
- **`launchTrackedWorkflow`** (`packages/gateway/src/lib/workflowLaunch.ts`) — every workflow launch
  now funnels through this ledger-first + dedup + compensate wrapper. It is *not* a place to compute
  dependency context (that stays inside activities, off the workflow isolate), but it is the single
  choke point where a run is bound to its connection, so it anchors where the resolver is later called
  from the activity side.

The `isCrossRepo` flag on the work-request model (epic/parent-child span marker, repo list carried in
the payload) is **orthogonal** to this graph — it flags that a request spans repos; it is not a
persisted repo-to-repo edge. The two coexist; P2 lets the epic planner *seed* `dependsOn` from the
durable graph, but the flag itself is unchanged.

---

## 6. Roadmap

Phased so each lands independently. Front-loads the durable, trustworthy pieces; defers the fuzzy and
expensive ones.

### P0 — Graph foundation *(greenlit; no LLM cost, no behavior change)*
- `RepoDependency` model + CHECK constraints + migration; `Connection` back-relations + optional
  `packageNames` field.
- **Manual/declared edges:** admin API (`/api/v1/admin/repos/:id/dependencies` CRUD) + a repo
  management UI to view/add/confirm/dismiss edges.
- **Read-side resolver** `resolveRepoDependencyContext` (graph walk + reconciliation + visibility
  filter) — returns structured neighbors, no injection yet.
- Tests: migration applies; edge CRUD; resolver walks both directions, honors dismiss, filters
  visibility.

### P1 — Deterministic detectors
- **Manifest parser** (`source='manifest'`) — package.json/go.mod/requirements/pom/Cargo/csproj →
  internal-package resolution → `active` edges.
- **Git-signal detector** (`source='git_signal'`) — submodules / monorepo paths / CODEOWNERS.
- Trigger on connection create/update + a Temporal Schedule re-scan + manual re-scan button.
- Tests: fixture manifests → expected edges; resolution hits/misses; idempotent re-runs.

### P2 — Context injection
- Wire `resolveRepoDependencyContext` into the **review network** (primary), the **implementer**, and
  the **planner/decomposer** — `interface` + `docs` + `downstream` tiers.
- `full_checkout` tier behind a template/budget flag (`workspace.ts` multi-repo clone).
- Epic orchestrator seeds `dependsOn` from stored edges.
- Tests: reviewer/implementer prompts carry the context block; full-checkout clones neighbors; epic
  reads graph.

### P3 — LLM inference + reconciliation
- **Inference agent** (`source='inferred'`, resolved via the agent cascade) → `proposed` edges +
  confidence.
- Confirm/dismiss UX; auto-promote-above-threshold config in `WorkflowDefaults`.
- Tests: proposed edges don't enter injection until confirmed/promoted; dismiss is sticky.

---

## 7. Risks & open questions

- **Context explosion.** Even 1-hop injection can be large for a hub repo (a shared SDK consumed by
  dozens). Mitigations: cap neighbor count, prefer `interface`/`docs` over `full_checkout`, rank
  neighbors by edge confidence + how many changed files touch the shared surface.
- **Stale edges.** Manifests drift; a deleted dependency leaves a stale `active` edge until the next
  scheduled scan. The scheduled re-scan + a `detectedAt`/`updatedAt` freshness signal address this;
  consider expiring manifest edges not re-observed in N scans.
- **Internal-package resolution ambiguity.** Same package name across orgs, forks, renamed repos. v1
  scopes resolution to registered repos + declared `packageNames`; misses drop silently (safe — no
  false injection). Surfacing "unresolved dependency strings" in the UI is a nice-to-have.
- **Inferred-edge trust.** Covered by the tiered model, but the auto-promote threshold needs tuning
  against real data — start conservative (confirm-only), raise once we see precision.
- **Cross-org / cross-team edges.** v1: allow within an org, reject across orgs, resolver filters by
  the run's visibility. Whether platform-admin-declared global SDKs should cross orgs is deferred.
- **Read path for manifests.** SCM API fetch vs. ephemeral workspace — v1 prefers API fetch; large
  monorepos with many manifests may need a bounded tree walk.

---

## 8. Decisions log

Locked in the alignment discussion that produced this RFC:

1. **Entity shape — extend `Connection`.** No separate `Repository` table; git-repo Connections gain
   an edge graph + management surface. Preserves the P3 unification and the stable `repoIds`/
   `repository` API. (§2, §3.)
2. **Injection scope — review network + implementer + planner/decomposer.** All three agent groups
   receive dependency context; the review network is the primary/named use case. (§5.2.)
3. **Trust model — tiered by source.** Manifest/manual/git-signal → `active` automatically; LLM
   inference → `proposed` (confirm, or auto-promote above a confidence threshold). (§4.2.)
4. **Graph scope — both directions, 1 hop.** Upstream contracts + downstream blast-radius, direct
   neighbors only for v1; transitive deferred. (§2.)
5. **Detection sources — all four.** Manual, manifest, git/CI signal, LLM inference. (§4.1.)
