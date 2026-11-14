# Production deployment

End-to-end runbook for taking auto-swe from a fresh clone to a running production deployment. For local development, use the quickstart in [`README.md`](../README.md). For OAuth provider configuration, see [`oauth-setup.md`](./oauth-setup.md).

> **Before and after you upgrade, read [`upgrade-notes.md`](./upgrade-notes.md).** It lists fixed defects that exposed credentials in earlier builds (Kubernetes audit logs, Docker host process arguments, Pod objects) and the rotation and clean-up each one needs. Check which entries match your backend and the commit your worker image was built from.

---

## 0. What you're deploying

Six long-running processes plus one Docker daemon, and two more that are optional:

| Service                    | Image                                              | Purpose                                                                |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `postgres`                 | `pgvector/pgvector:pg18`                           | App DB — relational state + pgvector for semantic memory.              |
| `postgres-temporal`        | `postgres:18-alpine`                               | Separate DB for Temporal history. Do **not** combine with the app DB.  |
| `temporal` (server+admin+ui) | `temporalio/server:1.31.2` + admin-tools 1.31 + ui 2.53.3 | Workflow orchestration runtime + setup container + web UI on `:8233`.  |
| `gateway`                  | built from `packages/gateway/Dockerfile`           | Fastify HTTP API on `:8080`. Stateless, scale horizontally.            |
| `worker`                   | built from `packages/worker/Dockerfile`            | Temporal worker. Spawns ephemeral Docker workspaces through `docker-policy-broker`. |
| `docker-policy-broker`     | built from `packages/docker-broker/Dockerfile` | Validates Docker operations, bodies, profiles and ownership; keeps private state in `docker-broker-state`. |
| `docker-socket-proxy`      | `haproxy:3.4-alpine` (`DOCKER_SOCKET_PROXY_IMAGE`) with `infra/docker-socket-proxy/haproxy.cfg` | Filters the Docker API for the worker; the only app container that mounts the host socket. Its idle timeouts (65 min) outlast the longest container step. |
| `web`                      | built from `packages/web/Dockerfile`               | Next.js dashboard on `:3000`. Stateless, scale horizontally.           |
| `otel-lgtm` (optional)     | `grafana/otel-lgtm:0.34.0`                         | Grafana + Loki + Tempo + Mimir bundle for traces, logs, metrics.       |
| artifact store (one of)    | `dxflrs/garage` (bundled) / AWS S3 / Cloudflare R2 / Backblaze B2 / a mounted directory / Postgres | Where large step outputs, transcripts and run evidence live. S3-compatible stores and a filesystem directory keep them out of the app DB; with neither, they are stored inline in Postgres. See §5c. |

The worker reaches `docker-policy-broker` at `DOCKER_HOST=tcp://docker-policy-broker:2375`. Only the broker shares the separate internal `docker-daemon` network with HAProxy; only HAProxy mounts the host socket. Neither service publishes its API port. The worker spawns ephemeral `node:24-alpine`-style containers per work request. The base image comes from the connection's `executorImage`, falling back to `WORKSPACE_IMAGE` (default `node:24-alpine`); an explicit node image wins. A blank connection image inherits that default.

The repository-owned broker (`packages/docker-broker`) defaults to deny by method, canonical path (including API version), query schema and bounded JSON. It rejects duplicate/unknown create fields and validates workspace, probe, preview, firewall, cleanup, hosts-writer, holder, author and git-helper profiles. Profiles cannot request privileged mode, devices, host namespaces, arbitrary host binds, sysctls, extra capabilities or unconfined security options. Network joins and `/workspace` volumes must reference broker-owned objects. The sole host bind is an owned target's hosts file, derived from the broker's own daemon inspection. Ports are ephemeral and loopback-only; tmpfs is restricted to `/tmp`. HAProxy retains `infra/docker-socket-proxy/haproxy.cfg` as a second path filter.

`DOCKER_BROKER_ALLOWED_IMAGES` is a comma-separated list of registry/repository patterns (`*` matches within one path component, not across `/`). Defaults permit Docker Hub library images, `alpine/git`, the library mirror and curated executor repositories. Add private/custom executor and service repositories explicitly. `DOCKER_BROKER_HELPER_IMAGES` matches exact image references; compose derives it from `WORKSPACE_METADATA_BLOCK_IMAGE`. Prefer immutable digest references for helpers. `WORKSPACE_RUNTIME` must match on broker and worker; only that runtime or the daemon default is accepted. `DOCKER_BROKER_NETWORKS` lists permitted ordinary networks; never include application, broker or daemon-facing networks.

The broker injects a private ownership label, removes it from responses, and rebuilds container/volume ownership on restart. Persist and protect `docker-broker-state`: losing it makes earlier objects inaccessible through the broker. Exec IDs and root phase state are stored there too. Root exec is allowed on already-root containers, or on workspaces before their first non-root exec creation. This is a phase-state heuristic, not proof that no untrusted code has run. Explicit user aliases and noncanonical numeric IDs are rejected. Every profile is constrained even when chosen by a compromised worker; a profile label is not evidence of trusted intent.

The broker retries unreachable/5xx upstreams with exponential backoff (250 ms to 30 s) **without listening until ownership is rebuilt**. Invalid state and permanent upstream refusals fail boot. The worker requires a broker-signed 403 for a privileged-create boot probe. `DOCKER_BROKER_REQUIRED=false` is a logged opt-out for direct-socket development, not production. Direct-socket operators have no broker policy protection.

Body limits default to 2 MiB JSON and 1 GiB per stream direction, including archives and hijacked exec/attach. Metadata responses are capped at 32 MiB. Broker-only overrides are `DOCKER_BROKER_JSON_LIMIT`, `DOCKER_BROKER_STREAM_LIMIT`, `DOCKER_BROKER_MAX_MEMORY` (bytes, default 16 GiB), `DOCKER_BROKER_MAX_CPUS` (default 16) and `DOCKER_BROKER_MAX_PIDS` (default 4096). These bound individual operations, not aggregate host usage. Configure them on the broker, never through worker API requests. Keep the Docker host isolated and patched.

The workspace clones and pushes with the run's GitHub credential (the platform's, or the launcher's
own) inside the executor image, so choosing the image is choosing code that sees that credential.
Only a platform admin may set a connection's executor image; a team lead may clear it, or save the
connection with the image it already has. The team shell-image allowlist does not apply: its entries
are approved for sandboxed shell steps, which never hold a credential. `build-executor.yml` writes
each freshly tagged image to its repository, so its `GATEWAY_TOKEN` must belong to a platform
admin. It builds `defaults/Dockerfile.node` unless `use_repo_dockerfile` is true, which builds the
repository's own `.auto-swe/Dockerfile` instead. `defaults/` also carries `Dockerfile.node-browser`,
`Dockerfile.python`, `Dockerfile.jvm` and `Dockerfile.go`; the `stack` input
(`node`|`node-browser`|`python`|`jvm`|`go`, default `node`) selects the curated Dockerfile.

