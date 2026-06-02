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
| `docs/gateway-and-auth.md`        | JWT auth, RBAC, Team API, Slack OAuth, full API spec |
| `docs/data-and-infra.md`          | Embedding pipeline, executor images, security review |
| `docs/workflow-and-activities.md` | Review network, CI fix loop, memory commit           |
| `docs/wireframes.md`              | Web dashboard wireframes and page layouts            |
| `docs/configurable-workflows.md`  | Living roadmap for the configurable-workflow engine (phases, decisions, open questions) |
| `docs/deployment.md`              | Production deployment runbook (env vars, DB + Temporal setup, image build, service layout, smoke test, day-2 ops, hardening) |
| `docs/model-configuration.md`     | DB-backed model + credential config (scope cascade, encryption, day-2 ops) |

---

## 3. Tech Stack

| Component             | Technology                             | Version                |
| --------------------- | -------------------------------------- | ---------------------- |
| Runtime               | Node.js                                | >=24.0.0               |
| Package Manager       | Yarn 4 (Berry, via corepack)           | 4.14.1                 |
| Language              | TypeScript                             | 6.0.3                  |
| HTTP Framework        | Fastify                                | 5.8.5                  |
| Orchestration server  | Temporal (Docker images)               | temporalio/server:1.31.0 + admin-tools 1.31 + ui 2.49.1 |
| Orchestration SDK     | @temporalio/{client,worker,workflow}   | 1.17.1                 |
| Agent Framework       | Mastra                                 | 1.32.1                 |
| LLM SDK               | Vercel AI SDK + provider adapters      | ai 6.x; @ai-sdk/{anthropic,openai,google,openai-compatible} |
| ORM                   | Prisma                                 | 7.8.0                  |
| Database              | PostgreSQL 17 + pgvector               | pgvector/pgvector:pg17 |
| Web Dashboard         | Next.js + React + Tailwind CSS         | 16.2.6 / 19.2.6 / 4.3.0 |
| Server State          | TanStack Query                         | 5.100.9                |
| Client State          | Zustand                                | 5.0.13                 |
| Validation            | Zod                                    | 4.4.3                  |
| Testing               | Vitest                                 | 4.1.5                  |
| Lint / Format         | Biome                                  | 2.4.14                 |
| Observability         | OpenTelemetry + Grafana LGTM (local)   | grafana/otel-lgtm:0.8.1 |

---

## 4. Package Map

Per-package conventions worth knowing up front. Run `ls packages/<name>/src` for the actual layout — only non-obvious rules live here.

