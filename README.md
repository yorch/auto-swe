# auto-swe

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An autonomous agentic software engineering system. Submit a ticket ID — get a reviewed, tested pull request.

## How it works

1. **Submit a work request** — POST a ticket ID (Jira, Linear, GitHub Issues, etc.) and description to the API
2. **Agent implements** — An LLM agent clones the target repo into an ephemeral Docker sandbox, writes code and tests, and iterates until tests go green (TDD loop, max 5 iterations)
3. **Review network runs** — Three parallel review agents (Security Auditor, Domain Logic, Performance) inspect the diff and can request fixes
4. **PR opens** — A pull request is created on GitHub with the implementation
5. **CI self-heals** — If pipeline checks fail, the agent wakes up, reads the logs, and pushes a fix
6. **Human merges** — The workflow waits (up to 7 days) for a human to merge the PR, then commits learnings to semantic memory (pgvector) for future runs

All execution is durable via Temporal.io — workflows survive crashes, restarts, and API rate limits.

## Architecture

```text
CLI / API
   │  POST /api/v1/work-requests
   ▼
Fastify Gateway ──────────────────▶ Temporal Server
   │                                      │
   │  PostgreSQL 17 + pgvector            │ Task Queue
   │  (state, memory, tokens)             ▼
   │                               Temporal Worker
   │                                 │
   │                                 │  RunnableWorkflow  (generic interpreter over a JSON WorkflowSpec)
   │                                 │    walks step / set / cond / signal / terminate / fanOut nodes
   │                                 │    └── dispatches to activities below
   │                                 │
   │                                 ├── validateContext              (Context Validator agent)
   │                                 ├── planDecomposition            (split work request into Subtask[])
   │                                 ├── executeImplementation        (Implementer agent + DinD TDD loop;
   │                                 │                                 takes optional Subtask for per-branch fan-out)
   │                                 ├── runLint / Typecheck / Tests / Build / VulnScan / PerfBench  (quality gates)
   │                                 ├── executeGateFixImplementation (fix-loop for failed gates)
   │                                 ├── runReviewNetwork             (Security / Domain / Performance agents)
   │                                 ├── executeReviewFixImplementation
   │                                 ├── mergeBranches                (fast-forward subtask branches into the feature branch)
   │                                 ├── createOrUpdatePullRequest    (GitHub API)
   │                                 ├── fetchCILogs + executeCIFixImplementation  (self-healing on CI failures)
   │                                 ├── ⏳ await humanMergeSignal
   │                                 └── commitToMemory               (pgvector lesson embedding)
   │
   └── POST /api/v1/webhooks/git    (GitHub merge webhook → humanMergeSignal)
       POST /api/v1/webhooks/ci     (CI check_run webhook → ciPipelineSignal)
```

For multi-repo epics, `EpicOrchestratorWorkflow` decomposes the request into per-repo child `RunnableWorkflow`s using the Planner agent and runs them with dependency-graph scheduling. Each child runs the team's configured workflow spec (default: `default-engineering@v1`, parity with the original hardcoded loop). See [`docs/configurable-workflows.md`](./docs/configurable-workflows.md) for the spec schema, step catalog, and roadmap.

## Tech stack

