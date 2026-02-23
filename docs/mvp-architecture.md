# MVP Architecture & Design (Phase 1: Single-Repo Agent Loop)

> This document defines the architecture and design for the Minimum Viable Product. It is scoped exclusively to Phase 1 deliverables as defined in [PLAN.md](../PLAN.md). Everything outside Phase 1 is explicitly excluded.

## 1. MVP Goal

A single Temporal workflow that accepts a work request via CLI, runs an AI agent to implement code in an isolated workspace, executes tests in a TDD loop, opens a pull request, and completes when a human merges it.

**Exit Criteria:** A Jira ticket ID submitted via CLI produces a green PR on a target repository, and the workflow completes when a human merges it.

## 2. What the MVP Includes

| Capability | Description |
|---|---|
| Database | PostgreSQL 17 + pgvector with Prisma v7.x schema (subset: User, Repository, WorkRequest, ActiveWorkflow, PullRequest) |
| Orchestration | Temporal server + single TypeScript worker process |
| Workflow | `EngineeringWorkflow` (child workflow only — no parent Epic Orchestrator) |
| Agent | Implementer Agent (Mastra 1.0 + `claude-opus-4-6`) with bash and GitHub MCP tools |
| TDD Loop | Agent writes tests, runs them in Docker-in-Docker, iterates until green (max 5 iterations) |
| PR Creation | `createOrUpdatePullRequest` activity via GitHub API (Octokit) |
| Merge Signal | Human merge webhook (`POST /api/v1/webhooks/git`) fires `humanMergeSignal` |
| CLI Trigger | `POST /api/v1/work-requests` with hardcoded ADMIN role (no JWT) |
| Infrastructure | Docker Compose: Postgres, Temporal, Gateway, Worker |

## 3. What the MVP Excludes

These are explicitly out of scope and must not be built during Phase 1:

- Multi-repo epics and Epic Orchestrator (parent workflow)
- Review network (Security Auditor, Domain Logic Reviewer, Performance Reviewer)
- CI/CD webhook listener and CI self-healing loop
- Context Validator agent and ContextSnapshot persistence
- Slack integration (OAuth, interactive webhooks, approval buttons)
- Web UI / Admin Dashboard
- RBAC enforcement (JWT, role hierarchy, middleware)
- Semantic memory (AgentLesson, embedding pipeline, pgvector search)
- Cost tracking and per-workflow token budget enforcement
- Custom executor image build pipeline (ECR, GitHub Actions)
- OTel tracing and observability export
- KEDA autoscaling

## 4. System Boundary Diagram (MVP)

```
                        ┌──────────────────────┐
                        │     CLI (curl/httpie) │
                        │  POST /api/v1/        │
                        │    work-requests      │
                        └──────────┬───────────┘
                                   │ HTTP
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE                                                    │
│                                                                  │
│  ┌────────────────────────┐     ┌────────────────────────────┐  │
│  │  Interaction Gateway   │────▶│  Temporal Server           │  │
│  │  (Fastify 5.x, no auth)│     │  (auto-setup:1.25.2)       │  │
│  │                        │◀────│                            │  │
│  │  - POST /work-requests │     └────────────┬───────────────┘  │
│  │  - POST /webhooks/git  │                  │                  │
│  └────────────────────────┘                  │ Task Queue       │
│                                              │                  │
│  ┌────────────────────────┐                  │                  │
│  │  PostgreSQL 17         │                  │                  │
│  │  (pgvector/pgvector)   │                  │                  │
│  │                        │                  │                  │
│  │  - users               │                  │                  │
│  │  - repositories        │                  │                  │
│  │  - work_requests       │                  │                  │
│  │  - active_workflows    │                  │                  │
│  │  - pull_requests       │                  │                  │
│  └────────────────────────┘                  │                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ EXECUTION PLANE                                                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Temporal Worker (Node.js)                                 │  │
│  │                                                            │  │
│  │  EngineeringWorkflow                                       │  │
│  │    │                                                       │  │
│  │    ├─ updateDomainState('IMPLEMENTING')                    │  │
│  │    ├─ executeImplementation()                              │  │
│  │    │    ├─ Provision DinD workspace (docker run)           │  │
│  │    │    ├─ Clone target repo                               │  │
│  │    │    ├─ Mastra Implementer Agent (claude-opus-4-6)      │  │
│  │    │    │    └─ TDD loop (write code → run tests → fix)    │  │
│  │    │    └─ Return CodeResult (diff, branch, test results)  │  │
│  │    │                                                       │  │
│  │    ├─ createOrUpdatePullRequest()                          │  │
│  │    │    └─ Octokit: create PR on GitHub                    │  │
│  │    │                                                       │  │
│  │    ├─ updateDomainState('AWAITING_HUMAN_MERGE')            │  │
│  │    ├─ ⏳ await humanMergeSignal (max 7 days)              │  │
│  │    │                                                       │  │
│  │    └─ updateDomainState('COMPLETED')                       │  │
│  │                                                            │  │
│  │  ┌────────────────────┐                                    │  │
│  │  │ Docker-in-Docker   │ ← Agent runs tests here           │  │
│  │  │ (workspace sandbox)│                                    │  │
│  │  └────────────────────┘                                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                                               │
                                               │ GitHub API
                                               ▼
                                   ┌───────────────────────┐
                                   │  GitHub (Target Repo)  │
                                   │  - Branch created      │
                                   │  - PR opened           │
                                   │  - Merge webhook fires  │
                                   └───────────────────────┘
```

