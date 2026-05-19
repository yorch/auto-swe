# Production Deployment

End-to-end runbook for taking auto-swe from a fresh clone to a running production deployment. For local development, use the quickstart in [`README.md`](../README.md). For OAuth provider configuration, see [`oauth-setup.md`](./oauth-setup.md).

---

## 0. What you're deploying

Five long-running processes plus one Docker daemon:

| Service                    | Image                                              | Purpose                                                                |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `postgres`                 | `pgvector/pgvector:pg17`                           | App DB — relational state + pgvector for semantic memory.              |
| `postgres-temporal`        | `postgres:17-alpine`                               | Separate DB for Temporal history. Do **not** combine with the app DB.  |
| `temporal` (server+admin+ui) | `temporalio/server:1.31.0` + admin-tools 1.31 + ui 2.49.1 | Workflow orchestration runtime + setup container + web UI on `:8233`.  |
| `gateway`                  | built from `packages/gateway/Dockerfile`           | Fastify HTTP API on `:8080`. Stateless, scale horizontally.            |
| `worker`                   | built from `packages/worker/Dockerfile`            | Temporal worker. Spawns ephemeral Docker workspaces via the host socket. |
| `web`                      | built from `packages/web/Dockerfile`               | Next.js dashboard on `:3000`. Stateless, scale horizontally.           |
| `otel-lgtm` (optional)     | `grafana/otel-lgtm:0.8.1`                          | Grafana + Loki + Tempo + Mimir bundle for traces, logs, metrics.       |

