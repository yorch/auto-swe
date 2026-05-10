# AGENTS.md — Project Guidelines for AI Agents

> Guidelines for any AI agent (Claude Code, Codex, Copilot, Cursor, etc.) working on this codebase.

---

## 1. Project Overview

**auto-swe** is an autonomous agentic software engineering system built as a Yarn 4 TypeScript monorepo. It accepts work requests (external ticket IDs from any issue tracker), runs LLM-powered agents to implement code in isolated Docker workspaces, reviews changes via a multi-agent review network, opens pull requests, and waits for human merge. It includes JWT auth with RBAC, team management, Slack integration, a CI self-healing loop, semantic memory (pgvector), and a Next.js web dashboard.

---

## 2. Design Documents

For deeper context on architecture and design rationale, refer to:

| Document                          | Covers                                               |
| --------------------------------- | ---------------------------------------------------- |
| `docs/mvp-architecture.md`        | Core architecture, component design, data flow       |
| `docs/mvp-implementation.md`      | Build guide with project structure and build order   |
| `docs/gateway-and-auth.md`        | JWT auth, RBAC, Team API, Slack OAuth, full API spec |
| `docs/data-and-infra.md`          | Embedding pipeline, executor images, security review |
| `docs/workflow-and-activities.md` | Review network, CI fix loop, memory commit           |
| `docs/wireframes.md`              | Web dashboard wireframes and page layouts            |

---

## 3. Tech Stack

| Component       | Technology                             | Version                    |
| --------------- | -------------------------------------- | -------------------------- |
| Runtime         | Node.js                                | >=24.0.0                   |
| Package Manager | Yarn 4 (Berry)                         | 4.12.0 (via corepack)      |
| HTTP Framework  | Fastify                                | ^5.7.0                     |
| Orchestration   | Temporal.io                            | auto-setup:1.25.2          |
| Agent Framework | Mastra                                 | ^1.6.0                     |
| ORM             | Prisma                                 | ^7.4.0                     |
| Database        | PostgreSQL 17 + pgvector               | pgvector/pgvector:pg17     |
| LLM             | Anthropic / OpenAI / Google / any OpenAI-compat | via Vercel AI SDK |
| Language        | TypeScript                             | ^5.7.0                     |
| Web Dashboard   | Next.js 15 + React 19 + Tailwind CSS 4 | ^15.0.0 / ^19.0.0 / ^4.0.0 |
| Server State    | TanStack Query (React Query)           | ^5.90.0                    |
| Client State    | Zustand                                | ^5.0.0                     |
| Testing         | Vitest                                 | ^3.0.0                     |
| Lint / Format   | Biome                                  | ^2.4.14                    |

---

## 4. Project Structure

```
auto-swe/
├── packages/
│   ├── shared/          # Prisma schema, DB client, shared types
│   │   └── src/
│   │       ├── prisma/  # schema.prisma, seed.ts, migrations/
│   │       ├── types/   # workflow.ts, api.ts
│   │       ├── lib/     # workflowId.ts (Temporal ID generation)
│   │       ├── db.ts    # Singleton PrismaClient
│   │       └── index.ts # Barrel export
│   ├── gateway/         # Fastify 5.x HTTP API
│   │   └── src/
│   │       ├── plugins/ # auth.ts, prisma.ts, temporal.ts (fastify-plugin)
│   │       ├── routes/  # auth, workRequests, workflows, webhooks, teams, users, repositories, lessons, slack
│   │       ├── lib/     # github.ts (Octokit client)
│   │       └── index.ts # App bootstrap
│   ├── worker/          # Temporal worker + Mastra agents
│   │   └── src/
│   │       ├── workflows/    # engineering.ts, epicOrchestrator.ts (V8 isolate — import type only)
│   │       ├── activities/   # executeImplementation, ciFixLoop, commitToMemory, createOrUpdatePullRequest, runReviewNetwork, state, workspace, utils
│   │       ├── agents/       # implementer.ts, reviewNetwork.ts, prompts.ts
│   │       └── lib/          # embeddings.ts, lessonRetrieval.ts
│   └── web/             # Web Dashboard (Next.js 15 + React 19 + Tailwind CSS 4)
│       └── src/
│           ├── app/     # Next.js App Router pages (workflows, epics, repos, lessons, teams, users, settings, login)
│           ├── hooks/   # useWorkflows.ts (TanStack Query)
│           ├── lib/     # api.ts (fetch client), utils.ts
│           └── stores/  # authStore.ts, teamStore.ts (Zustand)
├── docker-compose.infra.yml # Infra: Postgres (pgvector), Temporal, Postgres-temporal
├── docker-compose.yml   # App: Gateway, Worker, Web, otel-lgtm (overlays infra)
├── tsconfig.base.json   # Shared TypeScript config
├── vitest.config.ts     # Test configuration
├── .env.example         # Environment variable template
└── package.json         # Yarn 4 workspace root
```

