# Package registries

> Admin-managed npm registries that agent workspaces install through a worker-side proxy. The
> upstream credential never enters the container; the workspace holds only a per-workspace proxy
> token.

---

## 1. What it does

An agent workspace runs `npm`/`yarn`/`pnpm`/`pnpm` installs against the deployment's package
registries. Without this feature the container hits the public npm registry (or whatever a
project `.npmrc` names) directly — which cannot reach an internal Artifactory and cannot use a
credential that must stay out of agent hands.

With `REGISTRY_PROXY_PORT` set, the worker listens on a **registry proxy**. Each workspace that
starts gets, before the container is created, a random 32-byte token registered at the proxy
(stored only as a sha256 digest). The container is configured — through environment and a
generated `npmrc` — to send installs to `http://<proxy>/npm/<registryId>/…` with that bearer
token. The proxy adds the real upstream credential server-side, so a token read out of the
container is good only at the proxy, only for that workspace's lifetime, and in lockfile mode
only for the dependencies committed on the base ref. It is **read-only**: GET and HEAD only.

The threat model is a prompt-injected agent: the real registry credential must never enter the
container, and the proxy enforces that server-side rather than trusting the client.

## 2. Registries

`PackageRegistry` rows are managed by platform admins in **Admin → Integrations → Package
registries** and under `POST/PATCH/DELETE /api/v1/admin/package-registries` (`GET` lists). Each
row has a name, `upstreamUrl`, `authKind` (`bearer`, or `basic` where the stored value is
`user:password`), `accessMode`, `allowPrivateNetwork` (the SSRF check is waived for private
upstreams — Artifactory is usually internal), an optional `teamId` (null = every team),
`npmScopes` (e.g. `@acme`; empty = the default registry for unscoped packages), and a write-only
encrypted token (`hasToken`/`tokenLastFour` is all the API reports). Every change writes a config
audit-log entry.

Write-time uniqueness: among active rows of one team group (null is its own group), at most one
default registry and each scope at most once — clashes are refused with `409`. Resolution for a
workspace of team T takes active rows where `teamId IN (T, null)`; per key (the default key and
each scope) a team row beats a global one.

## 3. Access modes

- **`open`**: the proxy forwards any package the upstream serves.
- **`lockfile`** (default): only `name@version` pairs present in the workspace's committed
  lockfiles resolve. The allowlist is built from the ref the workspace was cut from — HEAD after
  clone, the pinned SHA, or the fetched `origin/<defaultBranch>` for an existing-branch
  workspace — by `git ls-tree` + `git show` over `package-lock.json`, `yarn.lock` and
  `pnpm-lock.yaml`, never from the working tree, so an agent cannot widen its own allowlist. A
  lockfile that cannot be parsed contributes nothing (fail closed); no lockfiles means the
  allowlist is empty and every package is denied.

## 4. How clients are configured

The container env carries `NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc`,
`NPM_CONFIG_REGISTRY=<default proxy URL>` (when a default registry exists),
`NPM_CONFIG_REPLACE_REGISTRY_HOST=always`, `NPM_CONFIG_AUDIT/FUND/UPDATE_NOTIFIER=false`, and for
Yarn Berry `YARN_NPM_REGISTRY_SERVER`, `YARN_NPM_AUTH_TOKEN`, `YARN_NPM_ALWAYS_AUTH=true` — env
beats a project `.npmrc`/`.yarnrc.yml` for these keys, which is why the default registry goes
through env. The generated npmrc holds one `//host:port/npm/<id>/:_authToken` line per registry
and one `@scope:registry=<proxy url>` per scope (written `chmod 600`). Berry scoped registries
live in the exec user's `$HOME/.yarnrc.yml`.

## 5. The proxy

