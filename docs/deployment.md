# Production Deployment

End-to-end runbook for taking auto-swe from a fresh clone to a running production deployment. For local development, use the quickstart in [`README.md`](../README.md). For OAuth provider configuration, see [`oauth-setup.md`](./oauth-setup.md).

---

## 0. What you're deploying

Five long-running processes plus one Docker daemon:

| Service                    | Image                                              | Purpose                                                                |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `postgres`                 | `pgvector/pgvector:pg18`                           | App DB — relational state + pgvector for semantic memory.              |
| `postgres-temporal`        | `postgres:18-alpine`                               | Separate DB for Temporal history. Do **not** combine with the app DB.  |
| `temporal` (server+admin+ui) | `temporalio/server:1.31.2` + admin-tools 1.31 + ui 2.53.3 | Workflow orchestration runtime + setup container + web UI on `:8233`.  |
| `gateway`                  | built from `packages/gateway/Dockerfile`           | Fastify HTTP API on `:8080`. Stateless, scale horizontally.            |
| `worker`                   | built from `packages/worker/Dockerfile`            | Temporal worker. Spawns ephemeral Docker workspaces via the host socket. |
| `web`                      | built from `packages/web/Dockerfile`               | Next.js dashboard on `:3000`. Stateless, scale horizontally.           |
| `otel-lgtm` (optional)     | `grafana/otel-lgtm:0.30.2`                         | Grafana + Loki + Tempo + Mimir bundle for traces, logs, metrics.       |
| object store (optional)    | `dxflrs/garage` (bundled) / AWS S3 / Cloudflare R2 / Backblaze B2 | S3-compatible artifact store for large step outputs (diffs, logs, scan reports). Without it the worker falls back to Postgres-inline storage which inflates the app DB. |

The worker mounts `/var/run/docker.sock` and spawns ephemeral `node:24-alpine`-style containers per work request. The base image comes from the connection's `executorImage`, falling back to the `workspaceImage` Tier-2 default at `/admin/workflow`; an explicit `image` on a node still wins (see [`architecture.md` §8](./architecture.md#8-observability--cost) for the container's hardening posture). **Anyone with code execution inside the worker container has root on its host.** Keep the worker host isolated.

> **Local-dev shortcut.** `yarn docker:infra:up` brings up Garage (the `garage` container in `docker-compose.infra.yml`) and provisions the access key and the `auto-swe-artifacts` bucket on first boot — there is no separate bucket-create step. Uncomment the `ARTIFACT_S3_*` block in `.env.example` (defaults match the container) to flip the worker onto S3 mode locally. Garage ships no web console; use `aws s3 ls --endpoint-url http://localhost:9000` or read `./data/garage` directly.

---

## 1. Pre-flight checklist

Before touching infrastructure, gather these:

- **Domain + TLS.** Reverse-proxy in front of the gateway (`https://api.example.com`) and the web app (`https://app.example.com`). Both must serve HTTPS; better-auth refuses to issue secure cookies otherwise.
- **GitHub PAT** with `repo` scope, or a GitHub App (short-lived installation tokens; see [`github-app-setup.md`](./github-app-setup.md)).
- **GitHub webhook secret** — any strong random string; you'll add it to GitHub repo webhooks pointing at `https://api.example.com/api/v1/webhooks/git`.
- **LLM provider key(s)** — configured via the admin UI (`/admin/model-config`) after first boot. There is no env-var fallback for LLM credentials: model + credential config is fully DB-driven (see [`model-configuration.md`](./model-configuration.md)).
- **Email transport** — pick one of SMTP (`SMTP_HOST/PORT/USER/PASS` + `AUTH_FROM_EMAIL`) or Resend (`RESEND_API_KEY` + `AUTH_FROM_EMAIL`). Required if you want magic-link and password-reset emails actually delivered — without one the gateway only logs the link to stdout.
- **OAuth credentials** (optional but recommended) — register a GitHub OAuth app and/or a Google OAuth client, callback `{BETTER_AUTH_URL}/api/auth/callback/{github,google}`. Credentials are configured via `/admin/integrations` after first boot (GitHub tab for GitHub, OAuth tab for Google). See [`oauth-setup.md`](./oauth-setup.md).
- **Slack credentials** (optional) — configured via `/admin/integrations` (Slack tab) after first boot.
- **S3-compatible artifact store** (optional but recommended in prod) — configured via `/admin/integrations` (Storage tab) after first boot. Without it, large step outputs are stored inline in Postgres.

