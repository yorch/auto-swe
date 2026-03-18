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
   │                                 ├── validateContext      (Context Validator agent)
   │                                 ├── executeImplementation (Implementer agent + DinD TDD loop)
   │                                 ├── runReviewNetwork     (Security / Domain / Performance agents)
   │                                 ├── createOrUpdatePullRequest (GitHub API)
   │                                 ├── ciFixLoop            (self-healing on CI failures)
   │                                 ├── ⏳ await humanMergeSignal
   │                                 └── commitToMemory       (pgvector lesson embedding)
   │
   └── POST /api/v1/webhooks/git    (GitHub merge webhook → humanMergeSignal)
       POST /api/v1/webhooks/ci     (CI check_run webhook → ciPipelineSignal)
```

For multi-repo epics, an `EpicOrchestratorWorkflow` decomposes the request into per-repo child `EngineeringWorkflow`s using a Planner agent and runs them with dependency-graph scheduling.

## Tech stack

| Layer               | Technology                                              |
| ------------------- | ------------------------------------------------------- |
| HTTP API            | Fastify 5.x + Zod validation                            |
| Orchestration       | Temporal.io (auto-setup 1.25.2)                         |
| Agents              | Mastra 1.6 + `@ai-sdk/anthropic` (claude-opus-4-6)      |
| Database            | PostgreSQL 17 + pgvector (Prisma 7)                     |
| Embeddings          | OpenAI `text-embedding-3-large` (1536d)                 |
| Workspace isolation | Docker-in-Docker                                        |
| Observability       | OpenTelemetry → Grafana LGTM stack                      |
| Web dashboard       | Next.js 15 + React 19 + Tailwind CSS 4 + TanStack Query |
| Language            | TypeScript 5.7 (strict mode, Yarn 4 monorepo)           |
| Tests               | Vitest                                                  |

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

# 3. Start infrastructure
docker compose up postgres postgres-temporal temporal -d

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

```bash
# Get a JWT first
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<SEED_ADMIN_PASSWORD>"}' \
  | jq -r '.data.accessToken')

# Submit a work request (standard budget tier)
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "externalTicketId": "JIRA-42",
    "description": "Add a GET /health endpoint that returns { status: ok }",
    "repoIds": ["<repo-uuid-from-seed>"],
    "budgetTier": "STANDARD"
  }'
```

`budgetTier` controls the LLM token budget: `STANDARD` (2M/500K tokens), `LARGE` (8M/2M), `EPIC` (20M/5M). The workflow is terminated with `BUDGET_EXCEEDED` if the limit is breached.

### Monitor

```bash
# List workflows
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/workflows

# Temporal Web UI — real-time workflow state, history, signals
open http://localhost:8233
```

## Environment variables

| Variable                | Required  | Description                                                  |
| ----------------------- | --------- | ------------------------------------------------------------ |
| `DATABASE_URL`          | Yes       | PostgreSQL connection string                                 |
| `TEMPORAL_ADDRESS`      | Yes       | Temporal server address (default: `localhost:7233`)          |
| `ANTHROPIC_API_KEY`     | Yes       | Claude API key (Implementer, Review, Planner, Memory agents) |
| `GITHUB_TOKEN`          | Yes       | GitHub PAT with `repo` scope                                 |
| `GITHUB_WEBHOOK_SECRET` | Yes       | Secret for verifying GitHub webhook signatures               |
| `OPENAI_API_KEY`        | Yes       | OpenAI key for `text-embedding-3-large` embeddings           |
| `JWT_SECRET`            | Yes       | Secret for signing HS256 JWTs                                |
| `SEED_ADMIN_PASSWORD`   | Seed only | Password for the seeded admin user                           |
| `SLACK_CLIENT_ID`       | Optional  | Slack OAuth app credentials                                  |
| `SLACK_CLIENT_SECRET`   | Optional  | Slack OAuth app credentials                                  |
| `SLACK_SIGNING_SECRET`  | Optional  | For verifying Slack interactive webhook signatures           |
| `BRANCH_PREFIX`         | Optional  | Git branch prefix (default: `auto`)                          |
| `GITHUB_URL`            | Optional  | Override for GitHub Enterprise Server                        |
| `GITHUB_API_URL`        | Optional  | Override for GitHub Enterprise Server API                    |

## Commands

```bash
yarn build           # Build all packages
yarn test            # Run all tests (Vitest)
yarn db:migrate      # Run Prisma migrations
yarn db:generate     # Regenerate Prisma client
yarn db:seed         # Seed admin user + sample repository
yarn dev:gateway     # Gateway in watch mode
yarn dev:worker      # Worker in watch mode
```

## Project structure

```text
packages/
├── shared/     # Prisma schema, DB client, shared TypeScript types
├── gateway/    # Fastify 5.x HTTP API (auth, RBAC, routes, webhooks)
├── worker/     # Temporal worker, Mastra agents, activities
└── web/        # Next.js 15 web dashboard
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