---

## 5. Conventions

### Code Style

- TypeScript strict mode everywhere (`"strict": true` in tsconfig)
- Use `import type` for type-only imports — **critical** for Temporal workflow files (V8 isolate)
- Fastify plugin pattern (`fastify-plugin`) for all gateway extensions
- Zod schemas for request validation via `fastify-type-provider-zod`
- Prisma for all DB access — raw SQL (`$queryRawUnsafe`) only for pgvector operations (embeddings)
- Prefer explicit error handling over silent failures
- **Biome** is the single source of truth for lint + format — config at root `biome.json` (single quotes, lineWidth 100, indent 2, organizeImports on). Run `yarn lint:fix` before committing.

### Naming Conventions

| Thing                         | Pattern                           | Example                                   |
| ----------------------------- | --------------------------------- | ----------------------------------------- |
| Temporal workflow ID          | `eng-<org>-<repoName>-<ticketId>` | `eng-acme-payments-api-JIRA-1234`         |
| Git branch                    | `<BRANCH_PREFIX>/<ticketId>`      | `auto/JIRA-1234` (default prefix: `auto`) |
| Docker workspace container    | `workspace-<random-hex>`          | `workspace-a1b2c3d4`                      |
| Prisma table mapping          | `snake_case` via `@@map`          | `active_workflows`                        |
| Team slug                     | `lowercase-kebab-case`            | `payments`, `platform-eng`                |
| Team membership composite key | `(user_id, team_id)` unique       | —                                         |
| TypeScript interfaces         | `PascalCase`                      | `RepoWorkRequest`                         |
| Activity functions            | `camelCase`, verb-first           | `executeImplementation`                   |

### Testing

- **Framework:** Vitest (`vitest.config.ts` at root)
- **Gateway routes:** Fastify's built-in `light-my-request` via `app.inject()`
- **Temporal workflows:** `@temporalio/testing` TestWorkflowEnvironment
- **Activities:** Mock Prisma client + mock Docker exec calls
- **Pattern:** Co-locate test files next to source (e.g., `workRequests.test.ts`)

### Monorepo Commands

```bash
yarn install              # Install all dependencies
yarn build                # Build all packages
yarn dev:gateway          # Start gateway in dev mode (tsx watch)
yarn dev:worker           # Start worker in dev mode (tsx watch)
yarn db:migrate           # Run Prisma migrations
yarn db:generate          # Generate Prisma client
yarn db:seed              # Seed admin user + sample repository
yarn test                 # Run all tests (vitest)
yarn lint                 # Lint + format check (biome check)
yarn lint:fix             # Auto-fix safe lint issues + format (biome check --write)
yarn format               # Format only (biome format --write)
```

### Git Workflow

- **Commit each logical change separately** — don't batch unrelated changes into one commit
- **Push after each commit** — keep the remote up to date as you work
- Write concise commit messages that describe the "why", not just the "what"
- Use conventional-style prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Never commit `.env`, credentials, or secrets
- Never force-push to `main`

---

## 6. Critical Implementation Notes

### Mastra 1.6 API

The project uses `@mastra/core@^1.6.0` with the Vercel AI SDK for model binding:

- `Agent` constructor requires both `id` and `name` fields
- `createTool()` requires `outputSchema` on all tools (structured output)
- Tool execute functions return structured objects matching `outputSchema`
- Model binding: **always use `getModel(role)` from `packages/worker/src/lib/models.ts`** — never call `anthropic('...')` / `openai('...')` directly in agent code. Provider selection is config-driven.
- Structured generation: `agent.generate(messages, { output: zodSchema })`

### Multi-Model Support

Each agent role resolves its model at call time through `getModel(role)`:

| Role              | Env var                     | Default                                |
| ----------------- | --------------------------- | -------------------------------------- |
| `implementer`     | `IMPLEMENTER_MODEL`         | `anthropic/claude-opus-4-6`            |
| `reviewer`        | `REVIEWER_MODEL`            | `anthropic/claude-opus-4-6`            |
| `planner`         | `PLANNER_MODEL`             | `anthropic/claude-sonnet-4-20250514`   |
| `securityReview`  | `SECURITY_REVIEW_MODEL`     | `anthropic/claude-sonnet-4-20250514`   |
| `validateContext` | `CONTEXT_VALIDATOR_MODEL`   | `anthropic/claude-sonnet-4-20250514`   |
| `commitToMemory`  | `MEMORY_SUMMARIZER_MODEL`   | `anthropic/claude-opus-4-6`            |