Generate strong secrets:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET (must be ≥32 chars)
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 24   # SEED_ADMIN_PASSWORD (or use the IdP)
```

---

## 2. Required environment variables

The full annotated template is [`.env.example`](../.env.example). The minimum-viable production set:

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
# admin UI (/admin/model-config) after first boot and stored encrypted in the
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

# Web app — runtime URL the browser bundle calls (baked at build time)
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_APP_VERSION=<git sha / release>

# Browser-facing gateway
CORS_ORIGIN=https://app.example.com,https://admin.example.com  # first entry = better-auth client origin
PUBLIC_URL=https://api.example.com                              # used for Slack OAuth callback

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

# OAuth providers, Slack, and artifact storage are configured via the admin UI
# (/admin/integrations) after first boot. The env vars below are accepted as
# bootstrap fallbacks but are NOT required if you use the UI.
#
# OAuth (env fallback — prefer /admin/integrations → OAuth tab)
# GITHUB_CLIENT_ID=...
# GITHUB_CLIENT_SECRET=...
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
#
# Slack (env fallback — prefer /admin/integrations → Slack tab)
# SLACK_CLIENT_ID=...
# SLACK_CLIENT_SECRET=...
# SLACK_SIGNING_SECRET=...
# SLACK_BOT_TOKEN=xoxb-...
#
# Artifact store (env fallback — prefer /admin/integrations → Storage tab)
# ARTIFACT_S3_ACCESS_KEY=...        # compose maps this to AWS_ACCESS_KEY_ID
# ARTIFACT_S3_SECRET_KEY=...        # compose maps this to AWS_SECRET_ACCESS_KEY
# ARTIFACT_S3_BUCKET=auto-swe-artifacts
# ARTIFACT_S3_REGION=us-east-1
# ARTIFACT_S3_PREFIX=workflow-artifacts
# ARTIFACT_S3_ENDPOINT=https://...   # only if not AWS S3 — Garage, R2, B2, …
# ARTIFACT_S3_FORCE_PATH_STYLE=true  # true for Garage and B2; false for AWS S3 and R2

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

# Worker (optional tuning)
WEB_URL=https://app.example.com      # base URL for the "Open inbox" link in Slack HITL
                                     # notifications (defaults to http://localhost:3000 —
                                     # set it or Slack links point at localhost)
# WORKER_MAX_CONCURRENT_ACTIVITIES=10  # cap on concurrent activity executions per worker
                                       # (each typically holds a Docker workspace)
```

> **Magic-link transport gotcha.** `nodemailer.sendMail()` resolves on SMTP `2xx` (relay accepted) — *not* delivery. Always test end-to-end against a real inbox after configuring SMTP/Resend, and check the audit log for `accepted` vs `rejected` arrays.

---

## 2b. Admin UI configuration (post-boot)

Several categories of credentials that were previously env-only are now stored encrypted in the DB and managed via the admin UI. The env vars remain accepted as fallbacks, so existing deployments don't need an immediate flag day — but new deployments should configure via the UI and omit the env vars entirely.

| Admin page | What it configures | Restart required? |
|---|---|---|
| `/admin/model-config` | LLM provider credentials and per-role model selection | No — resolved fresh per activity call |
| `/admin/integrations → GitHub` | GitHub PAT, webhook secret, GitHub Enterprise URLs | No for token/webhook; **Yes** for OAuth app creds |
| `/admin/integrations → Slack` | Slack client ID/secret, signing secret, bot token | **Yes** for client ID/secret; No for bot token/signing secret |
| `/admin/integrations → Storage` | S3-compatible bucket, region, endpoint, credentials | No — resolved fresh per artifact write |
| `/admin/integrations → OAuth` | Google OAuth client ID/secret | **Yes** — BetterAuth reads these at startup |
| `/admin/workflow` | Branch prefix, PR title/body templates, default team slug | No — resolved fresh per workflow activity |

