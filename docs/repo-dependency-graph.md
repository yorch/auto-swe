# Repo Dependency Graph

auto-swe models each Git repository as a `Connection` (`type='git_repo'`). The repo dependency graph
adds **directed relationships between those repos** — "repo A depends on repo B" — as durable,
queryable data, so the platform can reason about how a change to one repo relates to others.

A repo is a node; a `RepoDependency` row is a directed edge from the **dependent** repo (`from`) to
the repo it **depends on** (`to`). Edges carry a `kind` (`code` / `runtime` / `build` / `api` /
`data`), a `source` (how the edge was established), a `confidence`, and a `status`.

## What the graph stores

Each edge is one `repo_dependencies` row. Its columns:

| Column | Meaning |
|---|---|
| `fromRepoId` | The dependent repo (the `:id` in the API). |
| `toRepoId` | The depended-upon repo. Null for an **unresolved suggestion** — a detected dependency on a package whose repo is not onboarded. |
| `toRef` | The raw dependency string for an unresolved suggestion (e.g. `@acme/payments-sdk`); null once resolved to a repo. |
| `kind` | Edge semantics: `code`, `runtime`, `build`, `api`, or `data`. |
| `source` | Provenance: `manual`, `manifest`, `git_signal`, or `inferred`. |
| `confidence` | `1.0` for declared/observed edges; lower for inferred ones. |
| `status` | `active` (in the graph), `proposed` (awaiting confirmation), `dismissed` (a sticky human veto), or `unresolved` (a suggestion). |

Two partial unique indexes keep the two row shapes distinct — one per `(from, to, kind, source)` for
resolved edges, one per `(from, toRef, kind, source)` for suggestions. CHECK constraints forbid a
self-edge, require a row to name either a repo or a `toRef`, and bound the `status`/`source` strings.
The `repo_dependencies` table and `connections.package_names` are in the generated `init` baseline;
their partial unique indexes and CHECK constraints live in the hand-written
`00000000000001_custom_constraints_and_indexes` migration.

## Managing edges

Edges are managed through the `Connection`'s team-scoped API, mounted under `/api/v1/repositories`,
so the `:id` path segment is always the dependent repo:

- `GET /api/v1/repositories/:id/dependencies` — the repo's outgoing edges (**depends on**) and
  incoming edges (**depended on by**), with each neighbour repo hydrated and filtered to the caller's
  organization. Open to any team member (`ENGINEER`).
- `POST /api/v1/repositories/:id/dependencies` — declare a manual edge to another repo.
- `PATCH /api/v1/repositories/:id/dependencies/:edgeId` — confirm/reactivate (`status: active`) or
  dismiss (`status: dismissed`).
- `DELETE /api/v1/repositories/:id/dependencies/:edgeId` — remove an edge.

The dashboard surfaces this on the **Connections** page: each git-repo card has a **Dependencies**
action opening a panel that lists both directions and, for a `LEAD`/`ADMIN`, lets them add, dismiss,
reactivate, and remove edges.

### Authorization

Dependencies routinely cross team boundaries — a shared platform repo is depended on by many product
repos — so edge management has its own rules, asymmetric by intent:

- **Declaring or confirming a manual edge** requires `LEAD` (or `ADMIN`) on **both** the dependent
  and the depended-upon repo's teams. A human asserting a relationship needs both sides' consent, and
  the depended-upon team consents to becoming a context source.
- **Dismissing** an edge is the depended-upon team's veto: a `LEAD` on that team can dismiss any edge
  pointing at its repo, opting the repo out. A dismissal is sticky.
- **Removing** an edge needs a `LEAD` on either team.
- Edges may cross teams within an organization but never cross an organization boundary; the write
  path rejects a cross-org edge, and reads filter neighbours to the caller's organization.

## Detection

Edges are mostly not entered by hand. A detector activity reads a repo's own files over the SCM API
(no clone) and records what it finds:

| Source | Read from | Confidence |
|---|---|---|
| `manifest` | `package.json`, `go.mod`, `requirements.txt`, `pom.xml`, `Cargo.toml` | 1.0 |
| `git_signal` | `.gitmodules`, `CODEOWNERS` | 1.0 |
| `inferred` | An LLM reading repo metadata (see below) | model-reported |
| `manual` | An operator declaring the edge | 1.0 |

A raw dependency string is resolved to a registered repo by, in order: an exact match against the
repo's declared `packageNames`; an `org/repo` match in any git-URL spelling; then an unambiguous bare
repo name. Deterministic sources are treated as evidence and land `active` — they record a fact
already true in the code, so the depended-upon team holds a **dismiss veto** rather than a
pre-approval gate, and a dismissal is never undone by a later scan.

