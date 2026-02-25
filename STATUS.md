# STATUS.md — Implementation Status

> Maps the original plan (`PLAN.md`) against what was actually built. Updated 2026-02-25.

## Legend

- **Done** — Implemented and functional
- **Partial** — Scaffolded or partially working; see notes
- **Not started** — Not implemented; may or may not be planned

---

## Phase 1: Single-Repo Agent Loop (MVP)

| Planned Feature | Status | Notes |
|---|---|---|
| PostgreSQL 17 + pgvector database with Prisma schema | Done | |
| Team + TeamMembership tables (schema only, no enforcement) | Done | |
| Temporal server + single worker process | Done | |
| `EngineeringWorkflow` (child workflow) | Done | Full loop: Implement → Review → PR → CI → Merge → Memory |
| Implementer Agent (Mastra + `claude-opus-4-6`) with bash/file tools | Done | |
| Local TDD loop (write tests, run in DinD, iterate) | Done | |
| `createOrUpdatePullRequest` activity via GitHub API | Done | |
| Human merge signal webhook (`POST /api/v1/webhooks/git`) | Done | HMAC signature verification |
| CLI trigger (`POST /api/v1/work-requests`) | Done | Now requires JWT auth (not hardcoded ADMIN as originally planned) |
| Docker Compose for local dev | Done | |

**Phase 1 status: Complete**

---

## Phase 2: Review Network + CI/CD Integration

| Planned Feature | Status | Notes |
|---|---|---|
| Security Auditor agent | Done | Part of `reviewNetwork.ts` |
| Domain Logic Reviewer agent | Done | Part of `reviewNetwork.ts` |
| Performance Reviewer agent | Done | Part of `reviewNetwork.ts` |
| `runReviewNetwork` activity (orchestrate + aggregate verdicts) | Done | All three reviewers run in parallel via `Promise.allSettled` |
| CI/CD webhook handler (`POST /api/v1/webhooks/ci`) | Done | Handles `check_run` completed events, signals workflow |
| `fetchCILogs` activity | Done | In `ciFixLoop.ts` |
| `executeCIFixImplementation` activity (CI self-healing) | Done | In `ciFixLoop.ts` |
| `SecurityReviewProcessor` middleware on Implementer writes | Not started | Plan described a middleware that intercepts agent file writes for security scanning |
| Context Validator agent + `ContextSnapshot` persistence | Not started | Plan described a Gemini-based agent that validates context before implementation |
| OTel tracing integration (Langfuse/SigNoz export) | Not started | No OpenTelemetry instrumentation anywhere |

**Phase 2 status: Core features done. SecurityReviewProcessor, Context Validator, and OTel not started.**

---

## Phase 3: Multi-Repo Epics + RBAC + Slack

| Planned Feature | Status | Notes |
|---|---|---|
| Epic Orchestrator (parent workflow) | Done | `epicOrchestrator.ts` — dependency graph execution, parallel child workflows |
| JWT authentication (login + refresh) | Done | `auth.ts` routes — bcrypt, family-based refresh token rotation with reuse detection |
| RBAC middleware (platform role: ENGINEER < LEAD < ADMIN) | Done | `requireAuth({ requiredRole })` on all routes |
| Team CRUD API endpoints (`/api/v1/teams`, members) | Done | Full CRUD + membership management with Zod validation |
| User management API (`/api/v1/users`) | Done | List, create, update (ADMIN only) |
| Repository management API (`/api/v1/repositories`) | Done | List (team-scoped for non-admins), create, update |
| Lessons API (`/api/v1/lessons`) | Done | List (team-scoped), text search, delete |
| Slack OAuth (connect + callback) | Done | `slack.ts` — OAuth flow, Slack ID linking to user |
| Slack interactive webhooks (signature-verified) | Done | `slack.ts` `/interactive` — handles approve/retry actions |
| Planner Agent (decomposes epics into per-repo child workflows) | Not started | Epic Orchestrator expects pre-decomposed `repos[]` array; no LLM decomposition |
| Team-scoped RBAC middleware (`requiredTeamRole`) | Partial | `requireAuth` accepts `requiredTeamRole` option but only stubs it — sets `_requiredTeamRole` on request, no route actually resolves or enforces it |
| Team filtering on workflow list endpoints | Not started | `workflows.ts` returns all workflows; no team-scoped filtering (repos and lessons do filter) |
| Slack approval gates (role-checked: LEAD/ADMIN only) | Not started | Interactive handler resolves user but doesn't check role before allowing approve/retry actions |
| Repository.teamId non-null enforcement | Partial | `CreateRepoSchema` requires `teamId`, but Prisma schema may still allow null for older records |