**Bootstrap order** (first deployment):
1. Start gateway + web only (`yarn dev:gateway && yarn dev:web`).
2. Sign in as admin.
3. `/admin/model-config` → Credentials → add a provider credential (the seed already created the agents + embedding config).
4. `/admin/integrations` → GitHub tab → enter your PAT and webhook secret → Save.
5. `/admin/integrations` → any other tabs you need (Slack, Storage, OAuth).
6. Start the worker (`yarn dev:worker`). The worker now reads all config from the DB.
7. Optionally clear the `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` env vars — the DB config is now the source of truth.

> **"Restart required" changes.** Changes to OAuth credentials (GitHub/Google social sign-in) and Slack OAuth credentials take effect only after restarting the gateway. The UI shows a yellow banner reminding you. All other config changes (GitHub token, webhook secret, Slack bot token/signing secret, storage, workflow defaults) take effect on the next activity call — no restart needed.

---

## 3. Database setup

The shipped schema lives in `packages/shared/src/prisma/migrations/` — a consolidated baseline plus
hand-written DDL migrations, split by what Prisma's DSL can express:

| Migration | What it adds |
| --------- | ------------ |
| `00000000000000_init` | The consolidated baseline, generated from `schema.prisma` via `prisma migrate diff --from-empty --to-schema --script` — the `vector` extension, every enum, table, column, FK and Prisma-expressible index |
| `00000000000001_custom_constraints_and_indexes` | Everything the DSL can't express: the HNSW vector index on `memory_items.embedding`, the partial unique indexes for the scope cascade (agents, credentials, [config settings and grants](./configuration.md)) and HITL idempotency, singleton/scope CHECK constraints, array-column `NOT NULL`s, and the embedding-config seed |
| `00000000000002_repo_dependencies` | The repo dependency graph: the `repo_dependencies` edge table, `connections.package_names`, and their partial unique indexes (resolved edges vs. unresolved suggestions) + CHECK constraints (no-self-edge, target shape, status/source enums) |

Until the schema is deployed somewhere, a change goes into the baseline by regenerating it with the
command above rather than by appending a third migration — the split is by *kind* of DDL, not by
when it was written. Once deployed, new changes append normal Prisma migrations after these;
`prisma migrate deploy` applies whatever is pending.

```bash
# 1. Create the database with the pgvector extension
psql -h db-host -U postgres -c 'CREATE DATABASE engineering_system;'
psql -h db-host -U postgres -d engineering_system -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# 2. Apply migrations (run from a host that has the repo + DATABASE_URL set)
yarn workspace @auto-swe/shared exec prisma migrate deploy

# 3. Seed the admin user, default team, default workflow template
yarn db:seed
#    ↳ also runs provisionAuthAdmin to set up the better-auth credential account
#      so the seeded admin can sign in via the password tab on /login.
```

**Inside Docker.** If you build the gateway image and run migrations from there, the runtime image needs the full `prisma` CLI plus the `.bin/prisma` symlink intact — declare `prisma` in the package's `dependencies` (not `devDependencies`) so `yarn workspaces focus --production` resolves the CLI's own transitive deps. The simplest pattern is a one-shot init container. Details in the [`prisma-docker-migrations`](../.claude/skills/prisma-docker-migrations/SKILL.md) skill.

For routine application thereafter, `prisma migrate deploy` is idempotent. **Never use `prisma migrate dev` in production** — it will silently try to drop the HNSW index every time unrelated schema changes are made. See the [`prisma-pgvector-hnsw`](../.claude/skills/prisma-pgvector-hnsw/SKILL.md) skill.

---

## 4. Temporal setup

You have two reasonable paths:

### a. Self-hosted Temporal (Docker Compose / Kubernetes)