Detection is idempotent: re-running finds the existing row and refreshes it rather than duplicating.

**Unresolved dependencies become onboarding suggestions.** A dependency on a package whose repo
nobody has onboarded is recorded with `toRepoId` null and the raw string in `toRef`. The Connections
page lists these grouped by ref, so the graph tells you which repo is worth onboarding next and who is
waiting on it. When that repo is later onboarded, the next scan resolves the dependency and closes the
suggestion out.

A Temporal Schedule sweeps every active git repo (`repoDependency.scanCron` /
`repoDependency.scanEnabled`), and an ADMIN can run the sweep on demand from the Connections page.
Per-repo failures are contained, so one unreachable repo cannot abort the sweep.

### Inference

`POST /api/v1/repositories/:id/dependencies/infer` (LEAD on that repo's team) asks the seeded
`repoDependencyInferrer` agent for relationships no manifest states. It is per-repo and opt-in rather
than part of the scheduled sweep, because it costs a model call while the deterministic detectors are
free.

A model can invent a relationship, so its output is treated as a claim: every returned edge is checked
against the candidate set, rejected if it is a self-edge, an unknown kind, or an out-of-range
confidence, and the accepted set is capped. Survivors land `proposed` — excluded from agent context —
until a human confirms them, or until they clear `repoDependency.autoPromoteThreshold` (default 0.9).
Auto-promotion applies only within a team: skipping the confirmation step is only ever skipping one
the promoting team was entitled to give.

## Resolving a repo's neighbours

`resolveRepoDependencyContext(prisma, repoId, { orgId })`
(`@auto-swe/shared/lib/repoDependencyResolver`) is the read side. It walks one hop in each direction
from a repo, keeps only `active` edges, collapses multiple edges for the same neighbour to the
highest confidence (carrying the distinct kinds and sources), and returns the visible neighbours as
`{ upstream, downstream }`. It filters neighbours to the caller's organization and returns empty when
given no repo id, so a run with no connection resolves to no context. Only `active` edges surface, so
a `dismissed` veto and an unconfirmed `proposed` edge both stay out of the result.

## What the agents see

The graph reaches three agent paths, each best-effort — a graph failure degrades to no context rather
than failing a run:

- **The review network.** All three reviewers get a bounded block naming the repo's upstream contracts
  and its downstream consumers, framed differently per direction: upstream is a constraint to honour,
  downstream is blast radius for a breaking change.
- **The implementer.** The same block joins its system prompt before it writes code, so contracts are
  honoured up front rather than caught at review.
- **The epic planner.** Stored edges are merged into the planner's proposed ordering, so a known
  dependency is authoritative rather than guessed. A stored edge that would close a cycle is dropped,
  since the orchestrator's ready-queue would never drain.

Repo names are flattened and length-capped before they enter a prompt: names are operator-supplied, and
a name containing newlines and headings would otherwise be able to append instructions of its own.

Two per-step config flags control this on a workflow node: `crossRepoContext` (the prompt block, on by
default) and `crossRepoCheckout` (off by default). The checkout tier additionally clones upstream repos
read-only beside the workspace so an agent can read their real source. It is deliberately narrower than
the prompt block: another team's repo is cloned only when a human on both teams agreed the edge, since
handing an agent a repo's full source is not the same as naming it.

## Limitations

- **One hop, no transitivity.** The resolver walks direct neighbours only; it does not follow a
  dependency chain further. Neighbours are capped per direction, so a hub repo depended on by dozens
  shows only its highest-confidence edges.
- **Manifest parsing is name-based, not resolution-accurate.** A dependency is matched by string
  against registered repos; it does not consult a registry, lockfile, or workspace protocol, so a
  renamed package, a fork, or two repos publishing the same name can mismatch. Unmatched strings become
  suggestions rather than silent drops, but a wrong match is possible and is corrected by dismissing.
- **A retired repo leaves a stale edge.** Deactivating a repo does not invalidate edges pointing at it;
  the next scan records the dependency as unresolved again alongside the existing edge until someone
  removes it.
- **Graph coverage tracks onboarding.** A repo becomes a node only when a `LEAD`/`ADMIN` onboards it;
  no webhook auto-registers repos. An edge can only point at an onboarded repo, and the suggestions
  list is the prompt to close that gap.
- **Inference sees metadata, not code.** The inferrer reads repo names, descriptions, languages and
  declared package names — not README or source content — so it is a weak signal by construction, which
  is why its output needs confirmation.

The design rationale is recorded in
[`history/repo-dependency-graph-rfc.md`](./history/repo-dependency-graph-rfc.md).
