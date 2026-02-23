# AGENTS.md — Project Guidelines for AI Agents

> Guidelines for any AI agent (Claude Code, Codex, Copilot, Cursor, etc.) working on this codebase.

---

## 1. Project Overview

**auto-swe** is an autonomous agentic software engineering system built as a Yarn 4 TypeScript monorepo. It accepts work requests (external ticket IDs from any issue tracker), runs LLM-powered agents to implement code in isolated Docker workspaces, opens pull requests, and waits for human merge.

The system is delivered in 4 phases. **Phase 1 (MVP) is the current build target.**

---

## 2. Phased Delivery — Know What to Build

### Phase 1: Single-Repo Agent Loop (MVP) — CURRENT TARGET

The **sole source of truth** for Phase 1:

- **`docs/mvp-architecture.md`** — Architecture, component design, data flow, design rationale
- **`docs/mvp-implementation.md`** — Step-by-step build guide with project structure, code, and build order

Follow the **15-step build order** in `mvp-implementation.md` Section 2. Each step produces a testable artifact.

### What the MVP Includes

- PostgreSQL 17 + pgvector database with Prisma schema
- Temporal server + single worker process
- `EngineeringWorkflow` (linear: Implement → PR → Await Merge → Done)
- Implementer Agent (Mastra + `claude-opus-4-6`) with bash/file MCP tools
- TDD loop (agent writes tests, runs them in Docker-in-Docker, iterates until green)
- PR creation via GitHub API (Octokit — supports github.com and GitHub Enterprise Server)
- Human merge signal via webhook
- CLI trigger (`POST /api/v1/work-requests`) with hardcoded ADMIN role
- Docker Compose for local dev

### What the MVP Excludes — Do NOT Implement

| Feature | Phase |
|---|---|
| JWT authentication or RBAC middleware | 3 |
| Team CRUD API endpoints or membership management | 3 |
| Team-scoped RBAC enforcement (`requiredTeamRole`) | 3 |
| Team filtering on list endpoints (workflows, repos, lessons) | 3 |
| Review network (Security Auditor, Domain Logic Reviewer, Performance Reviewer) | 2 |
| CI/CD webhook listener or CI self-healing loop | 2 |
| Context Validator agent or ContextSnapshot persistence | 2 |
| Slack integration (OAuth, interactive webhooks, approval buttons) | 3 |
| Web UI / Admin Dashboard in `packages/web/` (incl. Teams List, Team Detail pages) | 4 |
| Semantic memory (AgentLesson embeddings, pgvector search) | 4 |
| Cost tracking or per-workflow token budgets | 4 |
| Custom executor image build pipeline | 4 |
| OTel tracing and observability export | 2 |
| Epic Orchestrator parent workflow | 3 |
| KEDA autoscaling | 4 |

### Documents to Ignore During Phase 1

These describe Phase 2-4 features. Read for context only — do NOT implement from them:

| Document | Contains | Phase |
|---|---|---|
| `docs/gateway-and-auth.md` | JWT auth, RBAC middleware (incl. team-scoped), Team API endpoints, Slack OAuth, full API spec | 3 |
| `docs/data-and-infra.md` | Embedding pipeline, K8s executor images, SecurityReviewProcessor (Team/TeamMembership models are in schema but tables-only in Phase 1) | 2-4 |
| `docs/workflow-and-activities.md` | Review network, CI fix loop, memory commit, K8s workspace | 2-4 |
| `docs/wireframes.md` | Web dashboard wireframes (incl. Teams List, Team Detail pages) | 4 |

These docs have `⚠️ PHASE X` banners on out-of-scope sections. Respect them.

---

## 3. Tech Stack

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | >=24.0.0 |
| Package Manager | Yarn 4 (Berry) | 4.12.0 (via corepack) |
| HTTP Framework | Fastify | ^5.7.0 |
| Orchestration | Temporal.io | auto-setup:1.25.2 |
| Agent Framework | Mastra | ^1.0.0 |
| ORM | Prisma | ^7.4.0 |
| Database | PostgreSQL 17 + pgvector | pgvector/pgvector:pg17 |
| LLM (MVP) | claude-opus-4-6 (Anthropic) | — |
| Language | TypeScript | ^5.7.0 |
| Web Dashboard | Next.js 16 + React 19 + Tailwind CSS 4 | ^16.1.0 / ^19.2.0 / ^4.2.0 |
| UI Components | shadcn/ui + Radix UI (unified) | copy-paste / ^1.4.0 |
| Server State | TanStack Query (React Query) | ^5.90.0 |
| Client State | Zustand | ^5.0.0 |
| Charts | Recharts | ^3.7.0 |
| Testing | Vitest | ^3.0.0 |