## 5. Component Design

### 5.1 Interaction Gateway (MVP Scope)

A minimal Fastify 5.x HTTP server. No JWT authentication — the MVP uses a hardcoded ADMIN role on all requests. Validation uses Fastify's built-in Zod type provider (`fastify-type-provider-zod`). Raw body access for HMAC webhook verification uses `fastify-raw-body`.

**Endpoints (MVP only):**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/work-requests` | Create a work request and start workflow |
| `POST` | `/api/v1/webhooks/git` | Receive GitHub merge events |
| `GET` | `/api/v1/workflows` | List active workflows (debug) |
| `GET` | `/api/v1/workflows/:id` | Get workflow detail (debug) |

The gateway is responsible for:
1. Validating the request body (Zod schemas via Fastify type provider — automatic 400 on invalid input)
2. Creating `WorkRequest` and `ActiveWorkflow` records in Postgres
3. Starting the `EngineeringWorkflow` on Temporal via the Temporal client SDK
4. Forwarding GitHub merge webhooks as Temporal signals

### 5.2 Temporal Worker

A single Node.js process that registers the `EngineeringWorkflow` and its activities with the Temporal server. Connects to Temporal via gRPC (`temporal:7233`).

**Task Queue:** `engineering-workflow` (single queue for the MVP)

**Workflow:** `EngineeringWorkflow` — simplified from the full design by removing the review network and CI/CD loops. The MVP workflow is linear:

```
Implement → PR → Await Human Merge → Done
```

No review-rejection loops, no CI-fix loops.

### 5.3 Implementer Agent

The only LLM agent in the MVP. Powered by Mastra 1.0 with `claude-opus-4-6`.

**Tools available to the agent (MCP):**
- `bash` — Execute shell commands in the DinD workspace
- `writeFile` — Create/overwrite files in `/workspace/target-repo`
- `readFile` — Read file contents
- `listDirectory` — List directory contents

**Agent behavior:**
1. Receives the work request description and repository context
2. Reads relevant files to understand the codebase
3. Writes implementation code
4. Writes corresponding tests
5. Runs tests via `bash` tool
6. Iterates up to 5 times if tests fail
7. Commits all changes to the feature branch

### 5.4 Workspace Isolation (MVP Approach)

In the MVP, workspace isolation uses **Docker-in-Docker** via `docker run` from the worker process (not K8s Jobs — that's production). The worker:

1. Runs `docker run -d --name workspace-<id> node:20-alpine sleep infinity`
2. Uses `docker exec` to clone the repo, run agent commands, execute tests
3. Tears down the container when the activity completes

This is simpler than K8s Jobs and works in Docker Compose. The workspace is mounted at `/workspace/target-repo` inside the container.

**Credential scoping (MVP):** A single GitHub Personal Access Token (PAT) or GitHub App installation token, provided via environment variable. Not JIT-scoped per-repo (that's Phase 3+).

### 5.5 Database (MVP Schema)

The MVP uses a subset of the full Prisma schema. These models are needed:

| Model | Purpose |
|---|---|
| `User` | Single seed record (hardcoded admin) — no auth flows yet |
| `Repository` | Registered target repos with `organizationName`, `repoName`, `defaultBranch` |
| `WorkRequest` | Inbound requests with `externalTicketId` and payload |
| `ActiveWorkflow` | Tracks Temporal workflow state (`IMPLEMENTING`, `AWAITING_HUMAN_MERGE`, `COMPLETED`) |
| `PullRequest` | Tracks the PR number, head SHA, and status (`OPEN`, `MERGED`) |

Models NOT used in MVP: `RefreshToken`, `ContextSnapshot`, `AgentLesson`.

These unused models can exist in the schema (for forward compatibility) but have no code paths that create or query them.

## 6. Data Flow (MVP)

```
1. CLI Request
   curl -X POST http://localhost:8080/api/v1/work-requests \
     -d '{"externalTicketId": "JIRA-1234", "repoIds": ["<repo-uuid>"]}'

2. Gateway Processing
   → Validate request body
   → INSERT into work_requests
   → INSERT into active_workflows (status: 'IMPLEMENTING')
   → temporal.workflow.start('EngineeringWorkflow', { ... })
   → Return { workRequestId, workflowIds }

