# Package registries

> Admin-managed npm, Go-module and PyPI registries that agent workspaces install through a worker-side
> proxy. The upstream credential never enters the container; the workspace holds only a
> per-workspace proxy token.

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
only for the dependencies committed on the base ref. It is **read-only**: GET and HEAD only, plus the one POST described under *Audit* in §5.

The threat model covers both accidental leakage and a prompt-injected agent. The real registry
credential never enters the container, so neither a log line nor an agent can expose it. The
proxy enforces read-only, lockfile-scoped access server-side rather than trusting the client.

A Go registry is served the same way, on a second route (`/go/…`, §4 and §5). A workspace is wired
to a Go registry only when its repository's stored stack detection
([`repositories.md`](./repositories.md#detected-stack)) lists Go, or is unknown, so a repository
detected as Node-only never receives a `GOPROXY` it has no use for.

A PyPI registry is served on a third route (`/pypi/…`, §4 and §5), wired only into a workspace whose
repository's detection lists Python, or is unknown.

## 2. Registries

`PackageRegistry` rows are managed by platform admins in **Admin → Integrations → Package
registries** and under `POST/PATCH/DELETE /api/v1/admin/package-registries` (`GET` lists). Each
row has a name, `upstreamUrl`, `authKind` (`bearer`, or `basic` where the stored value is
`user:password`), `accessMode`, `allowPrivateNetwork` (the SSRF check is waived for private
upstreams — Artifactory is usually internal), an optional `teamId` (null = every team),
`npmScopes` (e.g. `@acme`; empty = the default registry for unscoped packages), and a write-only
encrypted token (`hasToken`/`tokenLastFour` is all the API reports). Every change writes a config
audit-log entry.

A row's `ecosystem` is `npm` (the default), `go` or `pypi`, and is fixed when the row is created. A `go` or
`pypi` row has no scopes — it is the team's single registry of its ecosystem — and its `upstreamUrl` may carry
no userinfo, query string or fragment, because the proxy appends paths to it. A PyPI row's `upstreamUrl` is its
**simple index** (`https://pypi.org/simple`, or `https://host/artifactory/api/pypi/<repo>/simple`). Resolution for the two
ecosystems never mixes: an npm default, a Go registry and a PyPI registry coexist for one team, and a `go` or `pypi` row can
never be taken for npm's default or claim an npm scope.

Write-time uniqueness: among active rows of one ecosystem of one team group (null is its own group), at most one
default registry and each scope at most once — clashes are refused with `409`. Resolution for a
workspace of team T takes active rows where `teamId IN (T, null)`; per key (the default key and
each scope; a Go or PyPI registry has only the default) a team row beats a global one.

## 3. Access modes

- **`open`**: the proxy forwards any package the upstream serves.
- **`lockfile`** (default): only `name@version` pairs present in the workspace's committed
  lockfiles resolve. The allowlist is built from the ref the workspace was cut from — HEAD after
  clone, the pinned SHA, or the fetched `origin/<defaultBranch>` for an existing-branch
  workspace — by `git ls-tree` + `git show` over `package-lock.json`, `yarn.lock` and
  `pnpm-lock.yaml`, never from the working tree, so an agent cannot widen its own allowlist. A
  lockfile that cannot be parsed contributes nothing (fail closed); no lockfiles means the
  allowlist is empty and every package is denied.

For a **Go** registry the allowlist is every `go.sum` committed at the base ref, at any depth,
read the same way (a `go.work.sum` counts as one). A module version with a plain `go.sum` line may be fetched whole (`.info`,
`.mod`, `.zip`); one with only a `/go.mod` line gets `.mod` and `.info` but no `.zip`. A repository
with no `go.sum` gets an empty allowlist, so every module is denied.

For a **PyPI** registry the allowlist is the `name==version` pairs in every Python lockfile committed at
the base ref, at any depth: `uv.lock`, `poetry.lock`, `pylock.toml`, `Pipfile.lock` and
`requirements*.txt` (only exact `==` pins count; `-r` includes are not followed; paths through
`node_modules`, `.venv`, `venv`, `site-packages`, `.git`, `vendor` and `third_party` are skipped).
Names are compared PEP 503-normalised and versions PEP 440-canonicalised (`1.0.0` is `1`); a version
the parser cannot canonicalise is never allowed. Entries sourced from git, a path or a URL are not
index packages and contribute nothing. With no lockfile the allowlist is empty and every project is
denied.

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

The two token variables (`YARN_NPM_AUTH_TOKEN`, `COREPACK_NPM_TOKEN`) are the workspace's
`secretEnv`, set when the container is created. On Docker they are passed as `-e NAME` with the
value in the docker client's environment. On Kubernetes they come from a per-pod `Secret` through
`secretKeyRef`, so the Pod object never holds the token (see
[`architecture.md`](./architecture.md#kubernetes-backend)). The npmrc, which carries the token
too, is written into the pod through stdin.

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

**Go.** A workspace wired to a Go registry carries two more env entries:
- `GOPROXY=<proxy URL>/go/<token>/<registryId>` — the proxy alone, with no `,direct` and no second
  entry, because Go falls through to the next entry on a 404 and `direct` would fetch the module
  from its VCS host, past the allowlist. The token is a **path segment, not userinfo**: the Go
  tool refuses to send credentials from a `GOPROXY` URL over plain http, and the proxy is plain
  http on the container network. The value contains the token, so it is `secretEnv`, set the way
  `COREPACK_NPM_TOKEN` is.
- `GOTOOLCHAIN=local` — otherwise a repository whose `go.mod` names a newer Go than the image has
  would download a toolchain through the proxy, which a lockfile allowlist denies. With `local`
  it fails with Go's own message instead.

`GOSUMDB` is left at its default, so the `go.sum` hashes the repository commits are what Go checks
the served bytes against. A Go-only workspace gets none of the npm, Yarn or Corepack variables and
no npmrc.

The suite is `registryProxy/goClient.docker.test.ts`, run in CI against the curated Go image. It runs
a real `go build` and `go get` through the proxy in both modes and shows the denial of a module
outside `go.sum`.

**PyPI.** A workspace wired to a PyPI registry carries, as `secretEnv` because the URL holds the token:
`PIP_INDEX_URL`, `UV_DEFAULT_INDEX` and `UV_INDEX_URL`, each
`http://token:<token>@<proxy host>/pypi/<registryId>/simple/`.
In plain env it carries `PIP_TRUSTED_HOST` (pip ignores a plain-http index otherwise),
`PIP_DISABLE_PIP_VERSION_CHECK=1` and empty `PIP_EXTRA_INDEX_URL` / `UV_EXTRA_INDEX_URL`, so a second
index cannot be added from the environment. Unlike Go, the token travels as URL **userinfo**, because pip
and uv send it over http and redact it in the files and messages they produce; a token in the path
would be written into `uv.lock`. Only pip and uv are wired.

The suite is `registryProxy/pypiClient.docker.test.ts`, run in CI against the curated Python image. It
runs real `pip` and `uv` installs through the proxy in both modes, and shows a version, a project and a
cross-origin file outside what the lockfile allows being refused.

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

**PyPI route.** `<baseUrl>/pypi/<token>/<registryId>/simple/<project>/` serves a project index and
`…/files/<fileId>/<filename>` a file, as `/pypi/<registryId>/…`; the credential is an HTTP Basic
password equal to the token (the user name is ignored, a Bearer header is not accepted, and Basic is
honoured only on this route, decided on the normalised path). A request without it gets 401 with a
`WWW-Authenticate: Basic` challenge. The proxy asks the upstream for the project's index (JSON or HTML), parses it, and answers
with its **own** PEP 503 page: only the files the allowlist admits (all of them in open mode), each link
rewritten to the proxy's file route with its `sha256` fragment, `requires-python` and `yanked`
attributes kept, and the PEP 658 metadata attributes dropped so a client downloads the wheel itself.
Index requests buffer their body, so they take a slot in the per-registration limit like npm's.

A file is fetchable only if an index the proxy served in this registration listed it, identified by an
opaque id the proxy derived, never by a URL the client supplies; each file is re-checked against the
allowlist before the cache is read. The index is upstream-controlled, so what a file URL may do is
bounded: its last path segment must be the listed filename; the registry credential is sent only to a
URL on the upstream's origin **under the registry's own path** (its `upstreamUrl` without the trailing
`/simple`); any other URL is fetched anonymously, over https only unless it is same-origin, and through the
SSRF guard **without** the registry's private-network opt-in. Redirects are refused. Files stream up to
512 MiB and are cached like Go zips. The route is excluded from request tracing, deciding on the
normalised path.

**Go route.** `<baseUrl>/go/<token>/<registryId>/<GOPROXY path>`, authenticated only by the token
in the path (a Bearer or Basic header is ignored). The protocol is five read-only requests:
`@v/list`, `@latest`, and `@v/<version>.info|.mod|.zip`, with module paths case-encoded as Go
does (`!` before a lowercase letter). The module and version are decoded and validated, and the
upstream path is rebuilt from those validated values alone. In lockfile mode:
- `@v/list` is answered by the proxy from the allowlist and never reaches the upstream, so
  `go get m@latest` resolves to a version the repository already pins;
- `@latest` is denied;
- `.zip` is served only for a version with a plain `go.sum` line.

A zip is relayed up to 512 MiB and cached in the tarball cache; the cut-off applies to the bytes
received, not the declared length. The token segment is never part of what the allowlist, the
cache key, a denial report or a response sees. GET and HEAD only, redirects
refused, an upstream deadline and hang-up handling as for npm. Go answers are streamed, so they
take no slot in the per-registration buffered-request limit. The Go route is excluded from request
tracing, because a span records the path and the path holds the token.

**URL layout.** `<baseUrl>/npm/<registryId>/<npm path>`. Only three npm path shapes exist:
- packument: `/<name>`
- version manifest: `/<name>/<version>`, which Corepack reads. In lockfile mode the version must
  be allowlisted, so a dist-tag such as `latest` is denied.
- tarball: `…/<name>/-/<file>.tgz`

A scoped name may be written `@scope/pkg`, `@scope%2fpkg` or `%40scope%2fpkg`.

Anything else, including search and other `/-/…` endpoints, is a JSON 404. The one exception is the
audit query below.

**Audit.** Two query shapes are relayed to the **default** registry, with its credential, so a
`runVulnScan` gate works in a wired workspace. They are the only requests other than GET and HEAD.

| Client | Endpoint | Body |
|---|---|---|
| `npm audit`, `yarn npm audit` | `POST …/-/npm/v1/security/advisories/bulk` | a JSON object of package names to non-empty lists of versions |
| `pnpm audit` | `POST …/-/npm/v1/security/audits/quick`, then `…/audits` if that does not answer 200 | pnpm's dependency tree: importers holding packages with `version`, `integrity`, `dev`, `requires` and nested `dependencies` |

Both bodies (gzip accepted, 8 MiB cap) are held to that shape and nothing else: every key outside
the known set is refused, every name, version and integrity value is held to its charset, and the
tree's `install`, `remove` and `metadata` must be empty, so a body can carry nothing but the names
and versions of a lockfile. What is forwarded is the validated body re-serialised, not the bytes
received. In lockfile mode every name and version in it must also be in the committed lockfiles
(otherwise 403, reported like any other denial). A body that names a package another registry
serves (a claimed private scope) is refused with 403, not trimmed: sending it to the default
registry would disclose the name, and a trimmed audit would read as a complete one. The answer
(8 MiB cap) is relayed as JSON with the upstream's status; whether it holds advisories depends on
the upstream — a mirror that does not serve the endpoint answers its own error (pnpm reports a 404
from both of its endpoints as an audit endpoint that does not exist), and the gate fails.

An audit is a buffered fetch like a packument, so it follows the same rules: it takes one of the
workspace's places only after the body has passed the shape and lockfile checks (a refused body never
waits), waits for a place and gets `503` with `Retry-After` exactly as a packument does, reads the
client's body and the upstream's answer within the 20-second deadline (`408` for a client that is too
slow, `502` for the upstream), and gives its place back at once if the client hangs up.

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
- a method other than GET or HEAD, except the audit POST above: 405

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
and re-serialised, a workspace has at most 8 of them in flight; a request past that waits (up to 64
waiting, above Yarn's default of 50 concurrent requests, for at most 30 seconds) and then gets `503`
with `Retry-After`, which npm and Yarn retry. A request takes its place only after the allowlist
check, so a denied package never waits. The upstream fetch and body read of a held place end at 20
seconds with a `502`, and a client that hangs up gives its place back at once.

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

- **npm, Go modules and PyPI only, and read-only.** Maven is not served, and neither is
  publishing. PyPI has no audit relay (`pip-audit` reaches its own database directly or not at all).
  A Go registry has no audit endpoint, so `govulncheck` and similar reach their own
  database directly or not at all.
- **Open mode needs egress to the checksum database for new Go modules.** The proxy does not
  serve `/sumdb/…`, so a module whose hash is not yet in `go.sum` is verified by Go reaching
  `sum.golang.org` directly (unless the repository sets `GOFLAGS`/`GONOSUMDB`/`GOSUMDB`). In
  lockfile mode every hash is already committed and the checksum database is not consulted.
- **Go's token is visible to the agent.** Go prints the request URL in its errors
  (`reading http://…/go/<token>/…: 403 Forbidden`), and `env` shows `GOPROXY`. The token is good
  only at this proxy, for this workspace, and in lockfile mode only for `go.sum`'s modules — the
  same reach as the npm token the container already holds — but a transcript can contain it.
- **A Go workspace needs a Go image.** The image comes from `WORKSPACE_IMAGE_GO`
  ([`repositories.md`](./repositories.md#detected-stack)); the default image has no Go toolchain.
- **Go wiring follows the stored detection.** A repository whose detection lists Go in any
  component is wired, including a Go module beside a Node root. A repository with no usable
  detection, or a truncated one, is wired too, because "unknown" is not "uses no Go"; a detection
  that names only other stacks gets no Go proxy.
- **Shell steps get no Go wiring.** They are wired for npm only.
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
- **The cache holds tarballs only**; packuments are always re-fetched.
- **Denials have no dedicated UI.** They surface as 403s to the installer and as `logWarn`
  entries on the run's activity.
- **PyPI is pip and uv only.** Poetry, PDM, Pipenv and Hatch read their index from project files the
  environment does not override, so they reach whatever the project names. A Poetry or Pipenv
  repository's lockfile still builds the allowlist, but nothing routes the install through the proxy.
- **Source distributions need their build requirements.** In lockfile mode `setuptools`, `wheel`,
  `hatchling` and the like are fetched through the same index and are denied unless the lockfile
  pins them, so an sdist-only dependency fails to build unless its backend is in the lockfile. Wheels
  are unaffected.
- **An index that redirects downloads fails.** A PyPI upstream whose file URLs redirect to object
  storage is refused like npm's, and a file whose URL does not end in its filename is dropped from
  the index.
- **No PEP 658 metadata.** Resolvers download whole wheels to read their metadata; large resolves are
  slower than against a mirror.
- **PyPI wiring follows the stored detection**, as Go's does; a Node-only detection gets no index.
- **Shell steps get no PyPI wiring.**
- **uv project mode writes the proxy's address into the repository.** `uv add`, `uv lock` and `uv sync`
  record the index they resolved from — `http://<proxy host>/pypi/<registryId>/simple/` — in `uv.lock`
  and, for `uv add`, in `pyproject.toml`'s `[[tool.uv.index]]`. The token is not written (it is
  userinfo, which uv strips), but a lockfile committed from a workspace points at an address only that
  deployment can reach. `uv pip` and pip write nothing. Review such a diff before it ships.
- **A project can name its own index.** pip honours `--index-url`/`--extra-index-url` lines inside a
  `requirements.txt`, and uv honours `[[tool.uv.index]]` and `tool.uv.sources` in `pyproject.toml`; both
  win over the environment and reach that index directly, without the proxy or its allowlist. In a
  lockfile-mode deployment, treat a diff that adds one as a change to review.
- **The allowlist ignores which index a lockfile entry came from.** A `uv.lock` `registry` source,
  a Poetry `legacy` source or a Pipfile `index` naming another index still allowlists `name==version`
  against the one configured upstream, so a public package with the same name and version as an
  internal one is served if the upstream carries it.
