# STATUS.md — Implementation Status

> Maps the original plan (`PLAN.md`) against what was actually built. Updated 2026-05-18.

## Legend

- **Done** — Implemented and functional
- **Partial** — Scaffolded or partially working; see notes
- **Not started** — Not implemented; may or may not be planned

---

## Phase 1: Single-Repo Agent Loop (MVP)

| Planned Feature                                                     | Status | Notes                                                             |
| ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| PostgreSQL 17 + pgvector database with Prisma schema                | Done   |                                                                   |
| Team + TeamMembership tables (schema only, no enforcement)          | Done   |                                                                   |
| Temporal server + single worker process                             | Done   |                                                                   |
| `EngineeringWorkflow` (child workflow)                              | Done   | Full loop: Implement → Review → PR → CI → Merge → Memory. **Superseded** by `RunnableWorkflow` + the seeded `default-engineering@v1` spec (PR #13); the hardcoded class no longer exists. |
| Implementer Agent (Mastra + `claude-opus-4-7`) with bash/file tools | Done   |                                                                   |
| Local TDD loop (write tests, run in DinD, iterate)                  | Done   |                                                                   |
| `createOrUpdatePullRequest` activity via GitHub API                 | Done   |                                                                   |
| Human merge signal webhook (`POST /api/v1/webhooks/git`)            | Done   | HMAC signature verification                                       |
| CLI trigger (`POST /api/v1/work-requests`)                          | Done   | Now requires JWT auth (not hardcoded ADMIN as originally planned) |
| Docker Compose for local dev                                        | Done   |                                                                   |

**Phase 1 status: Complete**

---

## Phase 2: Review Network + CI/CD Integration

| Planned Feature                                                | Status | Notes                                                                                                                    |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Security Auditor agent                                         | Done   | Part of `reviewNetwork.ts`                                                                                               |
| Domain Logic Reviewer agent                                    | Done   | Part of `reviewNetwork.ts`                                                                                               |
| Performance Reviewer agent                                     | Done   | Part of `reviewNetwork.ts`                                                                                               |
| `runReviewNetwork` activity (orchestrate + aggregate verdicts) | Done   | All three reviewers run in parallel via `Promise.allSettled`                                                             |
| CI/CD webhook handler (`POST /api/v1/webhooks/ci`)             | Done   | Handles `check_run` completed events, signals workflow                                                                   |
| `fetchCILogs` activity                                         | Done   | In `ciFixLoop.ts`                                                                                                        |
| `executeCIFixImplementation` activity (CI self-healing)        | Done   | In `ciFixLoop.ts`                                                                                                        |
| `SecurityReviewProcessor` middleware on Implementer writes     | Done   | `preWriteSecurityCheck.ts` — regex-based pre-write scanner wrapping `writeFile` tool; blocks CRITICAL, warns HIGH/MEDIUM |
| Context Validator agent + `ContextSnapshot` persistence        | Done   | `validateContext.ts` — validates implementation context before agent runs (commit `15ec99f`)                             |
| OTel tracing integration (Langfuse/SigNoz export)              | Done   | Grafana LGTM stack via `otel.ts`; spans on all LLM calls (commit `d51d0f7`)                                              |

**Phase 2 status: Complete**

---

## Phase 3: Multi-Repo Epics + RBAC + Slack

| Planned Feature                                                | Status | Notes                                                                                                                                                             |
| -------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Epic Orchestrator (parent workflow)                            | Done   | `epicOrchestrator.ts` — dependency graph execution, parallel child workflows                                                                                      |
| JWT authentication (login + refresh)                           | Done   | `auth.ts` routes — bcrypt, family-based refresh token rotation with reuse detection                                                                               |
| RBAC middleware (platform role: ENGINEER < LEAD < ADMIN)       | Done   | `requireAuth({ requiredRole })` on all routes                                                                                                                     |
| Team CRUD API endpoints (`/api/v1/teams`, members)             | Done   | Full CRUD + membership management with Zod validation                                                                                                             |
| User management API (`/api/v1/users`)                          | Done   | List, create, update (ADMIN only)                                                                                                                                 |
| Repository management API (`/api/v1/repositories`)             | Done   | List (team-scoped for non-admins), create, update                                                                                                                 |
| Lessons API (`/api/v1/lessons`)                                | Done   | List (team-scoped), text search, delete                                                                                                                           |
| Slack OAuth (connect + callback)                               | Done   | `slack.ts` — OAuth flow, Slack ID linking to user                                                                                                                 |
| Slack interactive webhooks (signature-verified)                | Done   | `slack.ts` `/interactive` — handles approve/retry actions                                                                                                         |
| Planner Agent (decomposes epics into per-repo child workflows) | Done   | `plannerAgent.ts` — Claude Sonnet 4 structured output; `planEpic.ts` activity bridges workflow→agent; `language` column bug fixed (commit `d51d0f7` + schema fix) |
| Team-scoped RBAC middleware (`requiredTeamRole`)               | Done   | `requireAuth` resolves team membership via `teamIdParam` and enforces team role; used on team mutation routes                                                     |
| Team filtering on workflow list endpoints                      | Done   | `workflows.ts` filters by team membership for non-admins (same pattern as repos/lessons)                                                                          |
| Slack approval gates (role-checked: LEAD/ADMIN only)           | Done   | Interactive handler checks `hasRole(user.role, 'LEAD')` before allowing approve actions                                                                           |
| Repository.teamId non-null enforcement                         | Done   | Prisma schema `teamId String` (non-null), FK `onDelete: Restrict`; migration enforces `NOT NULL` at database level                                                |

**Phase 3 status: Complete**

---

## Phase 4: Semantic Memory + Web Dashboard + Production Hardening

| Planned Feature                                                                   | Status      | Notes                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory Agent (`commitToMemory`)                                                   | Done        | Summarizes workflow outcomes into `AgentLesson` via LLM                                                                                                                                                                                       |
| Embedding pipeline (`text-embedding-3-large`, 1536d)                              | Done        | `embeddings.ts` — OpenAI embeddings                                                                                                                                                                                                           |
| Lesson retrieval (pgvector cosine similarity search)                              | Done        | `lessonRetrieval.ts` — HNSW index, similarity threshold                                                                                                                                                                                       |
| Lesson retrieval injected into agent context                                      | Done        | `executeImplementation` calls `retrieveSimilarLessons` and appends lessons to system prompt                                                                                                                                                   |
| Next.js 16 web dashboard                                                          | Done        | App Router with Tailwind CSS 4                                                                                                                                                                                                                |
| Dashboard pages (workflows, epics, repos, lessons, teams, users, settings, login) | Done        | All pages exist in `packages/web/src/app/`                                                                                                                                                                                                    |
| TanStack Query for server state                                                   | Done        | `useWorkflows.ts` hook                                                                                                                                                                                                                        |
| Zustand for client state                                                          | Done        | `authStore.ts`, `teamStore.ts`                                                                                                                                                                                                                |
| Custom executor image build pipeline (GitHub Actions)                             | Done        | `.github/workflows/build-executor.yml` — ECR push, Buildx, weekly rebuilds                                                                                                                                                                    |
| KEDA autoscaling for agent worker pods                                            | Not started | System uses Docker-in-Docker, not K8s                                                                                                                                                                                                         |
| Cost tracking / per-workflow token budgets                                        | Done        | `costTracking.ts` — per-call metering via `result.usage`, OTel span attributes (`llm.cost_usd`, `workflow.budget_remaining_*`), STANDARD/LARGE/EPIC tiers, `BUDGET_EXCEEDED` ApplicationFailure; cost visible on workflow detail + list pages |
| Recharts dashboard charts                                                         | Done        | 5 Recharts charts (donut, area, bar) across dashboard and lessons pages                                                                                                                                                                       |

**Phase 4 status: Complete except KEDA (not applicable — Docker Compose deployment, not K8s).**

---

## Design Divergences from Plan

These are deliberate architectural choices where the implementation differs from `PLAN.md`:

| Plan                                           | Actual                                                      | Rationale                                                               |
| ---------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| K8s Jobs + KEDA for workspace isolation        | Docker-in-Docker (`docker run`/`exec`)                      | No cluster required; same isolation model, simpler ops                  |
| Single hardcoded LLM provider                  | Multi-provider via `getModel(role)` — anthropic/openai/google/openai-compatible | Per-role env-var overrides (`<ROLE>_MODEL`); defaults stay on Claude    |
| RS256 JWT signing with K8s Secrets             | HS256 JWT with `JWT_SECRET` env var                         | Simpler for Docker Compose deployments; RS256 makes sense at K8s scale  |
| `@mastra/anthropic` for model binding          | `@ai-sdk/anthropic` (Vercel AI SDK)                         | Mastra uses AI SDK under the hood; direct import is cleaner             |
| 8 Prisma models                                | 10 Prisma models (added RefreshToken, Team, TeamMembership) | Auth and teams required additional models beyond the original plan      |

---

## Post-Phase 4: Tooling & Reliability

Work done after the original 4-phase plan was complete:

| Item                                                              | Status | Notes                                                                                                                                                       |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-provider LLM routing (`getModel(role)`)                     | Done   | `<provider>/<model>` spec, `<ROLE>_MODEL` env override per agent role; supports anthropic, openai, google, and any OpenAI-compatible endpoint              |
| Biome 2.4 for lint + format                                       | Done   | Single root `biome.json`; replaced no prior tool (project never had ESLint/Prettier). `noExplicitAny` and `noNonNullAssertion` enforced at error severity   |
| GitHub Actions CI: lint, typecheck, test, build                   | Done   | `.github/workflows/ci.yml`                                                                                                                                  |
| `EpicOrchestratorWorkflow` state reporting                        | Done   | Emits `PLANNING` / `FANNING_OUT` / `COMPLETED` / `FAILED` / `CANCELLED` via `updateDomainState`                                                              |
| Epic workflow timeout                                             | Done   | `workflowExecutionTimeout: '30d'` on `startEpicWorkflow` — bounded by Temporal, children released via `PARENT_CLOSE_POLICY_REQUEST_CANCEL`                  |
| Dependency-failure propagation in epic                            | Done   | `computeTransitiveDependents` walks the dep graph; downstream repos marked `SKIPPED` with `skippedReason` instead of silently omitted                        |
| `updateDomainState` upsert                                        | Done   | Workflows self-register their `ActiveWorkflow` row on first state call (epic + epic-spawned children no longer silently fail)                                |
| Docker Compose split (infra vs app)                               | Done   | `docker-compose.infra.yml` (postgres, postgres-temporal, temporal server+admin+ui, setup containers) + `docker-compose.yml` (gateway, worker, web, otel-lgtm — overlays infra). PR #10 split monolithic `auto-setup` into separate server / admin-tools / ui images. |

---

## Post-Phase 4: Configurable Workflow Engine

Roadmap + decisions live in [`docs/configurable-workflows.md`](./docs/configurable-workflows.md). All 9 phases of the engine have shipped.

| Item                                                                                                  | Status | PR    | Notes                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow-engine Phase 1 — interpreter + spec schema + parity refactor                                 | Done   | #13   | `WorkflowSpec` (Zod-validated DAG: step / set / cond / signal / terminate) + pure interpreter; `RunnableWorkflow` replaces the hardcoded `EngineeringWorkflow`; seeded `default-engineering@v1` template preserves the old behavior. |
| Workflow-engine Phase 2 — quality gates + onFail policy + gate-fix loop                               | Done   | #14   | Six gate steps (lint / typecheck / tests / build / vulnScan / perfBench) with `onFail: block \| warn \| { retry: N }`; `executeGateFixImplementation` closes the loop; `Repository.gateCommands` for per-repo overrides.              |
| Workflow-engine Phase 3 — fan-out + decomposition + branch merging                                    | Done   | #15   | `fanOut` node (sealed child contexts, `exports`, `pluck`, `onBranchFail`); `planDecomposition` Mastra agent → `Subtask[]`; `mergeBranches` activity (real `git merge`, aborts on conflict). Sequential per branch; parallel is 3.5.   |
| Workflow-engine Phase 3.5 — parallel fan-out + conflict resolution                                    | Done   | #16   | Concurrency-bounded worker pool in `runFanOut` (default 4, max 20); `resolveMergeConflict` activity reuses the implementer agent; `mergeBranches.unmergedBranches` chains the resolver after a conflict.                            |
| Workflow-engine Phase 4 — web editor + run viewer                                                     | Done   | —     | `/templates` editor (JSON spec + SVG DAG viz + version sidebar + promote), `/templates/[id]/runs`, `/runs/[id]` live viewer; gateway CRUD + step-registry catalog; step registry relocated to `packages/shared`.                     |
| Workflow-engine Phase 5 — versioning UI + per-team A/B + analytics                                    | Done   | —     | Version diff viewer, A/B experiment routing (`experimentVersion` + `experimentSplit`), per-template analytics (success rate, p50/p95, $/run, per-step failure rates), observed-cost chip on editor.                                  |
| Workflow-engine Phase 6 — custom shell steps with RBAC + audit                                        | Done   | —     | Per-step ephemeral container (`--network=none`, workspace-only writable), team-admin-only authoring, image allowlist on `Team.shellImageAllowlist`, `WorkflowShellAudit` table.                                                      |
| Workflow-engine Phase 7 — first-class in Slack + CLI                                                  | Done   | —     | `/auto-swe` slash command (workflows list/show + run modal), per-step Slack failure notifications, new `packages/cli/` workspace (`auto-swe workflows list/show/export/import`).                                                     |
| Workflow-engine Phase 8 — ergonomics + memory + cost denorm + cancellation                            | Done   | —     | Personal access tokens, CLI `runs` + `tokens` subcommands, Slack success notifications, `recordLessonDirectly` for resolver/shell steps, `WorkflowRun.costUsdAccrued` denormalization, A/B significance hint, fan-out cancellation.  |
| Workflow-engine Phase 9 — analytics UI + CLI run + cancel run                                        | Done   | —     | `/analytics` global page, A/B winner badge on template analytics, `auto-swe run` CLI subcommand, cancel-run API (`POST /workflow-runs/:id/cancel`) + web UI button.                                                                  |
| Web redesign — "Workshop Telemetry"                                                                   | Done   | —     | Dark warm-ink surface, single terracotta accent, Fraunces × IBM Plex Sans × JetBrains Mono via `next/font`. New primitives (`Button`, `Input`, `Stat`, `PageHeader`, `SectionHeader`, `Card` variants), redesigned `Sidebar` / `TopBar` / `AppShell` chrome, dark-mode Recharts via `chartChrome.tsx`. Login + dashboard rebuilt as exemplars; interior pages cascade through the new tokens. Screenshots in `docs/redesign/`. |
| Visual workflow template editor — React Flow + dagre + drag-to-create                                 | Done   | —     | `WorkflowDag` rewritten on `@xyflow/react` (pan / zoom / minimap / fit-view + multi-source handles per cond / signal / fanOut). New `TemplateEditor` adds drag-from-palette node creation, drag-to-connect edges, schema-aware right-rail inspector with explicit edge dropdowns. Dagre network-simplex layout replaces the custom BFS — branchy graphs render as proper multi-row hierarchies. 5 curated starter specs on `/templates`. Sub-pages (runs / diff / analytics) redesigned to match. |
| Browser sign-in via better-auth — GitHub / Google / magic-link / email-password                       | Done   | —     | `better-auth` mounted at `/api/auth/*` on Fastify with email+password, GitHub, Google, and 10-min magic-link. SMTP / Resend / console magic-link transports. Cookie-based browser sessions; `requireAuth` has a third validation path with 60s in-memory cache. Existing PAT + JWT-bearer paths untouched for CLI/API use. Linked-accounts settings page; `db:seed:auth` provisions the credential Account for the seeded admin. Production secret guards on `BETTER_AUTH_SECRET` / `JWT_SECRET`. Setup guide in `docs/oauth-setup.md`. |
| UI coverage closure — work-request modal, onboarding panel, repo / team / PAT / epic / lesson-search / runs-list management | Done | — | New `Modal` primitive + 11 hooks bring every previously API-only endpoint onto the dashboard: `+ Submit work request` on the dashboard / `/workflows`; new-user onboarding panel (Step 01 connect-repo, Step 02 first-request CTA, Step 03 watch-it-run, collapsible curl); `/repositories` add+edit forms; `/settings → API tokens` (create / list / revoke with one-time secret reveal); `/teams` create + edit + add member + inline role change + shell-image allowlist editor; `/epics` multi-repo create form; `/lessons` search bar; new `/runs` global run history with status+template filters. Only endpoints still API-only are the external webhooks and the legacy `POST /users` (invite is preferred). |
| Prisma migration consolidation — clean init + HNSW                                                    | Done   | —     | Squashed 4 drift-laden migrations (broken `_add_better_auth_tables` that only dropped the HNSW index, plus the re-add and a repair migration) into one canonical init generated from `schema.prisma` + a separate HNSW-index migration. Verified against a fresh DB. Other devs must `migrate reset` before pulling.                                                                                                                                                                                                                       |
| DB-backed LLM model + credential configuration                                                       | Done   | —     | Moved model selection and provider API keys out of env vars into Postgres. New tables (`ModelRoleConfig`, `ProviderCredential`, `ConfigAuditLog`) + AES-256-GCM crypto helpers + 3-level scope cascade (workflow-template → team → global → env fallback). Worker resolver pulls `{teamId, workflowTemplateId}` from `currentWorkflowId()`; no plumbing changes to activity inputs. Gateway admin + team-owner CRUD routes with SSRF-guarded credential probe and concurrency-safe upserts. Dashboard at `/admin/model-config` (tabs: Roles, Credentials, Audit log) plus team-detail page integration. Env vars are now first-boot-seed-only via `seedConfigFromEnv()`. See `docs/model-configuration.md`. |

---

## Summary

| Phase     | Planned Features | Done   | Partial | Not Started |
| --------- | ---------------- | ------ | ------- | ----------- |
| Phase 1   | 10               | 10     | 0       | 0           |
| Phase 2   | 10               | 10     | 0       | 0           |
| Phase 3   | 14               | 14     | 0       | 0           |
| Phase 4   | 12               | 11     | 0       | 1           |
| Post-MVP  | 6                | 6      | 0       | 0           |
| **Total** | **52**           | **51** | **0**   | **1**       |

> "Post-MVP" covers items added after the original plan: the Workshop Telemetry web redesign, the React Flow visual workflow editor, the better-auth multi-provider sign-in migration, the UI-coverage closure pass (one-stop admin/engineer surface on the dashboard), the Prisma migration consolidation, and the DB-backed LLM model + credential configuration.

### Not started (full list)

1. KEDA autoscaling — N/A: project uses Docker Compose, not Kubernetes
