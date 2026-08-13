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
The DDL lives in the `00000000000002_repo_dependencies` migration.

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

## Resolving a repo's neighbours

`resolveRepoDependencyContext(prisma, repoId, { orgId })`
(`@auto-swe/shared/lib/repoDependencyResolver`) is the read side. It walks one hop in each direction
from a repo, keeps only `active` edges, collapses multiple edges for the same neighbour to the
highest confidence (carrying the distinct kinds and sources), and returns the visible neighbours as
`{ upstream, downstream }`. It filters neighbours to the caller's organization and returns empty when
given no repo id, so a run with no connection resolves to no context. Only `active` edges surface, so
a `dismissed` veto and an unconfirmed `proposed` edge both stay out of the result.

## Limitations

- **Detection is manual.** The only `source` populated is `manual` — an operator declaring an edge.
  Nothing parses manifests (`package.json`, `go.mod`, …), reads git signals (submodules, CODEOWNERS),
  or infers relationships from code. The `manifest` / `git_signal` / `inferred` sources, the
  `confidence` gradient, the `proposed` and `unresolved` statuses, and the `Connection.packageNames`
  resolution key exist in the schema but no detector writes them, so the graph is only as complete as
  what people enter by hand.
- **No agent consumes it.** `resolveRepoDependencyContext` returns neighbours, but nothing injects
  them into an agent. The review network still sees only the diff, the implementer receives no
  dependency contracts, and the epic planner still derives its own dependency ordering rather than
  reading this graph.
- **One hop, no transitivity.** The resolver walks direct neighbours only; it does not follow a
  dependency chain further, and it does not rank or cap neighbours for a hub repo depended on by many.
- **Graph coverage tracks onboarding.** A repo becomes a node only when a `LEAD`/`ADMIN` onboards it;
  no webhook or scan auto-registers repos. An edge can only point at an onboarded repo.

The design rationale and the shape of the unbuilt detection and injection layers are recorded in
[`history/repo-dependency-graph-rfc.md`](./history/repo-dependency-graph-rfc.md).