---

## 4. Project Structure

```
auto-swe/
├── packages/
│   ├── shared/          # Prisma schema, DB client, shared types
│   │   └── src/
│   │       ├── prisma/  # schema.prisma, seed.ts, migrations/
│   │       ├── types/   # workflow.ts, api.ts
│   │       ├── db.ts    # Singleton PrismaClient
│   │       └── index.ts # Barrel export
│   ├── gateway/         # Fastify 5.x HTTP API
│   │   └── src/
│   │       ├── plugins/ # prisma.ts, temporal.ts (fastify-plugin)
│   │       ├── routes/  # workRequests.ts, workflows.ts, webhooks.ts
│   │       └── index.ts # App bootstrap
│   ├── worker/          # Temporal worker + Mastra agents
│   │   └── src/
│   │       ├── workflows/    # engineering.ts (V8 isolate — import type only)
│   │       ├── activities/   # executeImplementation, createOrUpdatePullRequest, state, workspace
│   │       └── agents/       # implementer.ts, prompts.ts
│   └── web/             # Web Dashboard (Next.js 16 + React 19 + Tailwind CSS 4) — Phase 4
│       └── src/
│           └── app/     # Next.js App Router pages
├── docker-compose.yml   # Postgres, Temporal, Gateway, Worker
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
- Prisma for all DB access — no raw SQL in the MVP
- Prefer explicit error handling over silent failures

### Naming Conventions

| Thing | Pattern | Example |
|---|---|---|
| Temporal workflow ID | `eng-<ticketId>-<repoName>` | `eng-JIRA-1234-payments-api` |
| Git branch | `<BRANCH_PREFIX>/<ticketId>` | `auto/JIRA-1234` (default prefix: `auto`) |
| Docker workspace container | `workspace-<random-hex>` | `workspace-a1b2c3d4` |
| Prisma table mapping | `snake_case` via `@@map` | `active_workflows` |
| Team slug | `lowercase-kebab-case` | `payments`, `platform-eng` |
| Team membership composite key | `(user_id, team_id)` unique | — |
| TypeScript interfaces | `PascalCase` | `RepoWorkRequest` |
| Activity functions | `camelCase`, verb-first | `executeImplementation` |

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

### Mastra 1.0 API — Verify Before Implementing

The agent code in `mvp-implementation.md` is based on pre-release Mastra docs. **Before writing agent code (Step 10-11):**

1. Run `yarn add @mastra/core @mastra/anthropic`
2. Check the actual exported API — verify `new Mastra({ agents: { ... } })`, `createTool()`, and `anthropic()` model binding
3. If the API differs, adapt the code — the architecture and intent are correct even if the exact constructor shape changes
4. The `@mastra/anthropic` package name is assumed — check npm for the actual published name

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

- Do **NOT** implement features from Phase 2-4 unless explicitly instructed
- Do **NOT** use Express.js — the project uses **Fastify 5.x**
- Do **NOT** use K8s APIs — the MVP uses Docker-in-Docker for workspace isolation
- Do **NOT** auto-merge PRs on target repositories — humans merge
- Do **NOT** store secrets in code or commit `.env` files
- Do **NOT** modify the Temporal server or its configuration
- Do **NOT** use raw SQL in the MVP — use Prisma client exclusively
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

| Decision | Choice | Rationale |
|---|---|---|
| HTTP framework | Fastify 5.x over Express | ~3x throughput, built-in schema validation, plugin architecture |
| No auth in MVP | Hardcoded ADMIN role | MVP runs locally in Docker Compose — no external access to protect |
| DinD over K8s | `docker run`/`exec` | No cluster needed; same isolation model, zero infra beyond Docker |
| Single PAT | One GitHub token | JIT-scoped tokens require a GitHub App (Phase 3) |
| Full Prisma schema | All 10 models created (incl. Team, TeamMembership) | Forward compatibility — unused tables have zero runtime cost |
| Yarn 4 `node-modules` linker | Not PnP | Maximum tool compatibility with Prisma, Temporal, Docker |