The shipped `docker-compose.infra.yml` provisions:
- `postgres-temporal` (a *separate* Postgres from the app DB — needed because Temporal owns the schema)
- `temporal-setup` (one-shot container that installs the Temporal schema)
- `temporal` (the server)
- `temporal-admin-tools` and `temporal-ui` (port `8233`)

For real production, run these on dedicated infrastructure (not on the gateway/worker hosts). At minimum:
- Multiple Temporal server replicas behind an internal load balancer.
- Daily backups of `postgres-temporal`.
- Mutual TLS for the worker → Temporal gRPC connection.

### b. Temporal Cloud

Point `TEMPORAL_ADDRESS` at your Temporal Cloud endpoint and supply the namespace + mTLS certs via the SDK. This removes the Postgres/server burden entirely. The auto-swe codebase doesn't yet wire up the mTLS path — that's a small change in `packages/gateway/src/plugins/temporal.ts` and `packages/worker/src/index.ts` when you need it.

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
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_APP_VERSION=$SHA \
  -f packages/web/Dockerfile -t registry.example.com/auto-swe/web:$SHA .
docker push registry.example.com/auto-swe/gateway:$SHA
docker push registry.example.com/auto-swe/worker:$SHA
docker push registry.example.com/auto-swe/web:$SHA
```

> **Why the web image takes build args.** `NEXT_PUBLIC_*` vars are inlined into the JS bundle at build time. Changing them later requires a rebuild, not just a restart.

---

## 5b. Deploying with the prod compose stack

If you'd rather run prebuilt images than build your own, the repo ships three compose overlays that deploy the GHCR images published by `.github/workflows/docker.yml`:

| File | What it adds |
| ---- | ------------ |
| `docker-compose.prod.yml` | `gateway` / `worker` / `web` from registry images (`pull_policy: always`, `restart: unless-stopped`, `env_file: .env`). Overlays the infra file — it reuses `postgres`, `temporal`, and (when the `objectstore` profile is active) `garage` from `docker-compose.infra.yml`. |
| `docker-compose.traefik.yml` | Fronts gateway + web with Traefik TLS. Strips the published host ports (`ports: !reset []`), attaches both to an external `traefik` network, and adds `websecure` routers with `certResolver=webcert` for `DOMAIN_API` (gateway) and `DOMAIN_APP` (web). Requires a Traefik instance you run separately, with the `traefik` Docker network already created. |
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
- **Image publishing is CI-gated.** The publish job in `docker.yml` only runs after lint, typecheck, and tests pass, so `:main` only moves on green builds. If you run Watchtower against `:main`, that gate is your only protection — a passing-but-bad commit still auto-deploys. Pinned immutable tags + manual bumps are the conservative choice.
- **Required secrets.** The gateway and worker images run with `NODE_ENV=production` and refuse the in-source dev fallbacks, so `.env` must contain real values for `JWT_SECRET`, `BETTER_AUTH_SECRET` (≥32 chars), and `CONFIG_ENCRYPTION_KEY`. `docker-compose.prod.yml` enforces the first two with `:?` interpolation errors at `up` time; a missing `CONFIG_ENCRYPTION_KEY` fails at process start instead.
- **Managed DB.** Set `DATABASE_URL_OVERRIDE` to point gateway + worker at a managed Postgres instead of the compose `postgres` service.
- **Worker DinD.** Same as everywhere else: the worker mounts `/var/run/docker.sock`; set `DOCKER_GID` to the host's docker group ID.
- **Object store selection.** `COMPOSE_PROFILES` in `.env` decides whether the bundled Garage service runs. `objectstore` (the `.env.example` default) starts it; an empty value starts nothing, and the worker's `depends_on` is `required: false` so it comes up regardless. See §5c.

---

## 5c. Choosing an object store

The artifact store is S3-compatible, and the worker only ever issues `PutObject` and `GetObject` against it. Anything speaking those two verbs works — the choice is operational, not one of compatibility.

**Bundled Garage (default).** A single-node [Garage](https://garagehq.deuxfleurs.fr/) container, configured by `infra/garage/garage.toml` and started with `--single-node --default-bucket`. It provisions the cluster layout, the access key and the bucket on first boot from `ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` / `ARTIFACT_S3_BUCKET`, and re-running is a no-op, so there is nothing to bootstrap separately. It idles around 5 MB of RAM. Its state is `./data/garage`, which needs backing up alongside the two Postgres volumes (§9).

Two constraints worth knowing before you set credentials:

- **Garage rejects secret keys shorter than 16 characters.** `ARTIFACT_S3_SECRET_KEY` must clear that bar or the container exits on first boot with `Invalid default access key`.
- **`GARAGE_RPC_SECRET` must be set.** Single-node deployments never put it on the wire, but Garage requires it and the committed config deliberately does not carry one. Generate with `openssl rand -hex 32`.

**Hosted S3 instead.** Set `COMPOSE_PROFILES=` (empty) in `.env` and point the artifact variables at the provider. No compose file changes:

| Provider | `ARTIFACT_S3_ENDPOINT` | `ARTIFACT_S3_REGION` | `ARTIFACT_S3_FORCE_PATH_STYLE` |
|---|---|---|---|
| AWS S3 | *(omit)* | your region | `false` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | `false` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | your region | `true` |

`ARTIFACT_S3_ACCESS_KEY` / `ARTIFACT_S3_SECRET_KEY` become the provider's credentials — compose passes them into the container as the standard `AWS_*` names the SDK reads, but keeps them under a distinct name outside so an ambient `AWS_ACCESS_KEY_ID` in the deploying shell cannot silently win over `.env`. **The bucket must already exist** — only the bundled store self-provisions one. These same settings can be managed at `/admin/integrations → Storage` instead, which takes precedence over the environment.

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
| `db-1`                    | `postgres` (pgvector)                       | Managed Postgres (RDS / Cloud SQL) is fine. Enable `vector` ext.   |
| `temporal-1..N`           | `postgres-temporal`, `temporal`, `temporal-ui` | Or Temporal Cloud — skip the host entirely.                       |
| `gateway-1..N`            | `gateway`                                   | Behind your HTTPS reverse proxy. Stateless; scale horizontally.    |
| `worker-1..N`             | `worker` + Docker daemon                    | **Isolated.** Worker mounts `/var/run/docker.sock`.                |
| `web-1..N`                | `web`                                       | Behind HTTPS reverse proxy. Stateless; scale horizontally.         |
| `obs-1` (optional)        | `otel-lgtm` or your collector + Grafana    | OTLP/HTTP on `:4318`.                                              |

Reverse proxy routing:

```
https://app.example.com   →  web-*:3000
https://api.example.com   →  gateway-*:8080
https://temporal.example.com (optional, internal only)  →  temporal-1:8233
```

For Kubernetes, the same images work — there's no shipped Helm chart yet. The worker is the only stateful pod (Docker socket); run it as a single-replica StatefulSet on a dedicated node pool with the socket mounted via `hostPath`. Everything else is a stock Deployment.

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
#  3. Dashboard "+ Submit work request"      → smallest possible task; verify the run starts
#  4. Watch the run in /workflows/<id> and the Temporal UI

# Then verify webhooks both directions
#  - GitHub merge of the test PR fires POST /api/v1/webhooks/git → workflow completes
#  - If the repo has CI, POST /api/v1/webhooks/ci → ciFixLoop kicks in on failures
```