3. Temporal Dispatches Workflow to Worker
   → Worker picks up EngineeringWorkflow from task queue

4. executeImplementation Activity
   → Read repository config from DB
   → Spin up DinD workspace container
   → Clone repo, checkout feature branch (auto/JIRA-1234)
   → Mastra agent (claude-opus-4-6):
       → Read codebase, understand requirements
       → Write code + tests
       → Run tests → iterate until green (max 5)
   → Commit changes, collect diff
   → Tear down container
   → Return CodeResult

5. createOrUpdatePullRequest Activity
   → Push branch to GitHub
   → Create PR via Octokit
   → INSERT into pull_requests
   → Return { prNumber, prUrl }

6. Update state → AWAITING_HUMAN_MERGE

7. Wait for humanMergeSignal (up to 7 days)
   → Human reviews PR on GitHub
   → Human merges PR
   → GitHub fires pull_request webhook (action: 'closed', merged: true)
   → Gateway receives POST /api/v1/webhooks/git
   → Gateway verifies HMAC signature
   → Gateway fires humanMergeSignal to Temporal

8. Workflow completes
   → Update active_workflows.status → 'COMPLETED'
   → Update pull_requests.status → 'MERGED'
```

## 7. Infrastructure (Docker Compose)

Four services for local development:

| Service | Image | Port | Purpose |
|---|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | 5432 | Primary database |
| `temporal` | `temporalio/auto-setup:1.25.2` | 7233 (gRPC), 8233 (Web UI) | Workflow orchestration |
| `gateway` | Built from `./gateway` | 8080 | Fastify HTTP API |
| `worker` | Built from `./worker` | — | Temporal worker (no exposed port) |

**Not included in MVP Docker Compose:** OTel collector, web dashboard.

**Required environment variables:**

| Variable | Service | Description |
|---|---|---|
| `DATABASE_URL` | gateway, worker | PostgreSQL connection string |
| `TEMPORAL_ADDRESS` | gateway, worker | `temporal:7233` |
| `ANTHROPIC_API_KEY` | worker | For `claude-opus-4-6` (Implementer) |
| `GITHUB_TOKEN` | worker | PAT or App installation token for GitHub API |
| `GITHUB_WEBHOOK_SECRET` | gateway | HMAC secret for verifying GitHub webhooks |

## 8. Error Handling (MVP)

The MVP has simplified error handling compared to the full system:

| Failure Mode | MVP Behavior |
|---|---|
| LLM API failure (429, 500) | Temporal activity retry (2 attempts, 30s backoff) |
| TDD loop exhausted (5 iterations, tests still failing) | Activity returns CodeResult with `testResults.passed = false` → workflow creates PR anyway with failing tests noted in PR body |
| GitHub API failure (rate limit, network) | Activity retry (4 attempts, exponential backoff) |
| Workspace container crash | Activity fails → Temporal retries the entire activity |
| Human doesn't merge within 7 days | Workflow times out with `TIMED_OUT` status |
| Webhook HMAC verification fails | Gateway returns 401, no signal fired |

## 9. Design Decisions & Rationale

### Why Fastify instead of Express?
Fastify 5.x offers ~3x throughput, built-in schema validation (Zod type provider gives automatic request/response typing), encapsulated error handlers via plugins, and a proper plugin system for clean separation of concerns. The `fastify-raw-body` plugin provides the raw body access needed for HMAC webhook verification without the awkward middleware ordering Express requires.

### Why no review network in MVP?
The review agents (security, domain, performance) add complexity without validating the core hypothesis: can an LLM agent produce a mergeable PR from a ticket? The human reviewer serves as the quality gate in Phase 1.

### Why no CI/CD integration in MVP?
CI/CD webhook handling requires reliable signal routing and a fix-loop that doubles the workflow complexity. The MVP validates the implement-and-PR path; CI integration layers on top in Phase 2.

### Why hardcoded ADMIN role instead of auth?
JWT auth, refresh tokens, and RBAC hooks are significant work. The MVP runs locally behind Docker Compose — there's no external access to protect. Phase 3 adds full RBAC.

### Why Docker-in-Docker instead of K8s Jobs?
K8s requires a cluster. The MVP runs entirely in Docker Compose. DinD workspace containers provide the same isolation model with zero infrastructure beyond Docker.

### Why a single PAT instead of scoped installation tokens?
JIT credential scoping requires a GitHub App installation and per-repo token generation. A single PAT with `repo` scope is sufficient for the MVP's single-repo target.

### Why include the full Prisma schema?
Forward compatibility. Prisma migrations are additive — it's cheaper to create all tables now (even if unused) than to add them later and risk migration conflicts. The unused tables have no runtime cost.