The worker mounts `/var/run/docker.sock` and spawns ephemeral `node:24-alpine`-style containers per work request (see [`data-and-infra.md` §3.2](./data-and-infra.md#32-executor-image-selection)). **Anyone with code execution inside the worker container has root on its host.** Keep the worker host isolated.

---

## 1. Pre-flight checklist

Before touching infrastructure, gather these:

- **Domain + TLS.** Reverse-proxy in front of the gateway (`https://api.example.com`) and the web app (`https://app.example.com`). Both must serve HTTPS; better-auth refuses to issue secure cookies otherwise.
- **GitHub PAT** with `repo` scope, or a GitHub App (future work — single PAT today).
- **GitHub webhook secret** — any strong random string; you'll add it to GitHub repo webhooks pointing at `https://api.example.com/api/v1/webhooks/git`.
- **LLM provider key(s)** — `ANTHROPIC_API_KEY` is required for the default models. `OPENAI_API_KEY` is required if you keep the default embeddings (`text-embedding-3-large`, 1536d).
- **Email transport** — pick one of SMTP (`SMTP_HOST/PORT/USER/PASS` + `AUTH_FROM_EMAIL`) or Resend (`RESEND_API_KEY` + `AUTH_FROM_EMAIL`). Required if you want magic-link and password-reset emails actually delivered — without one the gateway only logs the link to stdout.
- **OAuth credentials** (optional but recommended) — register a GitHub OAuth app and/or a Google OAuth client, callback `{BETTER_AUTH_URL}/api/auth/callback/{github,google}`. See [`oauth-setup.md`](./oauth-setup.md).
- **Slack credentials** (optional) — `SLACK_CLIENT_ID/_SECRET/_SIGNING_SECRET` for the `/auto-swe` slash command and OAuth-connect flow, plus `SLACK_BOT_TOKEN` for run notifications.
- **S3-compatible artifact store** (optional but recommended in prod) — `ARTIFACT_S3_BUCKET/REGION/ENDPOINT/PREFIX`. Without it, large step outputs (diffs, logs) are stored inline in Postgres which bloats the DB.

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

# LLM
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...               # only if EMBEDDING_MODEL stays default

# Source control
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=<random>

# Browser auth (better-auth) — MUST set both in prod or the gateway refuses to start
BETTER_AUTH_URL=https://api.example.com
BETTER_AUTH_SECRET=<openssl rand -base64 32>

# Legacy JWT (still used by the email+password path and CLI/API bearers)
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

# OAuth providers (optional — buttons hide when absent)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Slack (optional)
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...

# Artifact store (recommended in prod)
ARTIFACT_S3_BUCKET=auto-swe-artifacts
ARTIFACT_S3_REGION=us-east-1
ARTIFACT_S3_PREFIX=workflow-artifacts
# ARTIFACT_S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com   # only if non-AWS

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

> **Magic-link transport gotcha.** `nodemailer.sendMail()` resolves on SMTP `2xx` (relay accepted) — *not* delivery. Always test end-to-end against a real inbox after configuring SMTP/Resend, and check the audit log for `accepted` vs `rejected` arrays.

---

## 3. Database setup

The shipped schema lives in `packages/shared/src/prisma/migrations/`. As of 2026-05-18 it's two migrations: a single canonical `init` plus the pgvector HNSW index migration (the latter is separate because Prisma 7's schema DSL can't model HNSW).

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

**Inside Docker.** If you build the gateway image and run migrations from there, see the [`prisma-7-docker-migrations`](https://github.com/) skill — the short version is the runtime image needs the full `prisma` CLI plus the `.bin/prisma` symlink intact. The simplest pattern is a one-shot init container.

For routine application thereafter, `prisma migrate deploy` is idempotent. **Never use `prisma migrate dev` in production** — it will silently try to drop the HNSW index every time unrelated schema changes are made (see the project skill `prisma-7-pgvector-hnsw-migrate-dev-drift`).

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
yarn docker:build       # builds gateway + worker + web
# or:
docker compose -f docker-compose.infra.yml -f docker-compose.yml build gateway worker web
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
#  2. Repositories → "+ Add repository"      → connect a real repo (use a test one first)
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
| Rotating LLM models        | Override `*_MODEL` env vars. The price table is in `packages/worker/src/lib/costTracking.ts` — extend it (or use `MODEL_PRICE_<PROVIDER>_<MODEL>` env overrides) for new IDs. |
| Rotating secrets           | `BETTER_AUTH_SECRET` / `JWT_SECRET` invalidate all existing sessions/tokens. Communicate before rotating.        |
| Sessions admin             | `/admin/sessions` (revoke any session); `/admin/access-tokens` (revoke PATs across all users).                   |
| Shell-step audit           | `/admin/access-tokens` page exposes the prune control for `workflow_shell_audit` rows older than N days.         |
| Lesson retention           | `agent_lessons` grows over time; no automatic pruning. Manual `DELETE` is fine — drops the row from the HNSW index. |
| pgvector index rebuild     | `REINDEX INDEX idx_agent_lessons_embedding;` — only needed after a bulk import or if recall degrades.            |

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
- [ ] Reverse proxy enforces HTTPS and forwards `X-Forwarded-For` / `X-Forwarded-Proto`.
- [ ] Postgres connection uses TLS (`?sslmode=require`).
- [ ] S3 artifact store has lifecycle policy for old workflow artifacts (the DB stores references; the worker never deletes the objects itself).
- [ ] Temporal namespace retention is set deliberately (default in self-hosted = 30d; tune for your humanMergeSignal wait).
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the collector is reachable — otherwise traces silently drop.
- [ ] Webhook secrets (`GITHUB_WEBHOOK_SECRET`) are random per-environment.

---

## 11. Where this guide ends

This doc covers infrastructure setup and the first happy-path workflow. For ongoing development:
- New features → [`AGENTS.md`](../AGENTS.md) and [`STATUS.md`](../STATUS.md).
- Workflow engine internals → [`configurable-workflows.md`](./configurable-workflows.md).
- Auth deep-dive → [`gateway-and-auth.md`](./gateway-and-auth.md) + [`oauth-setup.md`](./oauth-setup.md).
- Data layer / DinD details → [`data-and-infra.md`](./data-and-infra.md).