**Phase 3 status: Auth, teams, Slack OAuth, and epic orchestration done. Planner Agent, team-scoped RBAC enforcement, and Slack role gates not started.**

---

## Phase 4: Semantic Memory + Web Dashboard + Production Hardening

| Planned Feature | Status | Notes |
|---|---|---|
| Memory Agent (`commitToMemory`) | Done | Summarizes workflow outcomes into `AgentLesson` via LLM |
| Embedding pipeline (`text-embedding-3-large`, 1536d) | Done | `embeddings.ts` — OpenAI embeddings |
| Lesson retrieval (pgvector cosine similarity search) | Done | `lessonRetrieval.ts` — HNSW index, similarity threshold |
| Lesson retrieval injected into agent context | Not started | `retrieveSimilarLessons` exists but is never called from `executeImplementation` or the workflow |
| Next.js 16 web dashboard | Done | App Router with Tailwind CSS 4 |
| Dashboard pages (workflows, epics, repos, lessons, teams, users, settings, login) | Done | All pages exist in `packages/web/src/app/` |
| TanStack Query for server state | Done | `useWorkflows.ts` hook |
| Zustand for client state | Done | `authStore.ts`, `teamStore.ts` |
| Custom executor image build pipeline (GitHub Actions) | Done | `.github/workflows/build-executor.yml` — ECR push, Buildx, weekly rebuilds |
| KEDA autoscaling for agent worker pods | Not started | System uses Docker-in-Docker, not K8s |
| Cost tracking / per-workflow token budgets | Not started | No token counting or budget enforcement |
| Recharts dashboard charts | Not started | Recharts is in dependencies but no chart components exist |

**Phase 4 status: Memory pipeline, web dashboard, and executor build done. Lesson injection into agents, KEDA, cost tracking, and charts not started.**

---

## Design Divergences from Plan

These are deliberate architectural choices where the implementation differs from `PLAN.md`:

| Plan | Actual | Rationale |
|---|---|---|
| K8s Jobs + KEDA for workspace isolation | Docker-in-Docker (`docker run`/`exec`) | No cluster required; same isolation model, simpler ops |
| Multiple LLM providers (Gemini, GPT-5, Claude) | All agents use `claude-opus-4-6` | Single-provider simplicity; avoids multi-provider rate-limit complexity |
| RS256 JWT signing with K8s Secrets | HS256 JWT with `JWT_SECRET` env var | Simpler for Docker Compose deployments; RS256 makes sense at K8s scale |
| `@mastra/anthropic` for model binding | `@ai-sdk/anthropic` (Vercel AI SDK) | Mastra uses AI SDK under the hood; direct import is cleaner |
| 8 Prisma models | 10 Prisma models (added RefreshToken, Team, TeamMembership) | Auth and teams required additional models beyond the original plan |

---

## Summary

| Phase | Planned Features | Done | Partial | Not Started |
|---|---|---|---|---|
| Phase 1 | 10 | 10 | 0 | 0 |
| Phase 2 | 10 | 7 | 0 | 3 |
| Phase 3 | 14 | 9 | 2 | 3 |
| Phase 4 | 12 | 8 | 0 | 4 |
| **Total** | **46** | **34** | **2** | **10** |

### Not started (full list)

1. SecurityReviewProcessor middleware (intercept agent file writes)
2. Context Validator agent + ContextSnapshot persistence
3. OTel tracing (Langfuse/SigNoz)
4. Planner Agent (LLM-based epic decomposition)
5. Team-scoped RBAC enforcement (route-level `requiredTeamRole`)
6. Team filtering on workflow list endpoints
7. Slack approval role gates
8. Lesson retrieval injected into agent context
9. KEDA autoscaling
10. Cost tracking / per-workflow token budgets
