# Package registries

> Admin-managed npm registries that agent workspaces install through a worker-side proxy. The
> upstream credential never enters the container; the workspace holds only a per-workspace proxy
> token.

---

## 1. What it does

An agent workspace runs `npm`/`yarn`/`pnpm` installs against the deployment's package
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

The threat model covers both accidental leakage and a prompt-injected agent. The real registry
credential never enters the container, so neither a log line nor an agent can expose it. The
proxy enforces read-only, lockfile-scoped access server-side rather than trusting the client.

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

**Container env:**
- `NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc`
- `NPM_CONFIG_REGISTRY=<default proxy URL>` (when a default registry exists)
- `NPM_CONFIG_REPLACE_REGISTRY_HOST=always`
- `NPM_CONFIG_AUDIT/FUND/UPDATE_NOTIFIER=false`
- for Yarn Berry: `YARN_NPM_REGISTRY_SERVER`, `YARN_NPM_AUTH_TOKEN` and
  `YARN_NPM_ALWAYS_AUTH=true`
- for Corepack (when a default registry exists): `COREPACK_NPM_REGISTRY`, `COREPACK_NPM_TOKEN`
  and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`

These env keys beat a project `.npmrc` or `.yarnrc.yml`, which is why the default registry goes
through env.

**The generated npmrc** is written `chmod 600` both to `NPM_CONFIG_USERCONFIG` and to the exec
user's `$HOME/.npmrc`. It holds:
- a host-level `//host:port/:_authToken` line and `always-auth=true`
- one `//host:port/npm/<id>/:_authToken` line per registry
- one `@scope:registry=<proxy url>` line per scope

Yarn classic needs the `$HOME` copy and the host-level line. It reads `.npmrc` only from the
project directory and `$HOME`, matches auth by host, and sends no auth header without
`always-auth`.

**The exec user's `$HOME/.yarnrc.yml`** lists the proxy host on `unsafeHttpWhitelist` (Yarn 4
refuses an `http://` registry otherwise) and the Berry `npmScopes`.

**Package managers.** `defaults/Dockerfile.node` pre-installs pnpm 10.34.7, Yarn classic 1.22.22
(the `yarn` default) and Yarn Berry 4.18.1 through Corepack, so a repository that pins none of
them, or pins one of these versions, starts its install with no download. Any other pin is fetched
by Corepack from the default registry through the proxy. The allowlist admits it, because
`packageManager` pins found in `package.json` files at the base ref (at the root and beside each
lockfile) are added to it: `pnpm@v` and `npm@v` as themselves, `yarn@1.x` as `yarn`, and
`yarn@2+` as `@yarnpkg/cli-dist`.

Corepack reads the version manifest `/<package>/<version>` and downloads the tarball it names.
Unless the pin carries a hash (`pnpm@9.15.9+sha512.<hex>`), it then verifies the manifest's
`dist.signatures` against npm's public signing keys. The proxy passes signatures through
untouched, so a pin resolved against `registry.npmjs.org`, or a mirror that preserves them,
verifies. A hash-pinned `packageManager` is checked against its hash instead and needs no
signatures.

**All four clients are tested end to end.** `npm ci`, `pnpm install --frozen-lockfile`, Yarn
classic `--frozen-lockfile` and Yarn Berry `--immutable` each install through the proxy in
lockfile mode, and each shows the denial message when a package outside the lockfile is added.
The suite is `registryProxy/clients.docker.test.ts`, run in CI against the curated Node image.
It also has Corepack download a pin that the image doesn't have, through the proxy. The cases
cover a valid signature, a forged one (refused), a hash pin with no signatures, and a pin outside
the allowlist (denied).

**Shell steps.** A `network: 'egress'` shell step gets the same wiring, with these differences:
- Its container's root filesystem is read-only, so its `HOME` is `/workspace/.auto-swe/home` in
  the step volume, outside the checkout the finalize commits.
- The npmrc and Berry rc are written there by a helper container before the command runs.
- The command container gets the host-gateway alias in its `--add-host` entries, beside any
  egress-allowlist entries.
- The allowlist is built from `origin/<defaultBranch>`, which the clone helper fetches before it
  scrubs the credential.
- The token is revoked as soon as the command exits.

## 5. The proxy

**URL layout.** `<baseUrl>/npm/<registryId>/<npm path>`. Only three npm path shapes exist:
- packument: `/<name>`
- version manifest: `/<name>/<version>`, which Corepack reads. In lockfile mode the version must
  be allowlisted, so a dist-tag such as `latest` is denied.
- tarball: `…/<name>/-/<file>.tgz`

