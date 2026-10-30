# Package proxies beyond npm — decision log

The worker's registry proxy serves npm, Go modules, PyPI and Maven ([`package-registries.md`](../package-registries.md)).
Gradle and wrapper-based builds reach their repositories directly: no private index, no credential
that stays out of the agent's hands, no lockfile-scoped access. This records how to extend the
proxy, in what order, and what is deliberately left out. Each decision is **Proposed** until the
slice that carries it merges; all three slices are **Accepted**.

## D1 — 2026-10-29 — One proxy per ecosystem, the npm proxy's model

**Status**: Proposed
**Decision**: Each ecosystem gets a read-only proxy in the worker with the npm proxy's contract: a
random per-workspace token stored only as a digest, the upstream credential added server-side, GET
and HEAD only, redirects refused, the upstream reached through the SSRF-guarded fetch, a registration
that answers 503 until its allowlist is set, and the same buffered-fetch limits (slot, deadline,
hang-up). The protocol code is separate per ecosystem; the registration, token, limits and
lifetime are shared.
**Reason**: The npm proxy's guarantees are the point — a credential read out of the container is
good only at the proxy, only for that workspace, and in lockfile mode only for what the base ref
commits. A generic forwarder would have to give those up or re-derive them per protocol anyway.
**Alternatives considered**: One generic HTTP forward proxy with a host allowlist, which cannot scope
access to a lockfile or hide a credential per package. Running each ecosystem's own mirror
(Artifactory, devpi) in the deployment, which is the deployer's choice today and stays one: the proxy
fronts such a mirror, it does not replace it.

## D2 — 2026-10-29 — Go modules first, then PyPI, then Maven

**Status**: Accepted
**Decision**: Build in that order, one pull request per ecosystem, each shippable alone.
- **Go**: the `GOPROXY` protocol is four read-only paths (`/<module>/@v/list`, `.info`, `.mod`, `.zip`),
  and `go.sum` is a committed, content-hashed list of exactly the modules and versions a build may
  fetch, so lockfile mode is exact. Wired with `GOPROXY`, `GOSUMDB` left at its default so the
  committed hashes still verify what the proxy serves, and `GOTOOLCHAIN=local`. The client token is a
  path segment of the `GOPROXY` URL: the Go tool refuses to send userinfo credentials over plain
  http (checked against Go 1.26), and `GOINSECURE` and `GOAUTH` do not change that.
- **PyPI**: the simple index (PEP 503, with PEP 691's JSON form) plus the file URLs it names, which the
  proxy rewrites to itself as the npm proxy rewrites `dist.tarball`. The allowlist comes from
  `uv.lock`, `poetry.lock` or a `requirements.txt` that pins versions; an unpinned requirements file
  has no allowlist, so it can use only `open` mode. Built for pip and uv: the client token is a path segment of the index URL (as for Go), and the
  registry credential goes only to file URLs under the registry's own path.
- **Maven**: last, because Maven has **no committed lockfile**. Lockfile mode has nothing to read,
  so a Maven registry is `open` mode only until a source for the allowlist exists (Gradle's
  dependency locking and a resolved-dependency report are candidates, neither universal). Built for `mvn`:
  open mode only, a `settings.xml` mirror of `*`; the admin API refuses `lockfile` on a Maven row.
**Reason**: Go and PyPI have a committed artifact that makes the proxy's strongest mode meaningful;
Maven would ship the weaker mode first and invite the assumption that it is the strong one. Go's
protocol is the smallest, so it proves the shared parts (registration, limits, wiring, admin) for the
two that follow.
**Alternatives considered**: PyPI first, which is the larger audience but the larger protocol and
needs rewriting of file URLs before the shared parts are proven. All three in one change, which is
too large to review or to roll back by ecosystem.
**Known limits**: A Maven or unpinned-Python repository in `open` mode can fetch anything its
registry serves; it gets the credential protection but not the lockfile scope.

## D3 — 2026-10-29 — Reuse `PackageRegistry`, keyed by its `ecosystem`

**Status**: Accepted
**Decision**: The admin-managed `PackageRegistry` row already carries `ecosystem` (default `npm`). New
ecosystems use it: `go`, `pypi`, `maven`. `npmScopes` stays npm's; routing for the others is by the
registry that claims the repository's ecosystem, with the same default/override rules. The admin
routes and form gain the ecosystem as a field and validate the upstream URL per ecosystem. No new
table.
**Reason**: The row, its encrypted token, team scoping, activation and audit already exist and are
ecosystem-neutral except `npmScopes`. A second table would copy all of it.
**Alternatives considered**: One table per ecosystem, which duplicates credential handling.
Overloading `npmScopes` for other ecosystems' namespaces, which hides a different meaning behind a
name.

## D4 — 2026-10-29 — The workspace is wired by what the repository's stack needs

**Status**: Accepted
**Decision**: `beginWorkspaceRegistries` wires an ecosystem only when the repository's detected stack
(or component, for a layout of several) uses it, and renders that ecosystem's client configuration
into the workspace the way it renders `.npmrc` today: the Go environment variables, `pip.conf` and
`uv`'s index settings for Python, a `settings.xml` mirror for Maven. Credentials appear only as the
per-workspace proxy token.
**Reason**: A Node repository must not receive a Python index it never uses, and wiring on the stack
keeps the token's reach to what the run needs.
**Alternatives considered**: Wiring every ecosystem into every workspace, which widens the surface for
no benefit.
**Known limits**: Wiring follows the stored detection, so it inherits that detection's cadence and its
single-component-or-composite rules ([`repositories.md`](../repositories.md#detected-stack)).

## D5 — 2026-10-29 — What stays out

**Status**: Proposed
**Decision**: No write or publish path in any proxy. No proxying of a package manager's own bootstrap
(a pinned `uv`, `pip`, Maven or Go toolchain comes from the executor image, not a registry). No audit
endpoint for ecosystems whose advisory service is a separate host, until each has been read to see
whether it could be relayed without disclosing private names — the npm audit relay is the model, and
its refusals (a private scope's names never go to a registry that does not own them) apply unchanged.
**Reason**: Each is a larger surface than the install path, and the npm proxy's read-only,
single-purpose shape is what makes it reviewable.