| Layer               | Technology                                                 |
| ------------------- | ---------------------------------------------------------- |
| HTTP API            | Fastify 5.8 + Zod 4 validation                             |
| Orchestration       | Temporal 1.31 (server + admin-tools + ui) + @temporalio/* SDK 1.17 |
| Agents              | Mastra 1.32 + Vercel AI SDK 6 (default `claude-opus-4-7`)  |
| Database            | PostgreSQL 17 + pgvector (Prisma 7.8)                      |
| Embeddings          | OpenAI `text-embedding-3-large` (1536d)                    |
| Workspace isolation | Docker-in-Docker                                           |
| Observability       | OpenTelemetry → Grafana LGTM (`grafana/otel-lgtm:0.8.1`)   |
| Web dashboard       | Next.js 16 + React 19 + Tailwind CSS 4 + TanStack Query 5  |
| Language            | TypeScript 6 (strict mode, Yarn 4.14 monorepo)             |
| Tests / Lint+Format | Vitest 4 / Biome 2.4                                       |

## Prerequisites

- Node.js ≥ 24.0.0
- Yarn 4 via corepack (`corepack enable`)
- Docker + Docker Compose

## Local development

```bash
# 1. Install dependencies
corepack enable && yarn install

# 2. Configure environment
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, OPENAI_API_KEY

# 3. Start infrastructure (Postgres, Temporal)
yarn docker:infra:up

# 4. Set up the database
yarn db:migrate && yarn db:generate && yarn db:seed

# 5. Start services (two terminals)
yarn dev:gateway     # Terminal 1 → http://localhost:8080
yarn dev:worker      # Terminal 2

# 6. Web dashboard (optional)
cd packages/web && yarn dev   # → http://localhost:3000
```

Temporal Web UI is available at <http://localhost:8233>.

## Usage

### Submit a work request

Three equivalent entry points — pick the one that fits the workflow:

1. **Web dashboard** (recommended) — open <http://localhost:3000>, sign in, click **+ Submit work request** in the header (or in the onboarding panel if you have no runs yet). The repo dropdown, brief, and budget tier are all there; on submit it routes you to the new run.
2. **CLI** (`auto-swe`) — export `AUTO_SWE_TOKEN` (mint one at Settings → API tokens) and run the CLI's `workflows` subcommands. See `packages/cli/README.md`.
3. **Raw HTTP** — useful for scripting / CI. Either a JWT (legacy `/auth/login`) or a PAT created in the UI works as the bearer:

   ```bash
   TOKEN=<your-PAT-from-Settings → API tokens>   # or mint a JWT via /auth/login

   curl -X POST http://localhost:8080/api/v1/work-requests \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
       "externalTicketId": "JIRA-42",
       "description": "Add a GET /health endpoint that returns { status: ok }",
       "repoIds": ["<repo-uuid>"],
       "budgetTier": "STANDARD"
     }'
   ```

`budgetTier` controls the LLM token budget: `STANDARD` (2M/500K tokens), `LARGE` (8M/2M), `EPIC` (20M/5M). The workflow is terminated with `BUDGET_EXCEEDED` if the limit is breached.

For multi-repo changes, use **Epics** (`/epics` in the dashboard, or `POST /api/v1/epics`) — the Planner agent decomposes the brief into per-repo child workflows.

### Monitor

```bash
# Dashboard — KPIs, recent activity, "needs attention" queue
open http://localhost:3000

# Full run history with filters
open http://localhost:3000/runs

# Temporal Web UI — real-time workflow state, history, signals
open http://localhost:8233
```

Or via the API:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/workflows
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:8080/api/v1/workflow-runs?status=RUNNING'
```

## Environment variables

| Variable                | Required  | Description                                                                                  |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Yes       | PostgreSQL connection string                                                                   |
| `TEMPORAL_ADDRESS`          | Yes       | Temporal server address (default: `localhost:7233`)                                            |
| `ANTHROPIC_API_KEY`         | Yes       | Claude API key (Implementer, Review, Planner, Memory agents)                                   |
| `GITHUB_TOKEN`              | Yes       | GitHub PAT with `repo` scope                                                                   |
| `GITHUB_WEBHOOK_SECRET`     | Yes       | Secret for verifying GitHub webhook signatures                                                 |
| `OPENAI_API_KEY`            | Yes       | OpenAI key for `text-embedding-3-large` embeddings                                             |
| `JWT_SECRET`                | Yes¹      | Secret for HS256 JWTs (used when `JWT_PRIVATE_KEY_PATH` is unset — default for Docker Compose) |
| `JWT_PRIVATE_KEY_PATH`      | Optional¹ | Path to RSA private key. Setting this switches JWT signing to RS256                            |
| `JWT_PUBLIC_KEY_PATH`       | Optional¹ | Path to RSA public key. Required when using RS256                                              |
| `BETTER_AUTH_URL`           | Prod²     | Gateway base URL used as the OAuth callback origin                                             |
| `BETTER_AUTH_SECRET`        | Prod²     | ≥32-char secret for signing better-auth session cookies                                        |
| `SEED_ADMIN_PASSWORD`       | Seed only | Password for the seeded admin user (required in production)                                    |
| `SEED_ADMIN_EMAIL`          | Optional  | Override for the seeded admin email (default: `admin@auto-swe.local`)                          |
| `PORT`                      | Optional  | Gateway HTTP port (default: `8080`)                                                            |
| `CORS_ORIGIN`               | Optional  | Comma-separated browser origins; first entry is the better-auth client origin                  |
| `PUBLIC_URL`                | Optional  | Public base URL of the gateway used for the Slack OAuth callback                               |
| `DEFAULT_TEAM_SLUG`         | Optional  | Slug new better-auth sign-ups join automatically (default: `default`)                          |
| `NEXT_PUBLIC_API_URL`       | Web       | Gateway URL the web bundle calls (default: `http://localhost:8080`)                            |
| `NEXT_PUBLIC_APP_VERSION`   | Web       | Version label shown in the login page footer                                                   |
| `RESEND_API_KEY`            | Optional³ | Resend HTTP API key for magic-link email delivery                                              |
| `SMTP_HOST` / `SMTP_PORT`   | Optional³ | SMTP transport for magic-link email (alternative to Resend)                                    |
| `SMTP_USER` / `SMTP_PASS`   | Optional³ | SMTP auth credentials (omit for unauthenticated relays)                                        |
| `AUTH_FROM_EMAIL`           | Optional³ | `From` address for magic-link / verification emails                                            |
| `GITHUB_CLIENT_ID`          | Optional⁴ | GitHub OAuth client id (enables "Continue with GitHub")                                        |
| `GITHUB_CLIENT_SECRET`      | Optional⁴ | GitHub OAuth client secret                                                                     |
| `GOOGLE_CLIENT_ID`          | Optional⁴ | Google OAuth client id (enables "Continue with Google")                                        |
| `GOOGLE_CLIENT_SECRET`      | Optional⁴ | Google OAuth client secret                                                                     |
| `SLACK_CLIENT_ID`           | Optional  | Slack OAuth app credentials                                                                    |
| `SLACK_CLIENT_SECRET`       | Optional  | Slack OAuth app credentials                                                                    |
| `SLACK_SIGNING_SECRET`      | Optional  | For verifying Slack interactive webhook signatures                                             |
| `SLACK_BOT_TOKEN`           | Optional  | Bot token (`xoxb-…`) for posting run notifications                                             |
| `BRANCH_PREFIX`             | Optional  | Git branch prefix (default: `auto`)                                                            |
| `GITHUB_URL`                | Optional  | Override for GitHub Enterprise Server                                                          |
| `GITHUB_API_URL`            | Optional  | Override for GitHub Enterprise Server API                                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional | OTLP/HTTP endpoint for traces + logs (set when running `yarn docker:up`)                       |
| `ARTIFACT_S3_*`             | Optional  | S3-compatible artifact store; falls back to Postgres-inline when unset. `yarn docker:infra:up` ships a MinIO container at `localhost:9000` (console `:9001`) with the bucket pre-created (see `.env.example`) |

¹ JWT auth has two modes: HS256 (default — set `JWT_SECRET`) or RS256 (set `JWT_PRIVATE_KEY_PATH` + `JWT_PUBLIC_KEY_PATH`).
² Required when running the gateway in production — better-auth refuses to start with the dev defaults.
³ Magic-link email transport. Choose one: SMTP (`SMTP_*` + `AUTH_FROM_EMAIL`) or Resend (`RESEND_API_KEY` + `AUTH_FROM_EMAIL`). Without either, links print to gateway stdout (dev only).
⁴ OAuth providers — the matching login button is hidden when its env vars are unset. See [`docs/oauth-setup.md`](./docs/oauth-setup.md) for the full setup.

See [`.env.example`](./.env.example) for the full annotated template, including LLM provider selection, per-model price overrides, and embedding configuration.

## Commands

```bash
yarn build               # Build all packages
yarn test                # Run all tests (Vitest)
yarn lint                # Lint + format check (Biome)
yarn lint:fix            # Auto-fix safe lint issues + format
yarn db:migrate          # Run Prisma migrations
yarn db:generate         # Regenerate Prisma client
yarn db:seed             # Seed admin user + sample repository
yarn dev:gateway         # Gateway in watch mode
yarn dev:worker          # Worker in watch mode
yarn dev:web             # Next.js dashboard (port 3000)
yarn docker:infra:up     # Start infra services (postgres + temporal). Observability (Grafana/OTel) starts with yarn docker:up.
yarn docker:infra:down   # Stop infra services
yarn docker:up           # Start everything (infra + app)
yarn docker:down         # Stop everything
yarn docker:logs         # Tail logs (infra + app)
yarn docker:build        # Rebuild app images
```

## Project structure

```text
packages/
├── shared/     # Prisma schema, DB client, shared TypeScript types
├── gateway/    # Fastify 5.x HTTP API (auth, RBAC, routes, webhooks)
├── worker/     # Temporal worker, Mastra agents, activities
└── web/        # Next.js 16 web dashboard
```

See [AGENTS.md](./AGENTS.md) for full conventions, critical implementation notes, and design decisions.

## Key design decisions

| Decision                      | Rationale                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Docker-in-Docker (not K8s)    | No cluster required; same isolation, zero extra infra                           |
| Temporal.io for orchestration | Durable execution — workflows survive crashes and wait days for human signals   |
| Human-governed merges         | The system never auto-merges; all PRs require explicit human review             |
| Single GitHub PAT             | JIT-scoped tokens require a GitHub App (future work)                            |
| pgvector for agent memory     | Semantic similarity search surfaces relevant past lessons into agent context    |
| Mastra + Vercel AI SDK        | Mastra uses AI SDK under the hood; direct `@ai-sdk/anthropic` import is simpler |