A scoped name may be written `@scope/pkg`, `@scope%2fpkg` or `%40scope%2fpkg`.

Anything else, including search, audit and `/-/…` endpoints, is a JSON 404.

**A tarball path may carry a prefix.** Up to eight segments are allowed, and none may be `.` or
`..` in any encoding. The proxy validates the prefix and then ignores it, and it strips an
`@scope/` prefix from the file name. This is because npm keeps a lockfile `resolved` URL's path
when `replace-registry-host` swaps its origin. So a lockfile resolved against Artifactory
(`…/artifactory/api/npm/repo/@acme/pkg/-/@acme/pkg-1.0.0.tgz`) arrives as
`/npm/<defaultId>/artifactory/api/npm/repo/@acme/pkg/-/@acme/pkg-1.0.0.tgz`.

**Routing is by package name, not by the id in the URL.** The id must belong to the workspace's
registration, but a scoped package goes to the registry that claims its scope, and anything else
to the default registry. No match is a 404. The upstream request is always the canonical path on
the routed registry: `<upstream>/<name>/-/<file>`, or `<upstream>/@scope%2fpkg` for a scoped
packument.

**Status codes:**
- unknown token: 401
- unregistered `registryId`: 404
- a method other than GET or HEAD: 405

**The upstream request** carries the routed registry's credential header, the client's `accept`
header, `accept-encoding: identity` for packuments, and `redirect: 'error'`. It goes through the
SSRF-guarded fetch, which honours each registry's `allowPrivateNetwork`.

**Not-ready state.** Until the workspace's allowlist is set, the registration answers 503.
`createWorkspace` returns only once it is set, so the agent never reaches that state.

**Denials** return a `403`:
- body: `{"error":"auto-swe: <name>[@<version>] is not in the repository's committed lockfiles; …"}`
- the same message as the HTTP reason phrase, because pnpm prints only the reason phrase
- logged through the activity logger (`logWarn`) with the container, registry and package

**Packuments and version manifests** are buffered (64 MiB cap) and never cached. They are
rewritten so every `dist.tarball` points back at the proxy, under the routed registry's id;
nothing else in them changes. In a lockfile-mode packument, versions that aren't allowed are
filtered out, along with their `dist-tags` and `time` entries. Because each one is held in memory
and re-serialised, a workspace has at most 8 of them in flight; a request past that waits (up to 32
waiting, at most 30 seconds) and then gets `503` with `Retry-After`, which npm and Yarn retry.

**Tarballs** stream with backpressure.

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

- **npm only, and read-only.** Other ecosystems (PyPI, Maven, Go modules) are not served, and
  neither is publishing.
- **Upstream redirects are refused** (`redirect: 'error'`). An Artifactory that redirects
  downloads to object storage does not work.
- **Yarn classic must have a default-host lockfile.** Yarn classic rewrites only
  `registry.yarnpkg.com` and `registry.npmjs.org` hosts in `yarn.lock` to the configured
  registry. A `yarn.lock` whose `resolved` URLs name another host, such as an Artifactory, is
  fetched from that host directly, without the proxy, and fails.
- **Berry scoped registries live in the exec user's home rc**, and a project `.yarnrc.yml` scope
  entry overrides them. That fails closed: the scope resolves against the real registry without
  the proxy credential.
- **A Corepack pin needs signatures or a hash.** An upstream that strips `dist.signatures` from
  version manifests fails Corepack's verification for a pin without a `+sha512.` hash. The fix
  is to hash-pin `packageManager`; the workspace never sets `COREPACK_INTEGRITY_KEYS` to disable
  the check.
- **A dependency the agent adds cannot be installed in lockfile mode**, gates included, until it
  is committed on the base branch and a fresh workspace is cut.
- **Shell steps need egress and the default proxy address.** A `network: 'none'` step gets no
  registry access. So does a step on a deployment that advertises the proxy at a host other than
  the Docker host alias (a `WORKSPACE_NETWORK` hostname), because shell-step containers don't
  join that network. The step runs without the wiring and logs a warning. Berry scoped registries
  in a shell step can likewise be overridden by the project's `.yarnrc.yml`.
- **Container steps get no registry access.** A container-contract step has no repository and no
  lockfile.
- **The step's proxy token passes through the worker's docker client arguments.** The npmrc
  content reaches a shell step's helper container as an environment value, so it never sits in a
  command line the author command can read, but it does pass through those arguments, like every
  step env value.
- **The cache holds tarballs only**; packuments are always re-fetched.
- **Denials have no dedicated UI.** They surface as 403s to the installer and as `logWarn`
  entries on the run's activity.