| Package            | Purpose                                              | Critical conventions                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`  | Prisma schema, DB client, shared types               | Singleton `PrismaClient` exported from `db.ts`; types re-exported via `index.ts` barrel; `prisma/` holds `schema.prisma`, `seed.ts`, migrations                                               |
| `packages/gateway` | Fastify 5 HTTP API (auth, RBAC, routes, webhooks)    | All extensions use `fastify-plugin`; Zod validation via `fastify-type-provider-zod`; Octokit lives in `lib/github.ts`; entry point `src/index.ts`                                              |
| `packages/worker`  | Temporal worker + Mastra agents                      | **`src/workflows/*` runs in a V8 isolate — `import type` only for external pkgs.** Activities are the deterministic boundary; agents/embeddings/models are imported FROM activities, never from workflows |
| `packages/web`     | Next.js 16 dashboard (App Router)                    | TanStack Query for server state, Zustand for client state; `app/page.tsx` is the dashboard home                                                                                               |
| `packages/cli`     | `auto-swe` CLI (workflows list/show/export/import)   | ESM Node 24+; auth via `AUTO_SWE_TOKEN` or `AUTO_SWE_USERNAME` + `AUTO_SWE_PASSWORD`; thin fetch wrapper over the gateway REST API                                                              |

Top-level files that matter:

- `docker-compose.infra.yml` — postgres + postgres-temporal + temporal (server + admin-tools + ui) + setup containers
- `docker-compose.app.yml` — gateway + worker + web + otel-lgtm (overlay; not runnable standalone)
- `infra/` — helper scripts and Temporal dynamic config mounted into the temporal-setup containers
- `tsconfig.base.json` — shared TS config inherited by every package
- `vitest.config.ts` — root test runner; subpath aliases for `@auto-swe/shared/*` use array form (Vite prefix matching is order-sensitive)
- `biome.json` — single source of truth for lint + format
- `.env.example` — environment variable template

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
yarn typecheck            # Type-check all packages (no emit)
yarn dev:gateway          # Start gateway in dev mode (tsx watch)
yarn dev:worker           # Start worker in dev mode (tsx watch)
yarn dev:web              # Start Next.js dashboard (port 3000)
yarn db:migrate           # Run Prisma migrations
yarn db:generate          # Generate Prisma client
yarn db:seed              # Seed admin user + sample repository
yarn db:studio            # Open Prisma Studio
yarn test                 # Run all tests (vitest)
yarn test:watch           # Vitest in watch mode
yarn lint                 # Lint + format check (biome check)
yarn lint:fix             # Auto-fix safe lint issues + format (biome check --write)
yarn format               # Format only (biome format --write)

# Docker (infra = postgres + postgres-temporal + temporal (server + admin + ui); app = gateway + worker + web + otel-lgtm)
yarn docker:infra:up      # Start infra services only
yarn docker:infra:down    # Stop infra services
yarn docker:app:up            # Start everything (infra + app)
yarn docker:app:down          # Stop everything
yarn docker:app:logs          # Tail logs (infra + app)
yarn docker:app:build         # Rebuild app images
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

### Mastra API

The project uses `@mastra/core@1.32.1` with the Vercel AI SDK for model binding:

- `Agent` constructor requires both `id` and `name` fields
- `createTool()` requires `outputSchema` on all tools (structured output)
- Tool execute functions return structured objects matching `outputSchema`
- Model binding: **always use `getModel(role)` from `packages/worker/src/lib/models.ts`** — never call `anthropic('...')` / `openai('...')` directly in agent code. Provider selection is config-driven.
- Structured generation: `agent.generate(messages, { output: zodSchema })`

### Multi-Model Support

Model selection and provider credentials are fully DB-driven via the dashboard at `/admin/model-config` (admins) or per team from `/teams/<id>` (team owners). There are no model/credential env vars; the worker refuses to start until the DB has every required row (verified by `assertConfigReady()` at boot).

**Scope cascade** at activity-call time (worker's `resolveModelConfig(role, ctx)`):

1. `WORKFLOW_TEMPLATE` row matching the run's template ID, if any
2. `TEAM` row matching the work request's team, if any
3. `GLOBAL` row (system-wide default — required for every role)

No fallback past GLOBAL — missing rows throw `ConfigMissingError`. The worker boot's `assertConfigReady()` walks every required row before the Temporal poller starts.

**Bootstrap flow** (fresh deployment):

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — creates the admin user.
2. Start gateway + web only.
3. Sign in as admin at `/admin/model-config`. Click "Seed Anthropic defaults" to create the 6 GLOBAL `ModelRoleConfig` rows + the `EmbeddingConfig` singleton.
4. Add at least one `ProviderCredential` for the providers the seeded specs reference (Anthropic by default; OpenAI for embeddings).
5. Start the worker.

Per-role baked-in defaults (used by the "Seed defaults" button):

| Role              | Default                       |
| ----------------- | ----------------------------- |
| `implementer`     | `anthropic/claude-opus-4-7`   |
| `reviewer`        | `anthropic/claude-opus-4-7`   |
| `planner`         | `anthropic/claude-sonnet-4-6` |
| `securityReview`  | `anthropic/claude-sonnet-4-6` |
| `validateContext` | `anthropic/claude-sonnet-4-6` |
| `commitToMemory`  | `anthropic/claude-opus-4-7`   |
| (embedding)       | `openai/text-embedding-3-large` |

**Spec format** is `<provider>/<model-id>`. Built-in providers: `anthropic`, `openai`, `google`. Any other provider name routes through `@ai-sdk/openai-compatible` and requires an `apiBase` on the credential row — covers OpenRouter, Ollama, vLLM, Groq, Cerebras, Inflection Pi, OpenCode Go, etc.

**Embeddings** have a dedicated singleton `EmbeddingConfig` table (one row, system-wide). The chosen model must produce 1536-dim vectors — `generateEmbedding` throws if it doesn't.

**Credentials** are stored AES-256-GCM encrypted in `provider_credentials.api_key_ciphertext`. The encryption key (`CONFIG_ENCRYPTION_KEY`, base64 32 bytes) is required to start gateway or worker — fail fast on missing/wrong-length. Rotation is not yet implemented; the `key_version` column is reserved for it.

**Mid-run config changes:** activities re-resolve their model on each call. An edit lands on the next LLM call within an already-running workflow rather than waiting for a fresh run. The dashboard surfaces this in a standing banner.

**Latest model IDs at the time of writing** (override defaults from the dashboard; pricing for these is in `MODEL_PRICES`):

| Provider  | Reasoning / heavy            | Balanced                    | Fast / cheap                            |
| --------- | ---------------------------- | --------------------------- | --------------------------------------- |
| Anthropic | `claude-opus-4-7`            | `claude-sonnet-4-6`         | `claude-haiku-4-5-20251001`             |
| OpenAI    | `gpt-5-5-pro`                | `gpt-5-5`                   | `gpt-5`                                 |
| Google    | `gemini-2.5-pro`             | `gemini-2.5-flash`          | `gemini-3.1-flash-lite-preview` / `gemini-2.5-flash-lite` |

Deprecation warning: `claude-sonnet-4-20250514` (the previous default for planner / securityReview / validateContext) **retires 2026-06-15** — anyone with a custom env override pinned to that ID must migrate to `claude-sonnet-4-6` before that date.

### Cost Tracking

`packages/worker/src/lib/costTracking.ts` prices each call from `MODEL_PRICES` (USD per MTok). Unknown models fall back to zero cost and emit `llm.cost_pricing_known=false` on the OTel span — usage is still recorded so the workflow runs aren't lost. Add new entries to `MODEL_PRICES` as roles are routed to new models, or set per-model env overrides:

```
MODEL_PRICE_<PROVIDER>_<MODEL>=<input>:<output>   # USD per MTok, non-alphanumerics → _
```

`recordLlmUsage()` takes an `AgentRole` so the price is looked up via the same `getModelSpec()` the agent uses to bind its model.

### Embeddings

`packages/worker/src/lib/embeddings.ts` resolves its `<provider>/<model>` spec, API key, and (for OpenAI-compatible providers) `apiBase` entirely from the DB-backed `EmbeddingConfig` singleton via `resolveEmbeddingConfig()` — there are no `EMBEDDING_MODEL` / `<PROVIDER>_API_BASE` env vars (model + credential config is fully DB-driven; see `docs/model-configuration.md`). Built-in: `openai`; any other provider name is treated as an OpenAI-compatible endpoint and requires an `apiBase` on the credential row. Output **must** be 1536-dimensional — the `agent_lessons.embedding` column is fixed at `vector(1536)` and the helper throws if the model returns a different shape.

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

# 2. Start infrastructure (postgres + temporal + otel-lgtm)
cp .env.example .env    # Fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, SEED_ADMIN_PASSWORD
yarn docker:infra:up

# 3. Database setup
yarn db:migrate && yarn db:generate && yarn db:seed
#  ↳ seeds the admin user, default team, sample repo, and default workflow
#    template. Re-running `yarn db:migrate:reset` is the cleanest way to
#    start over locally (migrations consolidate into a single init + the
#    pgvector HNSW index migration; see packages/shared/src/prisma/migrations).

# 4. Start services (three terminals — or `yarn dev` to run all three)
yarn dev:gateway         # Terminal 1 — http://localhost:8080
yarn dev:worker          # Terminal 2
yarn dev:web             # Terminal 3 — http://localhost:3000

# 5. Drive it from the dashboard
#    Sign in at http://localhost:3000 with admin@auto-swe.local + SEED_ADMIN_PASSWORD,
#    then either click "+ Submit work request" or follow the onboarding panel.
#    For headless / scripted use, mint a PAT at Settings → API tokens and:
TOKEN=<paste-PAT>
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"externalTicketId":"JIRA-1","description":"Add GET /health endpoint","repoIds":["<repo-uuid-from-seed>"]}'

# 6. Monitor
# Dashboard:       http://localhost:3000     (KPIs + needs-attention queue)
# Run history:     http://localhost:3000/runs
# Temporal UI:     http://localhost:8233    (workflow history, signals)
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