---

## 8. Day-2 operations

| Concern                    | Where to look                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Workflow visibility        | Temporal UI (`:8233`), or `/workflows`, `/runs`, `/workflows/:id` in the dashboard.                              |
| Cost tracking              | `WorkflowRun.costUsdAccrued`, `/analytics` page, OTel span attribute `llm.cost_usd`. Unknown models log `llm.cost_pricing_known=false`. |
| Per-team A/B experiments   | `/templates/:id` → set `experimentVersion` + `experimentSplit`.                                                  |
| Rotating LLM models        | Change model spec at `/admin/model-config` (takes effect on next activity call). For pricing of new models use `MODEL_PRICE_<PROVIDER>_<MODEL>` env overrides. |
| Rotating GitHub PAT        | `/admin/integrations → GitHub` → enter new token → Save. No restart required. |
| Rotating Slack bot token   | `/admin/integrations → Slack` → enter new bot token → Save. No restart required. |
| Rotating S3 credentials    | `/admin/integrations → Storage` → enter new key → Save. No restart required. |
| Rotating OAuth app creds   | `/admin/integrations → GitHub or OAuth` → enter new secret → Save → restart gateway. |
| Rotating secrets           | `BETTER_AUTH_SECRET` / `JWT_SECRET` invalidate all existing sessions/tokens. Communicate before rotating.        |
| Sessions admin             | `/admin/sessions` (revoke any session); `/admin/access-tokens` (revoke PATs across all users).                   |
| Shell-step audit           | `/admin/access-tokens` page exposes the prune control for `workflow_shell_audit` rows older than N days.         |
| Lesson retention           | `memory_items` grows over time; no automatic pruning. Manual `DELETE` is fine — drops the row from the HNSW index. |
| pgvector index rebuild     | `REINDEX INDEX idx_memory_items_embedding;` — only needed after a bulk import or if recall degrades.            |