**Prebuilt executor images.** `docker.yml` builds the five curated Dockerfiles on every pull request
and, after the same CI gate as the app images, publishes them beside them as
`ghcr.io/<repository>/executor-node`, `executor-node-browser`, `executor-python`, `executor-jvm`
and `executor-go` (and to
`EXTERNAL_REGISTRY_URL` when that is set), tagged `main`, `latest` and `<timestamp>-<commit>`. Point
`WORKSPACE_IMAGE` (the Node image) and `WORKSPACE_IMAGE_PYTHON`, `_JVM` and `_GO` at them to give a
repository the image for its detected stack ([`repositories.md`](./repositories.md#executor-images)).
`executor-node-browser` is a Node variant rather than a detected stack; use it as the repository's
`executorImage` when UI validation needs Chromium.
Reference them by **digest** (`…@sha256:<digest>`), not by a tag: the image runs next to the clone
credential, and a tag that moves changes what runs there without a deploy. A GHCR package is private
until its visibility is changed, so a worker, and on Kubernetes the pull secret named in
`K8S_WORKSPACE_IMAGE_PULL_SECRETS`, needs access to it.

For a repository-specific browser image, dispatch `build-executor.yml` with `stack: node-browser`
and `use_repo_dockerfile: false`; the workflow builds the curated Dockerfile and writes the image
and build settings to that connection ([`ui-validation.md`](./ui-validation.md)). It is Debian-based
because Playwright's Chromium needs glibc, and it carries the same Node toolchain as the Node image
(Corepack, Yarn and pnpm) so a repository's own gates still run in it. A repository without it
simply skips the preview check.

Each build also records its settings on the connection (`executorImageBuild`). A weekly schedule
(`cron: '0 6 * * 1'`) rebuilds every active repository that has such a record, so the workflow's
`GATEWAY_TOKEN` must be able to list repositories as well as update them.

The fallback `WORKSPACE_IMAGE` is `node:24-alpine` and works without changing images: during Docker
preparation the worker installs missing git and bash as root, before clone or repository code.
The curated Node image built from `defaults/Dockerfile.node` uses Node 26 and preinstalls Corepack,
Yarn, pnpm, git and bash, avoiding those package downloads at workspace creation.

This is a harder constraint than "some target repos use Yarn". The built-in quality gates are `yarn` commands — `DEFAULT_COMMANDS` in `activities/qualityGates.ts` defines `runBuild`, `runLint`, `runTests`, `runTypecheck` and `runVulnScan` that way — and they run with `docker exec` inside this container. They are the fallback for a repository whose detected root is Yarn, Node with no recorded package manager, or undetected; a detected npm or pnpm root, or a Python, JVM or Go root, runs its own commands instead ([`repositories.md`](./repositories.md#detected-stack)). On an image without `yarn`, every gate that falls back exits `127`, and the failure reads as the agent producing broken code rather than as a missing tool. A per-connection `gateCommands` override sidesteps it, but that is opt-in.

So raise this default only alongside an image that provides `yarn` — not by pointing it at a newer stock upstream tag. `defaults/Dockerfile.node`, the base for executor images built by `build-executor.yml`, is on Node 26 and installs Corepack explicitly for exactly that reason.

Two things to know about the service images themselves. Their Node major is a **Current** release, not an LTS one, until Node 26 reaches LTS in October 2026. And the worker's runtime stage is Debian-based, so moving it to Node 26 also moved it from bookworm to trixie (glibc 2.36 → 2.41); that stage installs no distro packages, so there is nothing pinned to break, but an OS-level surprise there will not look Node-related.

> **Local-dev shortcut.** `yarn docker:infra:up` brings up Garage (the `garage` container in `docker-compose.infra.yml`) and provisions the access key and the `auto-swe-artifacts` bucket on first boot — there is no separate bucket-create step. Uncomment the `ARTIFACT_S3_*` block in `.env.example` (defaults match the container) to flip the worker onto S3 mode locally. Garage ships no web console; use `aws s3 ls --endpoint-url http://localhost:9000` or read `./data/garage` directly.

---

## 1. Pre-flight checklist

Before touching infrastructure, gather these:

- **Domain + TLS.** Reverse-proxy in front of the gateway (`https://api.example.com`) and the web app (`https://app.example.com`). Both must serve HTTPS; better-auth refuses to issue secure cookies otherwise. The proxy must pass the gateway's `/api/auth/*`, `/api/v1/*` and `/.well-known/*` paths through unchanged (the OAuth authorization server for MCP clients is discovered at `/.well-known/oauth-authorization-server/api/auth`).
- **GitHub PAT** with `repo` scope, or a GitHub App (short-lived installation tokens; see [`github-app-setup.md`](./github-app-setup.md)).
- **GitHub webhook secret** — any strong random string; you'll add it to GitHub repo webhooks pointing at `https://api.example.com/api/v1/webhooks/git`.
- **LLM provider key(s)** — configured via the admin UI (`/models`) after first boot. There is no env-var fallback for LLM credentials: model + credential config is fully DB-driven (see [`model-configuration.md`](./model-configuration.md)).
- **Email transport** — pick one of SMTP (`SMTP_HOST/PORT/USER/PASS` + `AUTH_FROM_EMAIL`) or Resend (`RESEND_API_KEY` + `AUTH_FROM_EMAIL`). Required for magic-link sign-in and password reset outside development — without one those requests fail, and the gateway logs an error that never contains the link. Only with `NODE_ENV=development` or `test` does it print the link to stdout instead.
- **OAuth credentials** (optional but recommended) — register a GitHub OAuth app, a Google OAuth client, and/or an Okta OIDC app, callback `{BETTER_AUTH_URL}/api/auth/callback/{github,google,okta}`. Credentials are environment variables (`GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `OKTA_ISSUER` + `OKTA_CLIENT_ID/SECRET`). See [`oauth-setup.md`](./oauth-setup.md).
- **Slack credentials** (optional) — configured via `/admin/integrations` (Slack tab) after first boot.
- **Artifact store** (one of, recommended in prod) — S3-compatible (`ARTIFACT_S3_*`), a mounted directory (`ARTIFACT_FS_DIR`), or Postgres inline as the fallback. `ARTIFACT_WRITE_BACKEND` picks which one receives new artifacts when more than one is configured. See §5c.

Generate strong secrets:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET (must be ≥32 chars)
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 24   # SEED_ADMIN_PASSWORD (or use the IdP)
```

---

## 2. Required environment variables

The full annotated template is [`.env.example`](../.env.example). `yarn env:setup` builds a `.env` from it:

```bash
yarn env:setup init --profile prod        # prompts for the API and web domains on a TTY
yarn env:setup init --profile prod --yes --set DOMAIN_API=api.example.com --set DOMAIN_APP=app.example.com
yarn env:setup check --profile prod       # pre-flight before `just prod-*`
yarn env:setup sync                       # after pulling a change to .env.example
```

The `prod` profile generates a strong URL-safe `POSTGRES_PASSWORD` (and rebuilds `DATABASE_URL` from it),
`ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` and `GARAGE_RPC_SECRET`, sets `NODE_ENV=production`,
and derives `PUBLIC_URL`, `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` from `DOMAIN_API` and `CORS_ORIGIN`
and `WEB_URL` from `DOMAIN_APP`. `check --profile prod` exits non-zero while any of those URLs is unset or
points at `localhost` / `127.0.0.1`, while a dev default (`POSTGRES_PASSWORD=password`, the
`autoswelocal…` S3 credentials) remains, or while a required secret is empty or malformed. `sync` re-renders
the file from the current template keeping every value you set, moves keys the template does not know into a
trailing "Local additions" section, and writes a `.env.bak-<timestamp>` first. `--dry-run` prints the change
with secret values masked. Secrets that already have a value are never regenerated.

The minimum-viable production set:

```bash
# Datastore
DATABASE_URL=postgresql://USER:PASSWORD@db-host:5432/engineering_system   # pgvector-enabled
POSTGRES_USER=engineering
POSTGRES_PASSWORD=<from secrets manager>
POSTGRES_DB=engineering_system

# Temporal
TEMPORAL_ADDRESS=temporal:7233       # or your managed Temporal Cloud endpoint
TEMPORAL_NAMESPACE=default

# LLM — no env vars. Provider keys and model selection are configured in the
# admin UI (/models) after first boot and stored encrypted in the
# DB; nothing in the codebase reads ANTHROPIC_API_KEY / OPENAI_API_KEY.

# Source control — set here for bootstrap only; managed via /admin/integrations thereafter
# If these are set they act as fallback when the DB row hasn't been configured yet.
# Remove them once you've saved the values in the admin UI.
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=<random>

# Browser auth (better-auth) — MUST set both in prod or the gateway refuses to start
BETTER_AUTH_URL=https://api.example.com
BETTER_AUTH_SECRET=<openssl rand -base64 32>

# JWT signing — used by the session-token bridge (browser bearer) and OAuth state tokens
JWT_SECRET=<openssl rand -base64 48>
# Or, for RS256:
# JWT_PRIVATE_KEY_PATH=/etc/auto-swe/jwt-private.pem
# JWT_PUBLIC_KEY_PATH=/etc/auto-swe/jwt-public.pem

# Web app — read at request time by the root Server Component and injected
# into window.__APP_CONFIG__, so a change is a container restart, not a rebuild
NEXT_PUBLIC_API_URL=https://api.example.com
API_INTERNAL_URL=http://gateway:8080                      # server-only: gateway as reached from the web and worker containers (the in-app assistant's tools); web defaults to NEXT_PUBLIC_API_URL
NEXT_PUBLIC_TEMPORAL_UI_URL=https://temporal.example.com   # optional; omit to hide the link
NEXT_PUBLIC_SUPPORT_URL=https://help.example.com           # optional; https only; omit to hide it
NEXT_PUBLIC_SUPPORT_EMAIL=help@example.com                 # optional; shown as a mailto link
NEXT_PUBLIC_SUPPORT_SLACK=#platform-help                   # optional; up to 80 characters; an https URL becomes a link

# Browser-facing gateway
CORS_ORIGIN=https://app.example.com,https://admin.example.com  # first entry = better-auth client origin
PUBLIC_URL=https://api.example.com                              # used for Slack OAuth callback
TRUST_PROXY=10.0.0.0/8   # behind a reverse proxy: the proxy IPs/CIDRs whose X-Forwarded-For
                         # is trusted (or `true`). Unset = do not trust it
RATE_LIMIT_MAX=200               # optional: requests per client per window (default 200)
RATE_LIMIT_WINDOW_SECONDS=60     # optional: window length in seconds (default 60)
WEBHOOK_RATE_LIMIT_MAX=6000       # optional: requests per client address per window on the GitHub webhook routes (default 6000)

# Config encryption — REQUIRED for gateway and worker to start
# Encrypts all DB-stored secrets (GitHub token, Slack tokens, S3 credentials, OAuth secrets)
CONFIG_ENCRYPTION_KEY=<openssl rand -base64 32>  # base64-encoded 32 bytes

# Seed (only needed for first boot — the admin user)
SEED_ADMIN_PASSWORD=<openssl rand -base64 24>
SEED_ADMIN_EMAIL=admin@example.com   # optional, defaults to admin@auto-swe.local

# Magic-link / password-reset email — pick ONE
# Option A — SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=postmaster@example.com
SMTP_PASS=<from secrets manager>
AUTH_FROM_EMAIL=auth@example.com
# Option B — Resend
# RESEND_API_KEY=re_...
# AUTH_FROM_EMAIL=auth@example.com

# OAuth sign-in and artifact storage are environment-only — they are read at
# process start, so they have no admin-UI form. Slack is configured via the
# admin UI (/admin/integrations) after first boot; its env vars below are only
# bootstrap fallbacks.
#
# OAuth sign-in (gateway restart required to change)
# GITHUB_CLIENT_ID=...
# GITHUB_CLIENT_SECRET=...
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
# OKTA_ISSUER=https://dev-12345.okta.com/oauth2/default
# OKTA_CLIENT_ID=...
# OKTA_CLIENT_SECRET=...
#
# Slack (env fallback — prefer /admin/integrations → Slack tab)
# SLACK_CLIENT_ID=...
# SLACK_CLIENT_SECRET=...
# SLACK_SIGNING_SECRET=...
# SLACK_BOT_TOKEN=xoxb-...
#
# Artifact store — pick one (§5c)
# ARTIFACT_WRITE_BACKEND=fs          # fs | s3 | pg; derived when unset
# ARTIFACT_FS_DIR=/var/lib/auto-swe/artifacts   # mounted into gateway and worker
# ARTIFACT_S3_ACCESS_KEY=...        # compose maps this to AWS_ACCESS_KEY_ID
# ARTIFACT_S3_SECRET_KEY=...        # compose maps this to AWS_SECRET_ACCESS_KEY
# ARTIFACT_S3_BUCKET=auto-swe-artifacts
# ARTIFACT_S3_REGION=us-east-1
# ARTIFACT_S3_PREFIX=workflow-artifacts
# ARTIFACT_S3_ENDPOINT=https://...   # only if not AWS S3 — Garage, R2, B2, …
# ARTIFACT_S3_FORCE_PATH_STYLE=true  # true for Garage and B2; false for AWS S3 and R2

# Observability — OTLP over gRPC (the exporters are the *-otlp-grpc packages),
# so point this at the collector's gRPC port, not the HTTP one
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317

# Worker (optional tuning)
WEB_URL=https://app.example.com      # base URL for the "Open approvals" link (to /approvals) in Slack HITL
                                     # notifications (defaults to http://localhost:3000 —
                                     # set it or Slack links point at localhost)
# WORKER_MAX_CONCURRENT_ACTIVITIES=10  # cap on concurrent activity executions per worker
                                       # (each typically holds a Docker workspace)
# Agent workspace sizing and sidecar images (all optional; defaults shown; the
# worker refuses to start on a value it cannot use)
# WORKSPACE_MEMORY=4g
# WORKSPACE_CPUS=2
# WORKSPACE_PIDS_LIMIT=512
# WORKSPACE_IMAGE=node:24-alpine
# WORKSPACE_RUN_AS_ROOT=false          # Docker agent workspaces: UID/GID 1000; true restores image USER/HOME
# WORKSPACE_IMAGE_PYTHON=registry.example/executor-python:1   # per-stack executor images (optional)
# WORKSPACE_IMAGE_JVM=registry.example/executor-jvm:1
# WORKSPACE_IMAGE_GO=registry.example/executor-go:1
# WORKSPACE_METADATA_BLOCK_IMAGE=alpine:3.20   # baseline/strict egress helper (needs iptables and ip6tables)
# WORKSPACE_BLOCK_METADATA=true        # only literal false disables metadata REJECTs
# WORKSPACE_BLOCK_PRIVATE_EGRESS=true  # only literal false disables the Docker private-range baseline
# WORKSPACE_PRIVATE_EGRESS_ALLOW=10.20.0.0/16,fd00:1234::/48  # additional private IPs/CIDRs
# WORKSPACE_DISK_LIMIT=20g             # optional Docker writable-layer quota; unset means no cap
# WORKSPACE_RUNTIME=runsc-host        # optional Docker runtime; unset uses the daemon default; startup proves traffic isolation and copy
# SCANNER_REGEX_BUDGET_MS=250          # per-pattern scanner wall-clock budget
# The Claude Code harness's model proxy (the compose files turn it on): the worker holds the model
# key and meters every call; a workspace gets a per-turn token. Unset the port to turn it off on the Docker backend;
# the Kubernetes backend refuses to start without it.
# Package registry proxy (npm, Go modules, PyPI, Maven) — workspaces install through the worker, which
# alone holds each registry's credential. Empty REGISTRY_PROXY_PORT disables it.
# REGISTRY_PROXY_PORT=8791
# REGISTRY_PROXY_URL=http://{hostname}:8791   # how a workspace reaches this worker; {hostname}
#                                             # becomes the replica's hostname
# REGISTRY_PROXY_BIND=0.0.0.0
# REGISTRY_PROXY_CACHE_DIR=                   # tarball cache dir; empty disables the cache
# REGISTRY_PROXY_CACHE_MAX_BYTES=2147483648   # cache cap (default 2 GiB)

# HARNESS_MODEL_PROXY_PORT=8790
# HARNESS_MODEL_PROXY_URL=http://{hostname}:8790   # how a workspace reaches this worker; {hostname}
#                                                  # is the worker's own (default http://host.docker.internal:<port>)
# HARNESS_MODEL_PROXY_BIND=0.0.0.0
# WORKSPACE_NETWORK=auto-swe-workspaces            # a Docker network workspaces join instead of the default bridge
# WORKSPACE_DNS=1.1.1.1,8.8.8.8                    # resolvers every workspace uses; set an internal one when the repository
#                                                  # host (a split-horizon GHE name) resolves to an unreachable address on public DNS.
#                                                  # Agent-run code can then resolve every name that resolver knows
# WORKSPACE_BACKEND=docker                         # `kubernetes` runs agent workspaces as pods (see Kubernetes above); anything else is Docker
# K8S_WORKSPACE_NAMESPACE=auto-swe-workspaces      # the one namespace workspace pods live in
# K8S_WORKSPACE_RUN_AS_UID=1000                    # uid/gid of the workspace process; must be non-root and match the image
# K8S_WORKSPACE_RUNTIME_CLASS=                     # optional RuntimeClass (gVisor/Kata); empty = the cluster default
# K8S_REQUIRE_RUNTIME_CLASS=false                  # true requires a readable RuntimeClass and a matching startup probe pod
# K8S_WORKSPACE_STORAGE_LIMIT=10Gi                 # ephemeral-storage request/limit and the size of the /workspace volume
# K8S_WORKSPACE_MAX_LIFETIME_SEC=86400             # hard pod lifetime the kubelet enforces (activeDeadlineSeconds)
# K8S_WORKSPACE_IMAGE_PULL_SECRETS=                # comma-separated Secret names in the workspace namespace
# K8S_REQUIRE_NETWORK_POLICY=true                  # only the literal `false` skips the start-up NetworkPolicy check
# K8S_REQUIRE_ADMISSION_POLICY=true               # only literal false skips the Pod admission policy/binding check
# K8S_KUBECTL=kubectl                              # the kubectl binary the worker runs
```

> **Magic-link transport gotcha.** `nodemailer.sendMail()` resolves on SMTP `2xx` (relay accepted) — *not* delivery. Always test end-to-end against a real inbox after configuring SMTP/Resend, and check the audit log for `accepted` vs `rejected` arrays.

---

## 2b. Admin UI configuration (post-boot)

Integration credentials that an operator rotates during normal use are stored encrypted in the DB and managed via the admin UI; their env vars remain accepted as fallbacks. What a process needs at start-up — sign-in provider credentials, artifact storage, and workspace sizing — is environment-only (see [`configuration.md`](./configuration.md)).

| Admin page | What it configures | Restart required? |
|---|---|---|
| `/models` | LLM provider credentials and per-role model selection | No — resolved fresh per activity call |
| `/admin/integrations → GitHub` | GitHub PAT, webhook secret, GitHub Enterprise URLs, GitHub App credentials | No |
| `/admin/integrations → Slack` | Slack client ID/secret, signing secret, bot token | No — read on every request |
| `/admin/workflow-defaults` | Branch prefix, PR title/body templates, default team slug | No — resolved fresh per workflow activity |

**Bootstrap order** (first deployment):
1. Start gateway + web only — `docker compose -f docker-compose.infra.yml -f docker-compose.prod.yml up -d gateway web` in the compose stack (locally, `yarn dev:gateway` and `yarn dev:web`).
2. Sign in as admin.
3. `/models` → Credentials → add a provider credential (the seed already created the agents + embedding config).
4. `/admin/integrations` → GitHub tab → enter your PAT and webhook secret → Save.
5. `/admin/integrations` → any other tabs you need (Slack, Issue Tracker, Knowledge Base, Figma).
6. Start the worker (`… up -d worker`, or `yarn dev:worker` locally). The worker reads all config from the DB.
7. Optionally clear the `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` env vars — the DB config is now the source of truth.

> **Restarts.** Everything set through environment variables — sign-in credentials, storage, workspace sizing, the scheduled-sweep settings — is read at process start, so changing one means restarting the service that reads it. Every admin-UI change (GitHub token and webhook secret, Slack credentials, workflow defaults) takes effect on the next request or activity call.

---

## 3. Database setup

The shipped schema lives in `packages/shared/src/prisma/migrations/` — a consolidated baseline, the
hand-written DDL migration beside it, and one migration per schema change made since the schema was
first deployed, each named for the change it makes:

| Migration | What it adds |
| --------- | ------------ |
| `20260618000000_init` | The consolidated baseline, generated from `schema.prisma` via `prisma migrate diff --from-empty --to-schema --script` — the `vector` extension, every enum, table, column, FK and Prisma-expressible index (including the `repo_dependencies` edge table and `connections.package_names`) |
| `20260618000001_custom_constraints_and_indexes` | Everything the DSL can't express: the HNSW vector indexes on `memory_items.embedding` and `knowledge_items.embedding`, the partial and expression indexes the scope cascade and the automation ledger rely on, the singleton / scope-discriminator / per-source-filter CHECK constraints, `api_tokens`' exactly-one-owner CHECK, array-column `NOT NULL`s, the governed-knowledge scope-guard triggers, and the embedding-config seed |

The split between the two is by *kind* of DDL, not by when it was written. The schema is deployed,
so the pair is applied in the wild and is never edited or regenerated: a schema change appends its
own migration after them, and `prisma migrate deploy` applies whatever is pending. See the
[`prisma-pgvector-hnsw`](../.claude/skills/prisma-pgvector-hnsw/SKILL.md) skill.

Directory names follow Prisma's `<timestamp>_<name>` convention: `20260618000000_init` for the
consolidated baseline and `20260618000001_custom_constraints_and_indexes` for the hand-written file
beside it. The stamp is a sentinel — the day before the repository's earliest content migration —
because that ordering is the contract: `migrate deploy` applies migrations lexicographically by
directory name, so the baseline has to sort before every migration whose DDL it contains. It is
deliberately not the date the consolidation happened.

The `oauth_*` and `jwks` tables must exist before MCP clients can use the gateway, so deploy the migration
first. The gateway does boot without them: it seeds the MCP resource into `oauth_resources` while
initialising authentication, and tolerates a missing table by deferring that seed to the first use of the
resource. Until the migration is applied the OAuth endpoints fail, and sign-in is unaffected. The OAuth provider distinguishes a
`NULL` array column from an empty one, so only the array columns it requires are `NOT NULL`
(`oauth_clients.redirect_uris` and `scopes` on the access-token, refresh-token and consent tables); every
other array there stays nullable on purpose.

```bash
# 1. Create the database with the pgvector extension
psql -h db-host -U postgres -c 'CREATE DATABASE engineering_system;'
psql -h db-host -U postgres -d engineering_system -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# 2. Apply migrations (run from a host that has the repo + DATABASE_URL set)
yarn workspace @auto-swe/shared exec prisma migrate deploy

# 3. Seed the admin user, default team, default workflow template
yarn db:seed
#    ↳ builds @auto-swe/shared first (the gateway half resolves it through its compiled
#      dist/), then runs provisionAuthAdmin to set up the better-auth credential account
#      so the seeded admin can sign in via the password tab on /login.
#      Needs SEED_ADMIN_PASSWORD (both halves hash it; neither generates one) and
#      BETTER_AUTH_SECRET (provisionAuthAdmin runs without NODE_ENV, which the
#      gateway treats as production) in the environment or the root .env.
```

**Inside Docker.** The gateway image's entrypoint runs `node node_modules/prisma/build/index.js migrate deploy` before starting Fastify, so the runtime image needs the full `prisma` CLI and its transitive dependencies — `prisma` is declared in the package's `dependencies` (not `devDependencies`) so `yarn workspaces focus --production` keeps them. The CLI is invoked by path, so no `.bin` symlink is involved. The simplest pattern for a separate migration step is a one-shot init container. Details in the [`prisma-docker-migrations`](../.claude/skills/prisma-docker-migrations/SKILL.md) skill.

For routine application thereafter, `prisma migrate deploy` is idempotent. **Never use `prisma migrate dev` in production** — it will silently try to drop the HNSW index every time unrelated schema changes are made. See the [`prisma-pgvector-hnsw`](../.claude/skills/prisma-pgvector-hnsw/SKILL.md) skill.

---

## 4. Temporal setup

You have two reasonable paths:

### a. Self-hosted Temporal (Docker Compose / Kubernetes)

The shipped `docker-compose.infra.yml` provisions:
- `postgres-temporal` (a *separate* Postgres from the app DB — needed because Temporal owns the schema)
- `temporal-setup` (one-shot container that installs the Temporal schema)
- `temporal` (the server)
- `temporal-setup-namespace` (one-shot container that creates the namespace) and, for local development only, `temporal-ui` (port `8233`, behind the `temporal-ui` Compose profile; the local `yarn docker:*` / `just` entry points enable it, the production recipes do not)

For real production, run these on dedicated infrastructure (not on the gateway/worker hosts). At minimum:
- Multiple Temporal server replicas behind an internal load balancer.
- Daily backups of `postgres-temporal`.
- Mutual TLS for the worker → Temporal gRPC connection.

### Starting without Temporal

The gateway does not itself need Temporal to boot. It connects in the background, retrying with backoff
(1 s, doubling to 30 s), so an unreachable Temporal at startup delays nothing: sign-in, reads and
settings that do not touch workflows work straight away. The system schedules (consolidation, the
sweeps, eval) are synced once the connection is up. Per-channel and per-work-request schedules are not
re-synced at startup: they are reconciled when their own rows are written, which is refused while
Temporal is not connected (below). The shipped Compose files still gate the gateway on Temporal's
health, so this path applies to deployments that start the gateway independently, such as managed
Temporal or an orchestrator without that dependency.

- **`GET /health`** stays `200` whatever Temporal is doing, so container liveness checks (the gateway
  image's `HEALTHCHECK`) never restart a gateway for a Temporal outage. The body reports
  `{"status":"ok","temporal":"connected"}` or `"temporal":"connecting"`. `connected` means only that the
  first connection has been made: the gateway does not probe, the SDK reconnects on its own, and a
  later outage still reads `connected`. `connecting` means no workflow operation can run yet.
- **Until it connects**, these answer `503` with `{"error":{"code":"TEMPORAL_UNAVAILABLE", ...}}` and
  `Retry-After: 5`: launching, retrying and cancelling runs, signals, human-step responses, eval runs,
  schedule changes, and the other routes that call Temporal. Saving the consolidation, eval and
  re-validation schedule settings, and any Slack channel change to whether or when a digest or poll runs
  (activating, deactivating, enabling, changing a cron, registering with one enabled, deleting), are
  refused before anything is saved, so the database and the schedules never disagree; other channel
  edits go through, including a dashboard save that leaves the schedule fields as they were. The
  synchronous `POST /generate`, the refine route and the explain route keep their own `503` codes
  (`GENERATION_UNAVAILABLE`, `REFINE_UNAVAILABLE`, `EXPLAIN_UNAVAILABLE`); the asynchronous
  `POST /generate/jobs` and `GET /generate/jobs/:id` answer `TEMPORAL_UNAVAILABLE`. Editing a memory item still
  succeeds; its re-embed is best-effort and is skipped when Temporal is not connected.
- **A launch leaves no rows behind**, and a human step answered in that window is put back to pending.
  A webhook-triggered launch in the window gets `503`; GitHub does not redeliver on its own, so redeliver
  it from the webhook's delivery log once `/health` reports `connected`.
- **Lookups that decide whether a run is finished** treat "not connected" as unconfirmed, never as
  finished: agent-run admission keeps its concurrency slots and a re-run is refused rather than started
  on top of a possibly live one. `GET /scheduled-work-requests` returns `exists: null, unavailable: true`
  for each schedule rather than reporting it missing.
- **After connecting**, the SDK's gRPC channel reconnects by itself if the server goes away; calls during
  such an outage fail with the SDK's own error rather than `TEMPORAL_UNAVAILABLE`.

### b. Temporal Cloud

Point `TEMPORAL_ADDRESS` at your Temporal Cloud endpoint and supply the namespace + mTLS certs via the SDK. This removes the Postgres/server burden entirely. The codebase does not wire up the mTLS path — that is a small change in `packages/gateway/src/plugins/temporal.ts` and `packages/worker/src/index.ts` when you need it.

---

## 5. Building the application images

Each service has a multi-stage Dockerfile (`packages/{gateway,worker,web}/Dockerfile`) using the Yarn 4 `workspaces focus --production` pattern. From the repo root:

```bash
yarn docker:app:build       # builds gateway + worker + web
# or:
docker compose -f docker-compose.infra.yml -f docker-compose.app.yml build gateway worker web
```

For a real registry push, the typical CI flow is:

```bash
SHA=$(git rev-parse --short HEAD)
docker build -f packages/gateway/Dockerfile -t registry.example.com/auto-swe/gateway:$SHA .
docker build -f packages/worker/Dockerfile  -t registry.example.com/auto-swe/worker:$SHA  .
docker build -f packages/web/Dockerfile    -t registry.example.com/auto-swe/web:$SHA     .
docker push registry.example.com/auto-swe/gateway:$SHA
docker push registry.example.com/auto-swe/worker:$SHA
docker push registry.example.com/auto-swe/web:$SHA
```

> **The web image takes no URL build args.** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TEMPORAL_UI_URL` and the optional support contact variables (`NEXT_PUBLIC_SUPPORT_*`, see [configuration.md §8](./configuration.md#8-support-contact)) are read at request time by the root Server Component (`app/layout.tsx`) and injected into `window.__APP_CONFIG__`, so one image serves every environment — set them as runtime env on the container. The exception is `NEXT_PUBLIC_APP_VERSION`, the login-footer label: it is inlined by `next build`, and the shipped Dockerfile does not thread it through as a build arg, so the containerised dashboard shows `0.0.0` unless you build the web bundle with that variable set.

---

## 5b. Deploying with the prod compose stack

If you'd rather run prebuilt images than build your own, the repo ships three compose overlays that deploy the GHCR images published by `.github/workflows/docker.yml`:

| File | What it adds |
| ---- | ------------ |
| `docker-compose.prod.yml` | `gateway` / `worker` / `web` from registry images (`pull_policy: always`, `restart: unless-stopped`; gateway and worker take `env_file: .env`, web does not). Overlays the infra file — it reuses `postgres`, `temporal`, and (when the `objectstore` profile is active) `garage` from `docker-compose.infra.yml`. |
| `docker-compose.traefik.yml` | Fronts gateway + web with Traefik TLS. Strips the published host ports (`ports: !reset []`), attaches both to an external `traefik` network in addition to the stack's `default` one (which they still need to reach Postgres, Temporal and each other), and adds `websecure` routers with `certResolver=webcert` for `DOMAIN_API` (gateway) and `DOMAIN_APP` (web). Requires a Traefik instance you run separately, with the `traefik` Docker network already created. |
| `docker-compose.watchtower.yml` | Adds a scoped Watchtower container (`WATCHTOWER_SCOPE`, label-gated, cleanup on) that re-pulls the three app images every `WATCHTOWER_POLL_INTERVAL` seconds (compose default 300; `.env.example` suggests 86400). |

```bash
# Base prod stack (infra + prebuilt app images)
docker compose -f docker-compose.infra.yml -f docker-compose.prod.yml up -d

# With Traefik TLS fronting and Watchtower auto-update
docker compose \
  -f docker-compose.infra.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.traefik.yml \
  -f docker-compose.watchtower.yml \
  up -d
```

Things to know:

- **Pin image tags via `APP_IMAGE_GATEWAY` / `APP_IMAGE_WORKER` / `APP_IMAGE_WEB`.** The compose defaults are the mutable `:main` tags. CI also publishes an immutable `<timestamp>-<commit>` tag per build (plus `:latest` and git-tag refs) — prefer pinning those in production so a rollback is a one-line `.env` change rather than registry archaeology.
- **Image publishing is CI-gated.** The publish job in `docker.yml` runs only after its `checks` job, which calls `ci.yml` itself — docs drift, source invariants, typecheck, lint, tests, build, and the real-database migrations job — so `:main` only moves on builds that pass everything a pull request must. If you run Watchtower against `:main`, that gate is your only protection — a passing-but-bad commit still auto-deploys. Pinned immutable tags + manual bumps are the conservative choice.
- **Required secrets.** The gateway and worker images run with `NODE_ENV=production` and refuse the in-source dev fallbacks, so `.env` must contain real values for `JWT_SECRET`, `BETTER_AUTH_SECRET` (≥32 chars), and `CONFIG_ENCRYPTION_KEY`. `docker-compose.prod.yml` enforces all three with `:?` interpolation errors at `up` time, and both processes additionally validate `CONFIG_ENCRYPTION_KEY` at boot — a key that is present but not base64-encoded 32 bytes exits with a descriptive error before anything is served.
- **The web container does not receive `.env`.** It is handed only what the dashboard reads — `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_TEMPORAL_UI_URL`, `NEXT_PUBLIC_GRAFANA_URL`, the optional `NEXT_PUBLIC_SUPPORT_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL` and `NEXT_PUBLIC_SUPPORT_SLACK`, `NODE_ENV`, `PORT` and `HOSTNAME` — so no secret reaches the Next.js server. Compose still interpolates those values from `.env`. `NEXT_PUBLIC_API_URL` is required (`:?`) and must be the gateway's public URL, since the browser uses it; `API_INTERNAL_URL` defaults to `http://gateway:8080` for the server's own fetches. A new variable the dashboard reads has to be added to the `web` service explicitly.
- **Managed DB.** Set `DATABASE_URL_OVERRIDE` to point gateway + worker at a managed Postgres instead of the compose `postgres` service.
- **Worker DinD.** The worker's `DOCKER_HOST` points at `docker-policy-broker`, which validates bodies and ownership before forwarding to HAProxy on its separate internal network. Only HAProxy mounts the host socket, using root with all capabilities dropped; no worker `DOCKER_GID` is needed. `DOCKER_SOCKET_PROXY_IMAGE` overrides HAProxy; its defense-in-depth allowlist and idle timeouts are in the read-only `infra/docker-socket-proxy/haproxy.cfg`. Keep client/server/tunnel timeouts above the longest step: a foreground `docker run` waits for exit, and a quiet exec stream is cut at the proxy's idle timeout. Watchtower (`docker-compose.watchtower.yml`) keeps its own direct socket mount: it is a separate privileged operator service, not on either Docker API network, and its access is not broker-filtered.
- **Worker health.** The worker serves no HTTP. Its image `HEALTHCHECK` passes while `/tmp/worker-alive` has been touched in the last two minutes; the worker touches it every 10 seconds only while its Temporal worker is running, so a stopped or wedged worker reports unhealthy. The check does not see a worker that polls but fails every activity.
- **Object store selection.** `COMPOSE_PROFILES` in `.env` decides whether the bundled Garage service runs. `objectstore` (the `.env.example` default) starts it; an empty value starts nothing, and the worker's `depends_on` is `required: false` so it comes up regardless. See §5c.

---

## 5c. Choosing an object store

The artifact store holds what would otherwise bloat the workflow context or the app database: diffs, gates' logs, transcript parts and run evidence (screenshots, recordings). Three options, one active writer at a time:

| Store | Selected by | Notes |
|---|---|---|
| **S3-compatible** | `ARTIFACT_S3_BUCKET` | The bundled Garage or any S3/R2/B2 endpoint. Objects are written, read and deleted (`PutObject`, `GetObject`, `DeleteObject`); the choice of provider is operational, not one of compatibility. |
| **Filesystem** | `ARTIFACT_FS_DIR` | A directory mounted into the worker (writes) **and** the gateway (reads). Single host; §5c below. |
| **Postgres** | neither | Small bodies use `workflow_artifacts.inline_blob`; file-backed bodies use 1 MiB `bytea` chunks in `workflow_artifact_chunks`. Fine for small installs and local dev; recordings and screenshots still inflate the app DB and its backups. |

`ARTIFACT_WRITE_BACKEND` (`fs`, `s3`, `pg`) overrides the derived choice when more than one store is configured. Old rows keep working after a switch because reads dispatch on the row's recorded backend: keep `ARTIFACT_FS_DIR` set to read filesystem artifacts, and the S3 bucket/credentials reachable to read S3 ones. Setting a directory and a bucket together without `ARTIFACT_WRITE_BACKEND` is refused at boot rather than guessed.

**Bundled Garage (default).** A single-node [Garage](https://garagehq.deuxfleurs.fr/) container, configured by `infra/garage/garage.toml` and started with `--single-node --default-bucket`. It provisions the cluster layout, the access key and the bucket on first boot from `ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` / `ARTIFACT_S3_BUCKET`, and re-running is a no-op, so there is nothing to bootstrap separately. It idles around 5 MB of RAM. Its state is `./data/garage`, which needs backing up alongside the two Postgres volumes (§9).

Two constraints worth knowing before you set credentials:

- **Garage rejects secret keys shorter than 16 characters.** `ARTIFACT_S3_SECRET_KEY` must clear that bar or the container exits on first boot with `Invalid default access key`.
- **`GARAGE_RPC_SECRET` must be set.** Single-node deployments never put it on the wire, but Garage requires it. `infra/garage/garage.toml` does not carry one; `docker-compose.infra.yml` falls back to a fixed, public value so the local quickstart needs no configuration, and the production overlay cannot require it with `:?` the way it does the other secrets — Compose interpolates every service, including one whose profile is off, so a requirement there would also stop deployments that use hosted S3. `yarn env:setup check --profile prod` is the check instead: it fails while `COMPOSE_PROFILES` includes `objectstore` and the secret is empty or not 64 hex characters. Generate with `openssl rand -hex 32`.

**Hosted S3 instead.** Set `COMPOSE_PROFILES=` (empty) in `.env` and point the artifact variables at the provider. No compose file changes:

| Provider | `ARTIFACT_S3_ENDPOINT` | `ARTIFACT_S3_REGION` | `ARTIFACT_S3_FORCE_PATH_STYLE` |
|---|---|---|---|
| AWS S3 | *(omit)* | your region | `false` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | `false` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | your region | `true` |

`ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` become the provider's credentials — compose passes them into the container as the standard `AWS_*` names the SDK reads, but keeps them under a distinct name outside so an ambient `AWS_ACCESS_KEY_ID` in the deploying shell cannot silently win over `.env`. **The bucket must already exist** — only the bundled store self-provisions one. Storage is environment-only: there is no admin page that overrides it, because the directory or bucket has to be mounted/authorized before either process starts.

### Filesystem store instead of S3

A deployment with no object store can keep artifacts on a directory instead of inflating Postgres.
Set `ARTIFACT_FS_DIR` (and `ARTIFACT_WRITE_BACKEND=fs` if a bucket is also configured) and mount the
**same** directory into both processes: the worker writes, and the gateway serves evidence and
transcripts from it. A gateway that cannot see the store returns errors on every evidence request, so
both mounts are required.

The compose files mount a named volume, `artifacts`, at `/var/lib/auto-swe/artifacts` in both
services. A named volume is the default because Docker seeds it from the image's directory, ownership
included, so a fresh install needs no `chown`. To keep the files at a visible host path instead, swap
it for a bind mount and give it to the image's user first — Docker creates a missing bind-mount source
as `root`, and the services run as `node` (uid 1000):

```bash
mkdir -p ./data/artifacts
sudo chown 1000:1000 ./data/artifacts
# docker-compose override: ./data/artifacts:/var/lib/auto-swe/artifacts
```

What the store guarantees, and what it does not:

- **One store, one identity.** The first write creates `.auto-swe-artifacts.json` in the directory;
  every row records that id. Once rows reference the store, a directory that is missing, empty or a
  different store makes **both processes refuse to start**, rather than serving errors and letting a
  retention sweep delete rows whose files sit on the real volume. With no rows yet the worker
  creates the store on its first write, and the gateway starts without one. Do not delete or copy
  that file between directories.
- **Durable publication.** Each artifact is written to `.tmp/`, fsynced, renamed into place, and the
  directory fsynced before its row is marked ready. An interrupted write leaves at most a temporary
  file, which the daily transcript sweep removes after a day.
- **One host, unless the shared filesystem is trustworthy.** The store's writer relies on a POSIX
  rename and directory fsync it performs locally; nothing verifies those semantics on a network
  filesystem. Across hosts, the volume must be a POSIX shared filesystem with stable directory
  lookups — on NFS a freshly renamed file can be invisible to the gateway for a moment (cached
  lookups), so new evidence may briefly fail to load — and every gateway and worker pod needs
  `ReadWriteMany`. `ReadWriteOnce` only works while the pods are on one node, and two replicas on
  different nodes would see different stores; the store identity check turns that into a failed boot
  rather than missing evidence. **S3 is the supported multi-node store**; the filesystem store is for
  a single host, or a shared filesystem you have verified (`lookupcache=positive`, stable rename and
  fsync). `infra/kubernetes/artifact-store.yaml` is a reference claim and the mounts for both
  workloads.
- **Disk is your capacity limit.** `ENOSPC` fails the artifact write (a run step fails) rather than
  corrupting anything; monitor the volume. No compression, deduplication or replication beyond the
  filesystem's own.
- **Backups.** Back up the directory with the database (§9). A restore of one without the other leaves
  either rows with no files (reads fail) or files with no rows (swept only if a row names them; the
  rest is manual cleanup).
- **Changing the directory** means moving the files: rows store a store-relative path and the base
  comes from `ARTIFACT_FS_DIR`.
- **Nothing is encrypted at rest by the application.** The files are plain artifacts on the volume,
  exactly like the S3 objects and the Postgres blobs; protect the disk the way you protect the
  database (filesystem encryption, access control on the host). Artifact files are created mode
  `0600` and the run/kind directories `0700`, so another local user cannot read the payloads; the
  mount point itself is `0755` from the image, so run ids are listable. A Kubernetes `fsGroup` mount
  may grant the group read/write on entries the kubelet rewrites.

**Migrating an existing MinIO deployment.** Garage's on-disk format is unrelated to MinIO's, so pointing it at `./data/minio` will not work and existing objects will not appear. `ArtifactRef` rows in the app DB hold keys, not blobs, so any object left behind becomes a broken artifact link rather than a visible failure. Copy the objects across before cutting over, with both stores running:

```bash
# Old MinIO on :9000, new Garage on :9100 (GARAGE_API_PORT=9100 temporarily).
rclone copy minio:auto-swe-artifacts garage:auto-swe-artifacts --progress
```

Then swap `GARAGE_API_PORT` back to 9000 and drop the MinIO service. If you would rather not migrate, the artifacts are recoverable output rather than source of truth — leaving them behind costs you the history on already-completed runs, nothing that blocks new ones.


---

## 6. Running the services

The simplest production layout maps the local Docker Compose 1:1 onto the production hosts:

| Host                      | Containers                                  | Notes                                                              |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `db-1`                    | `postgres` (pgvector)                       | Managed Postgres (RDS / Cloud SQL) is fine. Enable the `vector` extension, version 0.8 or later (scoped memory search uses its iterative index scan).   |
| `temporal-1..N`           | `postgres-temporal`, `temporal`, `temporal-ui` | Or Temporal Cloud — skip the host entirely.                       |
| `gateway-1..N`            | `gateway`                                   | Behind your HTTPS reverse proxy. Stateless; scale horizontally.    |
| `worker-1..N`             | `worker` + Docker daemon                    | **Isolated.** Reaches Docker via the socket proxy.             |
| `web-1..N`                | `web`                                       | Behind HTTPS reverse proxy. Stateless; scale horizontally.         |
| `obs-1` (optional)        | `otel-lgtm` or your collector + Grafana    | OTLP/gRPC on `:4317`.                                              |

Reverse proxy routing:

```
https://app.example.com   →  web-*:3000
https://api.example.com   →  gateway-*:8080
https://temporal.example.com (optional, internal only)  →  temporal-1:8233
```

### Kubernetes

The same images run on Kubernetes. [`kubernetes-helm.md`](./kubernetes-helm.md) describes the Helm chart in `deploy/helm/auto-swe`, which deploys the gateway, the web dashboard and a worker on the Kubernetes backend below against an external Postgres and Temporal. There are two ways to run the worker:

- **Docker backend (default).** The worker is the only stateful pod (Docker socket): run it as a single-replica StatefulSet on a dedicated node pool with the socket mounted via `hostPath`. Everything else is a stock Deployment.
- **Kubernetes backend** (`WORKSPACE_BACKEND=kubernetes`). Agent workspaces are pods in their own namespace, so the worker needs no Docker socket and no `docker-socket-proxy`. Workflow shell steps, container steps and container-step sidecars that require shared volumes are not available on this backend (they fail with `WORKSPACE_BACKEND_UNSUPPORTED`); preview-service sidecars are supported in the workspace pod. The worker is a single replica (its proxies keep per-workspace state in memory). See [`architecture.md`](./architecture.md#kubernetes-backend) and its Limitations.

To run the Kubernetes backend:

1. Apply `infra/kubernetes/workspace-namespace.yaml` and `infra/kubernetes/workspace-admission.yaml` after adjusting namespace and worker ServiceAccount names in both (Kubernetes 1.30+). The namespace enforces PodSecurity `restricted`; admission additionally requires the workspace role label, safe volumes, disabled token automount, approved service accounts and pod-name-bound Secret env references. A NetworkPolicy denies all ingress and allows egress only to DNS, the worker's proxy ports and the public internet (never metadata or a private range). The existing worker Role is unchanged; the admission manifest adds only named cluster-resource `get` permissions for startup checks, not policy write access. The worker checks RBAC, policy/binding presence and NetworkPolicy enforcement at start and **refuses to start** on failure. See [Kubernetes Helm](./kubernetes-helm.md#limitations) for Secret ownership and preview-service limitations.
   Preview services configured with `runAsUser` run under Pod Security `restricted`; services that run as root still require `baseline`.
2. Run the cluster on a CNI that enforces NetworkPolicy (GKE Dataplane V2; EKS VPC CNI with network policy enabled; AKS with Azure NPM, Cilium or Calico). The worker checks this at start: it launches a probe pod and **refuses to start** if the pod can reach `169.254.169.254` or the cluster API address.
3. Set `HARNESS_MODEL_PROXY_PORT` and `HARNESS_MODEL_PROXY_URL` (the model proxy is required on this backend: the worker **refuses to start** without the port, or with a URL that is unset, uses the Docker host alias or a loopback or unspecified host (`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`), or contains `{hostname}`, because the provider API key would otherwise be placed inside the workspace pod), and, if you set `REGISTRY_PROXY_PORT` or `EGRESS_PROXY_PORT`, the matching `REGISTRY_PROXY_URL` or `EGRESS_PROXY_URL` (the worker **refuses to start** without it, or with a URL that is unset, uses the Docker host alias, a loopback or unspecified address such as `localhost`, or contains `{hostname}`, because workspace package installs or outbound HTTP(S) calls would fail), to a Service name pods can resolve (the `{hostname}` placeholder is the worker pod's name, which other pods cannot resolve; the default Docker host alias does not exist in a cluster), and the matching `*_BIND` to `0.0.0.0`.
4. Set a node-pool `podPidsLimit`: Kubernetes has no per-pod PID cap, so `WORKSPACE_PIDS_LIMIT` is not applied.
5. Make sure the executor image runs as a non-root user. The curated images use uid 1000; set
   `K8S_WORKSPACE_RUN_AS_UID` if yours differs. Workspace pods drop all capabilities and use the
   runtime-default seccomp profile; the stray-process sweep relies on the absence of
   `CAP_SYS_ADMIN` and this profile to prevent a process from moving into another mount namespace.
6. Egress policies `blocked` and `restricted` need the whole manifest. The worker labels a locked workspace `asw/egress=blocked` or `asw/egress=restricted`, which moves it off `workspace-egress` (it selects `asw/egress NotIn [blocked, restricted]`) onto a narrow policy: `workspace-egress-blocked` (DNS and the worker's model and registry proxy ports; no forwarding proxy) for `blocked`, or `workspace-egress-restricted` (the same plus the egress forwarding proxy port, admitted by selecting the worker pods, not by address) for `restricted`. It also creates one NetworkPolicy per locked pod, owned by the pod, for the addresses the allowed hosts resolve to at that moment. The worker's Role therefore also needs `patch` on pods and `create` on `networkpolicies`. The worker proves the lock from inside the pod with a TCP connect check (`nc`, `bash` under `timeout`, or `curl` with proxies bypassed; the image needs one of them): it first finds a public address (`1.1.1.1:80`, then `1.1.1.1:443`, `8.8.8.8:443`, `9.9.9.9:443`, skipping any that is also an allowed address) the unlocked pod can reach, applies the label, and fails the workspace unless that same address then reads as unreachable in two consecutive samples. A workspace that cannot reach any of them before the label fails closed, because an unreachable address afterwards would prove nothing; a manifest that was not re-applied fails closed too. An allowed host whose addresses change during a run becomes unreachable.
   - **The per-pod policy is address-based.** Every allowed host becomes a `/32` or `/128` `ipBlock`. A Service ClusterIP in that list (the egress proxy under `restricted`, if a caller passes it) is harmless but not relied on: NetworkPolicy semantics for traffic addressed to a Service IP are undefined and most CNIs match the post-DNAT pod IP, so the rule may never match. The shared `workspace-egress-restricted` policy is what admits the egress proxy.
   - **DNS is a residual channel.** A locked pod keeps DNS to kube-dns, because the proxy URLs are Service names and the pod resolves its git host itself. A NetworkPolicy cannot filter by name, so kube-dns recurses any query the pod sends, and a workspace can leak data at low bandwidth by encoding it in lookups for a domain whose name server it controls. An operator who needs to close that channel applies a DNS policy outside this manifest, for example a CoreDNS server (or a `forward` and `template` block scoped to the workspace namespace) that answers only the cluster's own zones and the allowed git hosts and refuses everything else, and points the workspace namespace's NetworkPolicy at it instead of kube-dns.
   - **`create` on `networkpolicies` is a broad grant.** NetworkPolicies are additive, so withholding `update`, `patch` and `delete` does not stop a holder of the worker's token from creating a policy that admits all egress to a workspace pod. The manifest ends with a commented, disabled `ValidatingAdmissionPolicy` example that limits what the worker's ServiceAccount may create to egress policies owned by a pod, selecting one pod by `asw/workspace` and admitting only `/32` and `/128` addresses (Kubernetes 1.30 or later).

To exercise the backend against a real API server with kind, use the gated
[`driver.kind.test.ts`](./ui-validation.md#kubernetes-kind-integration-test). It uses the active
kubeconfig context and `kubectl` on `PATH`, so apply the namespace manifest and load the
`auto-swe/node-browser:phase-a` and `mirror.gcr.io/library/postgres:18` images first. Set
`K8S_KIND_TEST=1`, `K8S_WORKSPACE_NAMESPACE=auto-swe-workspaces`, and
`K8S_WORKSPACE_RUN_AS_UID=1000`; use `K8S_KIND_EVIDENCE_DIR` to save the preview screenshot and test
output. The test requires an enforcing CNI and temporarily uses Pod Security `baseline` for its
root-starting service success case, restoring the namespace's `restricted` label afterward.

The environment variables are listed below. Unset ones take the defaults shown.

---

## 7. Post-boot smoke test

```bash
# Gateway healthcheck (any auth provider is fine if configured)
curl -sf https://api.example.com/api/v1/auth/providers

# Sign in to the web app as the seeded admin
open https://app.example.com
# email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD

# In the dashboard:
#  1. Settings → API tokens → "+ New token"  → save the PAT to your secret manager
#  2. Connections → "+ Add connection"       → connect a real git repo (use a test one first)
#  3. Dashboard "+ New request" → select the ticket-to-merge template → smallest possible task; verify the run starts
#  4. Watch the request in /requests (open it from the list) and the run in the Temporal UI

# Then verify webhooks both directions
#  - GitHub merge of the test PR fires POST /api/v1/webhooks/git → workflow completes
#  - If the repo has CI, a check_run POST to /api/v1/webhooks/ci (or /git) → ciFixLoop kicks in on failures
```

---

## 8. Day-2 operations

| Concern                    | Where to look                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Workflow visibility        | Temporal UI (`:8233`), or `/requests`, `/runs`, `/requests/:id` in the dashboard.                              |
| Cost tracking              | `/admin/usage` (every LLM and embedding call, runs or not), `WorkflowRun.costUsdAccrued`, `/admin/analytics`, the `llm_cost_usd_total` metric. Unknown models log `llm.cost_pricing_known=false`. |
| Metrics & traces           | Grafana (`:3001` with the bundled `otel-lgtm`) → **auto-swe — LLM & workflow overview**, provisioned from `infra/grafana/`. With your own collector, import `infra/grafana/dashboards/auto-swe-overview.json`, and put `infra/grafana/provisioning/auto-swe-alerts.yaml` in your Grafana's `provisioning/alerting` directory for the transcript alert rules; both expect Prometheus and Tempo datasources with UIDs `prometheus` and `tempo`. A run's activities are in the trace of the request that started it; search Tempo by `span.temporal.workflow_id`. Gateway and worker both export metrics. |
| Logs                       | stdout/stderr on both services. Both services also export their logs over OTLP to Loki — the gateway's request logs, the worker's Temporal and activity lines (audit lines included) — each carrying its trace id. A custom `CMD` must keep `--import ./packages/<service>/dist/instrument.js`, or HTTP spans go missing (see [`architecture.md` §8](./architecture.md#8-observability--cost)). |
| Per-team A/B experiments   | `/library/[id]` → set `experimentVersion` + `experimentSplit`.                                                  |
| Rotating LLM models        | Change model spec at `/models` (takes effect on next activity call). A model with no price is recorded at $0 — price it on its `model_catalog_entries` row (see [model configuration](./model-configuration.md#model-catalog)). |
| Rotating GitHub PAT        | `/admin/integrations → GitHub` → enter new token → Save. No restart required. |
| Rotating Slack bot token   | `/admin/integrations → Slack` → enter new bot token → Save. No restart required. |
| Rotating S3 credentials    | Update `ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` (or `AWS_*`) in `.env` → restart the worker. |
| Rotating OAuth app creds   | Update `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` / `OKTA_CLIENT_SECRET` in `.env` → restart the gateway. |
| Rotating secrets           | `BETTER_AUTH_SECRET` / `JWT_SECRET` invalidate all existing sessions/tokens. Communicate before rotating.        |
| Sessions admin             | `/admin/sessions` (revoke any session); `/admin/api-tokens` (revoke PATs across all users).                   |
| Shell-step audit           | `workflow_shell_audit` rows are kept as long as their template; deleting a template removes its rows. `POST /api/v1/platform/shell-audit/prune?days=N` (ADMIN; `dryRun=true` only counts) deletes rows older than N days whose template is ARCHIVED, and never those of ACTIVE or DRAFT templates. |
| Lesson retention           | `memory_items` grows over time; no automatic pruning. Manual `DELETE` is fine — drops the row from the HNSW index. |
| pgvector index rebuild     | `REINDEX INDEX idx_memory_items_embedding;` — only needed after a bulk import or if recall degrades.            |

---

## 9. Backup + DR

Two stateful datastores, plus the artifact store when it is not Postgres:

1. **`postgres` (app DB)** — `pg_dump`. Recovery is straightforward. Restoring loses no functionality; the worker just resumes whatever Temporal still has in flight.
2. **`postgres-temporal` (workflow history)** — `pg_dump`. Loss of this DB means in-flight workflows are gone forever (signals, history, timers). For long-running humanMergeSignal waits (up to 7 days), this is real data loss. Treat this DB at least as carefully as the app DB.
3. **Artifacts** — the filesystem store's directory (`./data/artifacts`, or the `artifacts` volume) or the S3 bucket. Back it up with the app DB: a database restored against an older directory leaves rows whose files are gone, and a directory restored against an older database leaves files nothing references. Artifact files are created `0600` (the store's own directories `0700`; the mount point itself is `0755`), and are not readable by other uids; preserve ownership when restoring.

Container workspaces are ephemeral — never back them up. The Docker daemon on the worker host can be restored from scratch.

Docker agent workspaces run as UID/GID `1000:1000`, like the default Kubernetes workspace pod.
Before provisioning, the Docker daemon assigns `/workspace`, `/workspace/target-repo` and
`/workspace/.home` to that user; `HOME` is `/workspace/.home`. File and archive imports use
archive-mode `docker cp`, which assigns the configured container user's ownership in the daemon,
without running a privileged chown in the workspace. Clones, git config, setup scripts, package
caches, catalog tools and harness files are writable by the workspace user. Setup-cache keys include
UID and HOME. Attached services keep their own user settings, and NET_ADMIN helpers are unchanged.

Only worker-controlled preparation can use `docker exec --user 0`: it runs a fixed bootstrap from
`/`, with an empty environment, a system-only PATH and absolute apk/apt-get paths. Bootstrap
authority is revoked after installation, before the handle is returned; ordinary exec also revokes
it. Attached handles cannot acquire it. There is no root repair or package installation after clone,
setup or agent code. Claude Code checks for bash without installing packages at harness start.
If the image lacks a supported package manager or installation fails, creation fails with a clear
git/bash bootstrap error; preinstall those tools in such images.

Build OS packages into custom executor images rather than running `sudo`, `apk` or `apt-get` in
repository setup. All curated executor images select UID 1000; git and bash are preinstalled.
Only the literal `WORKSPACE_RUN_AS_ROOT=true` opts Docker workspaces out: no user or HOME override
or directory preparation is applied, and file imports keep their legacy behavior. This restores
the image's `USER`, not necessarily UID 0; an image with `USER node` still runs as node. The switch
does not alter Kubernetes, whose `runAsUser`, `runAsGroup` and `fsGroup` remain configured by
`K8S_WORKSPACE_RUN_AS_UID`.

---

After startup assertions, each Docker worker creates a throwaway workspace, verifies its baseline
and strict blocked lock, then removes it. A probe failure records `networkLock=false` with a reason
and a warning; it does not refuse worker startup. Kubernetes reports its NetworkPolicy boot-gate
result; disabling that gate reports enforcement as unavailable. Each process upserts a capability
report with its backend and configured egress/registry proxies, refreshes only its timestamp every
ten minutes, and removes its row on graceful shutdown. Setup readiness reads reports fresh within
thirty minutes and requires every fresh worker to support the configured policies at every scope.
With no fresh report the check is advisory. Policy and team-allowlist saves warn without refusing
the save. Edit the policy in Platform settings, Workspace.

The Docker baseline helper runs on every workspace and every `network: egress` shell/container
step by default, before author code starts. Steps start a locked-down network holder on the bridge
and verify its baseline before joining that namespace. Detached container-step sidecars share
the holder's baseline and publish their loopback port there. The holder receives the step's DNS
and host pins (including the DNS allowlist filter); otherwise it uses `WORKSPACE_DNS`. Foreground
completion and detached sidecar teardown remove the holder, and workspace labels cover orphan
reaping after worker loss. `network: none` steps need no holder. Use a
`WORKSPACE_METADATA_BLOCK_IMAGE` with iptables and ip6tables preinstalled to avoid an `apk add`
per workspace or egress step and a dependency on the Alpine mirror. Installation and kernel read-back
must succeed; an unavailable ip6tables is accepted only if IPv6 is disabled in the namespace.
Workspaces admit private git hosts, configured DNS and worker proxy ports automatically. Egress
steps admit their configured DNS and the registry/egress proxy ports they use, not the git host.
Other internal destinations require `WORKSPACE_PRIVATE_EGRESS_ALLOW` (comma-separated IPv4/IPv6
addresses or CIDRs, validated at worker boot). Metadata REJECTs precede all such exceptions.
Disabling private blocking retains metadata protection unless both controls are off.

`WORKSPACE_DISK_LIMIT` caps each Docker workspace's writable layer, not volumes or logs.
When set, worker boot probes `docker run --rm --storage-opt size=<limit> <helper-image> true`
and refuses to start if unsupported. Overlay2 needs XFS with pquota; devicemapper, btrfs and zfs
are other supported driver options. A second, unstarted probe container identifies the driver
through `docker inspect` and is then removed. Only those supported drivers are accepted:
Docker's containerd `overlayfs` driver can accept the size option without enforcing it and is
refused. The worker does not need `docker info` access.

### Optional Docker sandbox runtime

`WORKSPACE_RUNTIME` selects a registered Docker runtime for agent workspaces, workflow shell and
container-step authors and their sidecars. Egress holders use the selected runtime except with
Kata, whose trusted holders and network helpers explicitly use runc. Other trusted helpers and
fresh delivery containers keep the daemon default runtime. Runtime names are validated at boot;
unset means no runtime override and no runtime gate. Keep the daemon default as runc for trusted
helpers. Install the sandbox runtime on the Docker host, not inside the worker.

For gVisor, register a host-stack runtime in the Docker daemon configuration (merge with existing
settings, then reload Docker):

```json
{
  "runtimes": {
    "runsc-host": {
      "path": "/usr/local/bin/runsc",
      "runtimeArgs": ["--network=host", "--overlay2=none", "--file-access=shared"]
    }
  }
}
```

Set `WORKSPACE_RUNTIME=runsc-host`. `--network=host` here selects gVisor's **host Linux netstack
inside the container's Docker network namespace**, not Docker's host network mode. It preserves
the namespace OUTPUT filtering but exposes more of the host kernel's network implementation than
gVisor's sandbox netstack. Default runsc's sandbox netstack can pass iptables read-back while
fresh private and public connections bypass the rules; it is refused by the traffic gate.

gVisor's default `root:self` overlay separates guest-created directories from Docker's rootfs
view: a `/workspace` created via exec can be missing to `docker cp`.
`--overlay2=none` removes that overlay; `--file-access=shared` revalidates external writes instead
of assuming exclusive rootfs access. The gate checks a copy into `/workspace` through exec and
a copy back out. Internal or separately mounted filesystems, including gVisor's `/tmp` tmpfs,
are not Docker rootfs copy destinations; use `/workspace` for copied files.

When a runtime is configured, worker boot requires: a running container whose inspected runtime
matches; a real backend workspace with its verified baseline; a live HTTP peer on that workspace's
network that the workspace cannot reach; public TCP to `1.1.1.1:443` before the blocked lock and
failure after it; and a visible `docker cp` round trip. Failed public TCP before the lock is
**inconclusive and refuses startup**, not proof of enforcement. The helper image needs `wget`,
`nc` and BusyBox `httpd` as well as iptables/ip6tables. Missing tools, intentionally disabled
private blocking, or a CIDR exception covering the probe peer can also refuse the gate. All probe
containers and temporary files are removed in `finally`.

#### Kata with Docker

Kata provides a separate guest Linux kernel in a lightweight VM. The Docker backend supports the
Kata 4.2.0 Go shim's **IPv4 tcfilter** topology with stateful tc conntrack enforcement on the tap
and lower veth ingress, ahead of Kata's redirects. Guest traffic bypasses namespace OUTPUT, so
iptables read-back alone is insufficient. The same runtime gate checks private-peer rejection,
public TCP before and after the blocked lock, runtime identity and copy visibility. macvtap and
unknown layouts are refused; do not disable the gate or private-range blocking to bypass refusal.

The following reproduces the host installation on x86-64 Docker 29.9.2 / containerd 2.4.2. It pins
the official **Go** static release, not the Rust shim tarball. The Go runtime is supported but
deprecated upstream; alternative shim profiles are not validated by this configuration. The
host needs KVM, hardware virtualization exposed to the VM when nested, `tar` and `zstd`:

```sh
KATA_VERSION=4.2.0
curl -fL "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-go-static-${KATA_VERSION}-amd64.tar.zst" -o kata.tar.zst
printf '7dda31ca54b397cbf8165f620d6041872d3c45b7a77383ce0e86f76a06e103d0  kata.tar.zst\n' | sha256sum -c -
sudo tar --zstd -xf kata.tar.zst -C /
sudo ln -s /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
sudo modprobe vhost_net
sudo modprobe vhost_vsock
printf 'vhost_net\nvhost_vsock\n' | sudo tee /etc/modules-load.d/kata-containers.conf
sudo /opt/kata/bin/kata-runtime check --no-network-checks
docker run --rm --runtime io.containerd.kata.v2 --memory=256m --pids-limit=64 \
  --cap-drop=ALL --security-opt=no-new-privileges mirror.gcr.io/library/alpine:3.20 uname -r
```

Docker resolves the shim through the service's PATH; `/usr/local/bin` must be present there. This
does not replace `/etc/docker/daemon.json`, change the default runtime, restart Docker, or remove
existing `runsc` / `runsc-host` registrations. On the tested host both gVisor registrations still
execute after installation. Review existing files before installing over them. The default Kata
configuration is `/opt/kata/share/defaults/kata-containers/configuration-qemu.toml`. When using an
override at `/etc/kata-containers/configuration.toml`, preserve the complete configuration and set
`internetworking_model = "tcfilter"` in its runtime section. Guest seccomp remains enabled.

The Docker host must retain a working `runc` runtime and support nftables netdev ingress/egress,
flower classification and `tc action ct`. The trusted helper image contains `ip`, `tc`, `nft`,
iptables/ip6tables, git/bash and the gate's BusyBox tools **before startup**; the guarded helper
cannot download missing tools. Build and pin the supplied helper on the Docker host:

```sh
docker build -f infra/kata-helper.Dockerfile -t auto-swe-kata-helper:local .
# In the worker environment; use a digest-pinned trusted image in production:
WORKSPACE_METADATA_BLOCK_IMAGE=auto-swe-kata-helper:local
WORKSPACE_RUNTIME=io.containerd.kata.v2
```

A trusted runc holder owns the Docker network namespace. Verified netdev drop guards precede an
inert, cap-drop-ALL/no-new-privileges Kata sandbox from that helper image. The helper validates the
actual tun/tap + veth and reciprocal redirects, installs and reads back the full tc/ct policy,
then releases the guards. Only then do untrusted workspace, shell/containerStep and service
children start. Children use owned CRI sandbox annotations and share **one VM** with the step's
sidecars and preview services. Independent Kata VMs in one netns are not supported. The holder
and sandbox carry workspace ownership/age labels and follow failure cleanup, removal and orphan
reaping. A failed or concurrent lock replacement destroys the group; each replacement uses a
fresh conntrack zone behind two-direction drop guards, not grandfathered setup connections.
Post-setup host pinning writes the holder's daemon-owned hosts file, never a root workspace exec.
The backend waits for the guest's virtiofs view to observe the pins and refuses if read-back fails.

Kata adds VM startup, memory and trusted-holder/helper overhead to each workspace or step group.
Single-host VM-only diagnostics with local images measure about 3.8–4.7 seconds for non-root
create/bootstrap versus 1.2 seconds under runc; the guarded group adds additional helper runs.
Pause/unpause is about 0.1 seconds and a small copy round trip about 0.07–0.10 seconds in those
diagnostics. These are illustrative measurements, not workload or capacity guarantees.

#### Kubernetes RuntimeClass

For Kubernetes, `K8S_REQUIRE_RUNTIME_CLASS=true` requires `K8S_WORKSPACE_RUNTIME_CLASS`, a successful
`kubectl get runtimeclass <name>`, and a probe pod that returns the same `spec.runtimeClassName`.
The NetworkPolicy startup pod is reused when available; disabling that gate still creates a
RuntimeClass probe. The reference workspace manifest grants `get` on cluster-scoped `runtimeclasses`
in API group `node.k8s.io` through a ClusterRole/ClusterRoleBinding for the worker ServiceAccount.
Adjust the binding's ServiceAccount namespace/name along with the namespaced RoleBinding; narrow
the ClusterRole with `resourceNames` to the configured class if required.

Kata on Kubernetes uses the node's CRI handler and CNI, not Docker's shared-container network
namespace arrangement. Install the upstream `kata-deploy` chart on suitable nodes, then reference
its RuntimeClass, or configure a `kata` handler and apply
[`infra/kubernetes/kata-runtimeclass.yaml`](../infra/kubernetes/kata-runtimeclass.yaml). The latter
selects nodes labelled `katacontainers.io/kata-runtime=true` and accounts for 250m CPU / 160Mi memory
per pod; adjust overhead to measured node/VMM behavior. The application chart can create the same
class or reference an existing one and grant a named-resource read to the worker. See
[Kata RuntimeClass](./kubernetes-helm.md#kata-runtimeclass). The RuntimeClass gate does not require
an admission-policy installation.

## 10. Hardening checklist

- [ ] `WORKSPACE_RUN_AS_ROOT` is unset or `false`; a real workspace reports `id -u` and `id -g` as 1000, can write to `$HOME`, and can clone, commit and export changes. Custom images ship git and required OS tools, and setup scripts need no root.
- [ ] Docker private-range and metadata blocking remain on; internal exceptions are narrow and deliberate.
- [ ] The baseline helper image has iptables/ip6tables preinstalled and is available to the daemon.
- [ ] An optional Docker runtime passes the boot traffic/copy gate; runsc-host uses host netstack, no root overlay and shared rootfs validation. The daemon default remains runc for trusted helpers.
- [ ] Kubernetes deployments that require a sandbox set `K8S_REQUIRE_RUNTIME_CLASS=true`, configure the RuntimeClass and grant the worker cluster-scoped `get` permission.
- [ ] `WORKSPACE_DISK_LIMIT` is set where writable-layer growth needs a cap, and the startup quota probe succeeds.

- [ ] `BETTER_AUTH_URL` and `CORS_ORIGIN` point at your real HTTPS domain (gateway refuses to issue secure cookies otherwise). `BETTER_AUTH_URL` is also the issuer and audience of the OAuth tokens MCP clients receive (see [`oauth-setup.md`](./oauth-setup.md#the-platform-as-an-oauth-server-for-mcp-clients)), so it must be the public URL clients reach and must not change once clients are connected.
- [ ] `BETTER_AUTH_SECRET` is ≥32 chars and matches across all gateway replicas.
- [ ] `JWT_SECRET` (or RSA key pair) is set, and is *not* the `.env.example` placeholder.
- [ ] `SEED_ADMIN_PASSWORD` is rotated or the seed admin is deleted after first sign-in.
- [ ] OAuth consent screens are published (Google) and homepage URLs filled (GitHub) for prod-grade UX.
- [ ] Magic-link transport is verified end-to-end against a real inbox (not just SMTP 2xx).
- [ ] Worker host is isolated — separate VPC subnet, no shared Docker socket (the worker holds none; only `docker-socket-proxy` does), no inbound traffic.
- [ ] Infra ports are not world-reachable. `docker-compose.infra.yml` publishes Postgres (5432), Temporal (7233, plus 8233 for the Web UI only when the `temporal-ui` profile is enabled, which production must not do) and the object store (9000) — and `docker-compose.app.yml` Grafana (3001) and OTLP (4317/4318) — on loopback by default so the runbook can reach them from the host. An override such as `POSTGRES_PORT=55432` without the `127.0.0.1:` prefix publishes on every interface; keep the prefix, or firewall the port. The local `docker-compose.app.yml` also binds the gateway (8080) and dashboard (3000) to `APP_BIND_ADDRESS`, loopback by default; `docker-compose.prod.yml` publishes those two on every interface (or not at all under the Traefik overlay), so put them behind the reverse proxy.
- [ ] `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` are left at the defaults (200 per minute per client) unless a suite drives one signed-in user hard: an end-to-end (Playwright) run loads many pages as a single user and exhausts 200 per minute. Raise them only for that environment. Both are read once at startup and a value that is not a positive integer stops the gateway from booting.
- [ ] `WEBHOOK_RATE_LIMIT_MAX` (default 6000 per window, the same window as `RATE_LIMIT_WINDOW_SECONDS`) is sized above the GitHub App's peak delivery rate. The GitHub-signed webhook routes (`/api/v1/webhooks/git`, `/access`, `/ci`) have this ceiling instead of `RATE_LIMIT_MAX`, per client address and per route: every delivery from a GitHub host arrives from one address, an App installed on many repositories can send hundreds of deliveries a minute, and GitHub does not retry a `429`, so a delivery over the ceiling is lost. The tuned value is read once at startup and an invalid one stops the gateway from booting.
- [ ] Reverse proxy enforces HTTPS and forwards `X-Forwarded-For` / `X-Forwarded-Proto`, and `TRUST_PROXY` names that proxy's IPs or CIDRs. The gateway rate-limits a verified user by user id and everything else by client IP; without `TRUST_PROXY` every anonymous request behind the proxy shares the proxy's IP and one limit. Do not set it when clients can reach the gateway directly — they could then choose their own IP.
- [ ] With the bundled object store (`COMPOSE_PROFILES=objectstore`), `GARAGE_RPC_SECRET` is set in `.env`. Compose does not enforce it in production (§5c); left unset, Garage runs on the infra file's public placeholder.
- [ ] Postgres connection uses TLS (`?sslmode=require`).
- [ ] The artifact store has a retention/lifecycle policy you control: the daily transcript sweep deletes expired artifacts through the application, but it does not expire objects a deleted run left behind. On S3, add a bucket lifecycle rule; on the filesystem store, monitor the directory (`workflow-artifacts` keys and `.tmp/` are the two places to watch).
- [ ] Temporal namespace retention is set deliberately (default in self-hosted = 30d; tune for your humanMergeSignal wait).
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the collector is reachable — otherwise traces, metrics and logs silently drop.
- [ ] GitHub PAT and webhook secret are set via `/admin/integrations` (or env var fallback). Secrets are random per-environment.
- [ ] `CONFIG_ENCRYPTION_KEY` (base64 32-byte random) is set and backed up — it encrypts all DB-stored secrets (GitHub token, Slack tokens, S3 key, OAuth secrets). Loss = all stored credentials are unreadable.

---

## Limitations

- GLOBAL `workspace.egressPolicy` defaults to `restricted`; workers need an egress proxy to boot.
  Both Compose overlays enable `EGRESS_PROXY_PORT=8792` with the existing worker-hostname URL and
  `0.0.0.0` bind defaults. Custom deployments must configure a reachable proxy endpoint or explicitly
  set GLOBAL policy to `open`. Restricted clients must use HTTP(S) proxy support for hosts in the
  baseline/team union; non-proxied public sockets are blocked. Baseline and team lists are live,
  not pinned per run. See [upgrade notes](./upgrade-notes.md#restricted-egress-default).

- Egress readiness uses self-declared, freshness-based worker reports, not a gateway-side probe.
  A dead worker may influence the result for thirty minutes; a running worker is not re-probed
  until restart. Reports describe configured proxies, not proxy reachability or health.

- **Runtime enforcement is checked only at worker boot.** It does not monitor daemon/runtime, network or admission changes afterwards. Restart workers after changing those controls. A runtime name or RuntimeClass match alone does not prove a particular sandbox implementation; Kubernetes relies on the cluster's RuntimeClass handler configuration.
- **Kata needs usable virtualization, not just a device filename.** Nested hosts must expose CPU
  virtualization and permit KVM VM creation. The Docker profile uses the upstream-deprecated Go
  shim; Rust Docker profiles are not validated. Kubernetes RuntimeClass
  rendering does not install node binaries or prove VM isolation. Its Kata/CNI combination requires
  validation on the target cluster, which is not exercised by the local Docker diagnostics.
- **Docker Kata is IPv4 tcfilter only.** IPv6 is dropped entirely, including explicit IPv6 allows;
  ARP is forwarded and other L2 protocols are dropped. macvtap and unknown topologies are refused.
  Drops replace iptables REJECT responses, so denied connections can time out. runc and runsc-host
  retain their iptables behavior. Kata requires a prebuilt trusted helper and explicit runc access.
- **A Kata step and its sidecars/preview share one VM.** Their container namespaces are not a VM
  boundary between them. Docker policy-broker profiles for owned CRI annotations and trusted runc
  holders/helpers are not included; a broker without those profiles refuses this topology.
- **The Docker runtime gate samples IPv4 HTTP and one public TCP target.** It is not an exhaustive isolation audit. An unreachable public pre-check refuses startup as inconclusive. Default runsc is incompatible with the namespace OUTPUT lock; runsc-host exposes the host kernel netstack. gVisor's internal `/tmp` tmpfs does not support Docker rootfs copy visibility, even with the required rootfs settings; copied workspace files belong under `/workspace`.

- **The Docker UID control covers agent workspaces, not shell/containerStep images or services.** Author steps and their sidecars retain image-defined users and existing volume ownership; they can run as root. Services retain their explicit user/capability rules. The root opt-out preserves image behavior rather than forcing UID 0. Custom images with root-owned application files outside the prepared directories need rebuilding. Bootstrap needs package-mirror access when git/bash are missing; images without apk/apt-get must include them. Non-root does not replace network isolation or host hardening.
- **The prebuilt executor images are amd64 only and rebuild only when `main` moves.** `docker.yml` builds for the platforms in `BUILD_PLATFORMS`, and has no schedule, so a base-image fix reaches `executor-*` at the next push to `main` rather than weekly; pin by digest and rebuild on your own cadence if you need one.
- **Only `docker-compose.prod.yml` runs the production Temporal dynamic config.** It points Temporal at `infra/dynamicconfig/production-sql.yaml`, which omits the development-only `system.forceSearchAttributesCacheRefreshOnRead` (a search-attribute cache refresh on every read). A deployment built on `docker-compose.app.yml` instead keeps `development-sql.yaml`. The two files are kept identical otherwise by hand; nothing checks it.
- **The Docker broker is not a kernel sandbox or aggregate quota manager.** Its profiles constrain Docker API authority; approved code still runs against the host kernel, and concurrency can exhaust host resources. Image allowlists and runtime settings remain operator trust decisions.
- **The Docker socket proxy runs as root.** It must open the host socket, which is root-owned; the container is read-only, drops every capability and runs nothing but haproxy. CI exercises the worker's Docker calls through the same image and config.
- **HAProxy alone is insufficient.** Its path-prefix allowlist remains defense in depth; custom deployments must not give the worker a route around the broker. Broker state is local to one broker/daemon pair, not a shared multi-replica coordinator.
- **The infra images are tag-pinned, not digest-pinned.** The app Dockerfiles, the agent executor image, the socket proxy default and `otel-lgtm` pin `tag@sha256:<digest>` (the multi-arch index digest, so amd64 and arm64 both resolve), and Dependabot bumps tag and digest together. The images in `docker-compose.infra.yml` (pgvector, postgres, the Temporal images, Garage) and Watchtower stay tag-only because each tag is a `${VAR:-default}` override point: a digest appended after the variable would win over the tag, so a deployment's override would be silently ignored. A registry can still move what those tags resolve to. `DOCKER_SOCKET_PROXY_IMAGE` replaces the whole reference, digest included, so an override there is as pinned as the value it supplies.
- **The GitHub webhook ceiling is per process, per address and per route.** Gateway replicas do not share it. A delivery over `WEBHOOK_RATE_LIMIT_MAX` from one address in a window is answered `429` and is not retried by GitHub. Anyone who can make the GitHub host send junk deliveries to the endpoint (anyone able to add a webhook on a repository the host serves) counts against the same address bucket as the valid ones, so the ceiling bounds that, it does not prevent it. Unsigned requests are cheap to refuse but not free: each costs one secret lookup and one HMAC check. When `TRUST_PROXY` trusts a hop that forwards a client-chosen `X-Forwarded-For`, a caller can pick the address, and so the bucket, it is counted in. The other webhook routes (template tokens, Jira, inbound events) keep their own limits.

---

## 11. Where this guide ends

This doc covers infrastructure setup and the first happy-path workflow. For everything else:

| To understand… | Read |
|---|---|
| Conventions and implementation gotchas | [`AGENTS.md`](../AGENTS.md) |
| Workflow engine, data model, auth, infrastructure | [`architecture.md`](./architecture.md) |
| Agent roles, skills, tools, scanners, tracing | [`agents.md`](./agents.md) |
| Model + credential configuration | [`model-configuration.md`](./model-configuration.md) |
| OAuth providers and magic-link email | [`oauth-setup.md`](./oauth-setup.md) |
| The full doc map | [`docs/README.md`](./README.md) |