Request handling (`packages/worker/src/lib/registryProxy/`): the URL layout is
`<baseUrl>/npm/<registryId>/<npm path>`; an unknown token is 401, an unregistered `registryId`
404, a non-GET/HEAD method 405, and anything outside the two npm path shapes (packument `/<name>`,
tarball `/<name>/-/<file>.tgz`) a JSON 404 — search, audit and `/-/…` endpoints do not exist. The
upstream request carries the registry's credential header, the client's `accept`,
`accept-encoding: identity` for packuments, `redirect: 'error'`, and the SSRF-guarded fetch
(`allowPrivateNetwork` honoured per registry). Until the workspace's allowlist is set the
registration answers 503 — `createWorkspace` returns only once it is set, so the agent never
reaches that state. Denials return `403` with
`{"error":"auto-swe: <name>[@<version>] is not in the repository's committed lockfiles; …"}` and
are logged through the activity logger (`logWarn`) with the container, registry and package.

Packuments are buffered (64 MiB cap), never cached, and rewritten so every `dist.tarball` points
back at the proxy; in lockfile mode disallowed versions are filtered out along with their
`dist-tags`/`time` entries. Tarballs stream with backpressure.

**Cache.** With `REGISTRY_PROXY_CACHE_DIR` set, tarballs are cached under
`<dir>/<registryId>/<sha256(url)>` — written to a temp file and renamed only on a complete 200,
so a partial response is never cached. A hit refreshes mtime; when the total exceeds
`REGISTRY_PROXY_CACHE_MAX_BYTES` (default 2 GiB) the oldest entries are evicted until usage is
under 90%. Cache errors fall through to the upstream.

## 6. Configuration

| Variable | Purpose |
|---|---|
| `REGISTRY_PROXY_PORT` | Enables the proxy; port the worker listens on. Unset = no registry wiring. |
| `REGISTRY_PROXY_URL` | Base URL a workspace reaches the proxy at; `{hostname}` resolves per replica. Default `http://host.docker.internal:$PORT` (the host-gateway alias is then added to the container). |
| `REGISTRY_PROXY_BIND` | Listen address, default `0.0.0.0`. |
| `REGISTRY_PROXY_CACHE_DIR` | Tarball cache directory; unset disables the cache. |
| `REGISTRY_PROXY_CACHE_MAX_BYTES` | Cache cap, default 2 GiB. |

## Limitations

- **npm only, and read-only.** Other ecosystems (PyPI, Maven, Go modules) and publishing are out
  of scope.
- **Upstream redirects are refused** (`redirect: 'error'`). An Artifactory that redirects
  downloads to object storage does not work.
- **Berry scoped registries live in the exec user's home rc**, which a project `.yarnrc.yml`
  scope entry overrides; that fails closed (the scope resolves against the real registry without
  the proxy credential).
- **A dependency the agent adds cannot be installed in lockfile mode** — gates included — until
  it is committed on the base branch and a fresh workspace is cut.
- **Ephemeral shell/container steps get no registry access** — the wiring lives in
  `createWorkspace`, not the step sandboxes.
- **The cache holds tarballs only**; packuments are always re-fetched.
- **Denials surface as 403s to the installer** (the usual "package not found"-adjacent error
  shape with the auto-swe message) and as `logWarn` entries on the run's activity — there is no
  dedicated denial UI.
- **Tool bootstrap has no token.** Corepack's own downloads (`pnpm`/`yarn` shims fetching their
  binaries) carry no registry credential and get a 401. The executor image must ship the package
  managers the repo pins already installed. The curated Node image enables Corepack but does not
  pre-install `pnpm` or `yarn`, so a pnpm or Yarn repository needs an image that does.
- **npm can request a scoped tarball through the default registry.** With
  `replace-registry-host=always`, npm rewrites lockfile `resolved` hosts to `NPM_CONFIG_REGISTRY`,
  so a scoped package's tarball can arrive at the default registry's proxy path. It is then
  fetched from the default registry's upstream. The allowlist still covers it, because the wiring
  builds one allowlist per repository. A scope that only a different upstream serves can fail.