---

## 9. Backup + DR

Two stateful datastores; both need backups:

1. **`postgres` (app DB)** — `pg_dump`. Recovery is straightforward. Restoring loses no functionality; the worker just resumes whatever Temporal still has in flight.
2. **`postgres-temporal` (workflow history)** — `pg_dump`. Loss of this DB means in-flight workflows are gone forever (signals, history, timers). For long-running humanMergeSignal waits (up to 7 days), this is real data loss. Treat this DB at least as carefully as the app DB.

Container workspaces are ephemeral — never back them up. The Docker daemon on the worker host can be restored from scratch.

---

## 10. Hardening checklist

- [ ] `BETTER_AUTH_URL` and `CORS_ORIGIN` point at your real HTTPS domain (gateway refuses to issue secure cookies otherwise).
- [ ] `BETTER_AUTH_SECRET` is ≥32 chars and matches across all gateway replicas.
- [ ] `JWT_SECRET` (or RSA key pair) is set, and is *not* the `.env.example` placeholder.
- [ ] `SEED_ADMIN_PASSWORD` is rotated or the seed admin is deleted after first sign-in.
- [ ] OAuth consent screens are published (Google) and homepage URLs filled (GitHub) for prod-grade UX.
- [ ] Magic-link transport is verified end-to-end against a real inbox (not just SMTP 2xx).
- [ ] Worker host is isolated — separate VPC subnet, no shared Docker socket, no inbound traffic.
- [ ] Infra ports are not world-reachable. `docker-compose.infra.yml` publishes Postgres (5432), Temporal (7233/8233) and the object store (9000) on all interfaces so the runbook can reach them from the host. None is meant to be reachable from off-host: bind them to loopback (`POSTGRES_PORT=127.0.0.1:5432`, `GARAGE_API_PORT=127.0.0.1:9000`, `TEMPORAL_GRPC_PORT=127.0.0.1:7233`, `TEMPORAL_UI_PORT=127.0.0.1:8233`) or firewall them.
- [ ] Reverse proxy enforces HTTPS and forwards `X-Forwarded-For` / `X-Forwarded-Proto`.
- [ ] Postgres connection uses TLS (`?sslmode=require`).
- [ ] S3 artifact store has lifecycle policy for old workflow artifacts (the DB stores references; the worker never deletes the objects itself).
- [ ] Temporal namespace retention is set deliberately (default in self-hosted = 30d; tune for your humanMergeSignal wait).
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the collector is reachable — otherwise traces silently drop.
- [ ] GitHub PAT and webhook secret are set via `/admin/integrations` (or env var fallback). Secrets are random per-environment.
- [ ] `CONFIG_ENCRYPTION_KEY` (base64 32-byte random) is set and backed up — it encrypts all DB-stored secrets (GitHub token, Slack tokens, S3 key, OAuth secrets). Loss = all stored credentials are unreadable.

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