Spec format is `<provider>/<model-id>`. Built-in providers: `anthropic`, `openai`, `google`. Any other provider name routes through `@ai-sdk/openai-compatible` and requires `<PROVIDER>_API_BASE` (uppercase, hyphens → underscores) — covers OpenRouter, Ollama, vLLM, Groq, Cerebras, Inflection Pi, etc.

### Cost Tracking

`packages/worker/src/lib/costTracking.ts` prices each call from `MODEL_PRICES` (USD per MTok). Unknown models fall back to zero cost and emit `llm.cost_pricing_known=false` on the OTel span — usage is still recorded so the workflow runs aren't lost. Add new entries to `MODEL_PRICES` as roles are routed to new models, or set per-model env overrides:

```
MODEL_PRICE_<PROVIDER>_<MODEL>=<input>:<output>   # USD per MTok, non-alphanumerics → _
```

`recordLlmUsage()` takes an `AgentRole` so the price is looked up via the same `getModelSpec()` the agent uses to bind its model.

### Embeddings

`packages/worker/src/lib/embeddings.ts` follows the same `<provider>/<model>` config pattern via the `EMBEDDING_MODEL` env var (default `openai/text-embedding-3-large`). Built-in: `openai`. Any other provider name is treated as an OpenAI-compatible endpoint and requires `<PROVIDER>_API_BASE`. Output **must** be 1536-dimensional — the `agent_lessons.embedding` column is fixed at `vector(1536)` and the helper throws if the model returns a different shape.

### Temporal Workflow Constraints

- Workflow files run in a **V8 isolate**, not Node.js
- Only `import type` is allowed for external packages
- All runtime imports must come from `@temporalio/workflow`
- Activities are the boundary between deterministic replay and the non-deterministic outside world (LLM calls, Docker, GitHub API, DB)

### Docker-in-Docker Workspace

- The worker process needs the Docker socket mounted (`/var/run/docker.sock`)
- Containers are created with `docker run`, commands executed with `docker exec`
- **Always** clean up containers in a `finally` block — leaked containers will accumulate
- Shell escaping: the workspace `exec` function escapes single quotes; be aware of injection risk from agent-generated commands

### Yarn 4 Docker Builds

- Dockerfiles use a **3-stage build** (builder → prod-deps → runtime)
- `yarn workspaces focus <pkg> --production` strips devDependencies in the prod-deps stage
- Dependencies are hoisted to root `node_modules/`; per-workspace `node_modules/` may be empty
- Prisma generated client lives in `node_modules/.prisma` — must be explicitly copied from builder to runtime
- Root `package.json` must be in runtime image for workspace symlink resolution
- **No `corepack enable`** needed in the runtime stage — it only runs `node`

---

## 7. Forbidden Actions

- Do **NOT** use Express.js — the project uses **Fastify 5.x**
- Do **NOT** use K8s APIs — workspaces use Docker-in-Docker for isolation
- Do **NOT** auto-merge PRs on target repositories — humans merge
- Do **NOT** store secrets in code or commit `.env` files
- Do **NOT** modify the Temporal server or its configuration
- Do **NOT** use raw SQL except for pgvector operations — use Prisma client for everything else
- Do **NOT** add dependencies without checking if an existing one covers the need

---

## 8. Local Development Quickstart

```bash
# 1. Install
corepack enable && yarn install

# 2. Start infrastructure
cp .env.example .env    # Fill in ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET
docker compose up postgres postgres-temporal temporal -d

# 3. Database setup
yarn db:migrate && yarn db:generate && yarn db:seed

# 4. Start services (two terminals)
yarn dev:gateway         # Terminal 1 — http://localhost:8080
yarn dev:worker          # Terminal 2

# 5. Submit a test work request
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H 'Content-Type: application/json' \
  -d '{"externalTicketId":"JIRA-1","description":"Add GET /health endpoint","repoIds":["<repo-uuid-from-seed>"]}'

# 6. Monitor
# Temporal Web UI: http://localhost:8233
# Workflows:      http://localhost:8080/api/v1/workflows
```

---

## 9. Reference: Key Design Decisions

| Decision                     | Choice                                                    | Rationale                                                         |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| HTTP framework               | Fastify 5.x over Express                                  | ~3x throughput, built-in schema validation, plugin architecture   |
| JWT auth                     | Access + refresh tokens with family-based reuse detection | Stateless auth with secure rotation; bcrypt for password hashing  |
| DinD over K8s                | `docker run`/`exec`                                       | No cluster needed; same isolation model, zero infra beyond Docker |
| Single PAT                   | One GitHub token                                          | JIT-scoped tokens require a GitHub App (future)                   |
| pgvector for memory          | Vector embeddings on AgentLesson                          | Semantic similarity search for agent context enrichment           |
| Yarn 4 `node-modules` linker | Not PnP                                                   | Maximum tool compatibility with Prisma, Temporal, Docker          |
