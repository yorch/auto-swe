# AGENTS.md — Project Guidelines for AI Agents

> Guidelines for any AI agent (Claude Code, Codex, Copilot, Cursor, etc.) working on this codebase.

---

## 1. Project Overview

**auto-swe** is an autonomous agentic software engineering system built as a Yarn 4 TypeScript monorepo. It accepts work requests (external ticket IDs from any issue tracker), runs LLM-powered agents to implement code in isolated Docker workspaces, reviews changes via a multi-agent review network, opens pull requests, and waits for human merge. It includes better-auth sessions + personal-access-token auth with RBAC, team management, Slack integration, a CI self-healing loop, semantic memory (pgvector), and a Next.js web dashboard.

---

## 2. Design Documents

**Current and living references** — these match the running code:

| Document                         | Status  | Covers                                                                                     |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `docs/platform-pivot.md`         | Done | RFC + roadmap (rev. 2, libraries-first) for the platform pivot (SWE-system → generic durable workflow orchestration platform; SWE becomes seed content). **All phases done: P0 + P1 + P1.5 + P2 + P3 + P4 + P5. P2 in full: agent node (WS1) + `'mcp'` tool key (WS2) + full MCP integration — `mcp` Connection, binding across all implementer activities + the generic agent node, admin write-path (WS3) + `mcp` workflow node (WS4) + canvas palette/inspector (WS5). P4 (distribution layer: bundles + install + signature trust + container-contract coded steps + authoring SDK). P5 (UX/multi-org): multi-org foundation + org-level RBAC (`OrganizationMembership`/`OrgRole`) + application-layer row isolation + org-granularity billing (`OrgMonthlyUsage` + `monthlyBudgetUsdCents` caps) + authoring-SDK polish + canvas org-scope polish.** Per-phase build plans + live status in `docs/platform-pivot-p0.md`, `-p1.md`, `-p1.5.md`, `-p2.md`, `-p3.md`, `-p4.md`, `-p5.md` |
| `docs/platform-pivot-p2.md`      | Done       | P2 build plan (declarative `agent` node + MCP): WS1 (agent node) + WS2 (`'mcp'` tool key) + WS3 (full MCP: `mcp` Connection, binding across all implementer activities + the generic `runAgentNode`, admin write-path at `/admin/mcp-connections` + `mcpConnectionId` agent field) + WS4 (`mcp` workflow node → `mcpCallTool`) + WS5 (canvas palette + `McpSection` inspector). All 5 work-streams complete |
| `docs/platform-pivot-p4.md`      | Done | P4 build plan (distribution layer): WS1 bundle format + export · WS2 install as managed base layer · WS3 signature trust + registry + install-from-URL · WS4 container-contract coded steps · WS5 authoring SDK (`packages/sdk`). All 5 merged (#76) |
| `docs/platform-pivot-p5.md`      | Done | P5 build plan (UX layering + multi-org): multi-org foundation + `ORGANIZATION` config scope + org-level RBAC (`OrganizationMembership`/`OrgRole`) + application-layer row isolation + org-granularity billing (`OrgMonthlyUsage` + `monthlyBudgetUsdCents`) + authoring-SDK polish + coded-step transports + canvas org-scope polish. Merged (#91, #102) |
| `docs/product-overview.md`       | Current    | Product thesis, target users, business value, capability map, the 8 primary use cases, differentiators, non-goals, maturity |
| `docs/architecture.md`           | Current    | System context, package map, request lifecycle, workflow engine (15 node types), runtime security scanners, budget tiers, auth, data model, infra   |
| `docs/agents.md`                 | Current    | All 10 SWE agent roles (+ the eval-infra `evalJudge`), implementer tools (incl. `loadSkill`), 27 built-in skills, `AgentTracer` observability pattern, skill + tool assignment API reference |
| `docs/deployment.md`             | Living     | Production deployment runbook (env vars, DB + Temporal setup, image build, service layout, smoke test, day-2 ops, hardening) |
| `docs/model-configuration.md`    | Living     | DB-backed model + credential config (scope cascade, encryption, day-2 ops)                |
| `docs/oauth-setup.md`            | Living     | GitHub + Google OAuth app registration; magic-link setup                                   |
| `docs/slack-app-setup.md`        | Living     | Slack app manifest import and admin configuration                                          |
| `docs/github-app-setup.md`       | Living     | GitHub App creation, permissions, installation ID, admin UI config, auth mode options      |
| `docs/hitl-workflows.md`         | Living     | HITL node types (approval/decision/input/review), signal flow, inbox UI, API reference     |
| `docs/evals.md`                  | Current    | Evals RFC + roadmap: native output-quality measurement as an `eval` workflow node + DB-backed signals. P0 signal capture · P1 offline regression harness (frozen benchmark, paired error-barred stats) · P2 LLM judge + decision rule · P3 online drift dashboard + canary. Per-phase build plans in `docs/evals-p0.md`…`-p3.md` |
| `docs/claude-tag.md`             | In progress | Claude-Tag-style Slack channel teammate: one shared `@Claude` per channel. Adds `SlackWorkspace`/`SlackChannel`/`ChannelMonthlyUsage` models + a `CHANNEL` config-scope tier (`WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL`). **Shipped:** foundation + Phase 0 (`@mention` → `ChannelAssistantWorkflow` → in-thread reply via `/api/v1/auth/slack/events`) + Phase 1 (per-channel agent/tool scoping, admin CRUD at `/admin/slack-channels`, soft budget caps). **Planned:** P2 channel-scoped team memory · P3 ambient mode · P4 multiplayer polish |

**Historical** — preserved for design rationale; code is authoritative where they diverge:

| Document                          | Drift note                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `docs/configurable-workflows.md`  | Completed roadmap — all 9 phases done; 39 architecture decisions preserved for rationale              |
| `docs/mvp-architecture.md`        | `EngineeringWorkflow` replaced by `RunnableWorkflow` + seeded spec (Phase 1)                          |
| `docs/gateway-and-auth.md`        | RS256 framing outdated — HS256 is the Docker Compose default; better-auth cookie path added post-Phase 4 |
| `docs/data-and-infra.md`          | Schema section outdated (actual: 40 models in `packages/shared/src/prisma/schema.prisma`); DinD section is accurate |
| `docs/workflow-and-activities.md` | `EngineeringWorkflow` pseudocode; activity list pre-dates the configurable-workflow engine            |
| `docs/wireframes.md`              | Shipped UI in `packages/web/src/app/` is authoritative; "Workshop Telemetry" redesign post-Phase 4   |
| `docs/platform-pivot-p0.md`       | Completed build plan (P0 — de-domainify the engine: enum→string, step registry, `AgentSpec`+`runAgent`, computed `assertConfigReady`). Current state lives in `architecture.md`/`agents.md`           |
| `docs/platform-pivot-p1.md`       | Completed build plan (P1 — Agent library: first-class `Agent` + `resolveAgent`, versioning + run snapshot, governed CRUD API + UI). Current state in `agents.md`                                       |
| `docs/platform-pivot-p1.5.md`     | Completed build plan (P1.5 — retire the role tables; `Agent` is the sole source of truth). Current state in `agents.md`                                                                                 |
| `docs/platform-pivot-p3.md`       | Completed build plan (P3 — generic Connections/inputs/triggers/memory: `MemoryItem`←`AgentLesson`, `Connection`←`Repository`, template `inputSchema` + `RunInput`, trigger mappings). Current state in `architecture.md` |
| `docs/REPO_REVIEW.md`             | One-shot multi-agent repository audit (2026-06-09, commit `9778506`). Nearly all findings remediated (see its §7); preserved as a point-in-time snapshot, not a live tracker |

---

## 3. Tech Stack

| Component             | Technology                             | Version                |
| --------------------- | -------------------------------------- | ---------------------- |
| Runtime               | Node.js                                | >=24.0.0               |
| Package Manager       | Yarn 4 (Berry, via corepack)           | 4.16.0                 |
| Language              | TypeScript                             | 6.0.3                  |
| HTTP Framework        | Fastify                                | 5.8.5                  |
| Orchestration server  | Temporal (Docker images)               | temporalio/server:1.31.0 + admin-tools 1.31 + ui 2.49.1 |
| Orchestration SDK     | @temporalio/{client,worker,workflow}   | 1.17.2                 |
| Agent Framework       | Mastra                                 | 1.40.0                 |
| LLM SDK               | Vercel AI SDK + provider adapters      | ai 6.x; @ai-sdk/{anthropic,openai,google,openai-compatible} |
| ORM                   | Prisma                                 | 7.8.0                  |
| Database              | PostgreSQL 18 + pgvector               | pgvector/pgvector:pg18 |
| Web Dashboard         | Next.js + React + Tailwind CSS         | 16.2.7 / 19.2.7 / 4.3.0 |
| Server State          | TanStack Query                         | 5.101.0                |
| Client State          | Zustand                                | 5.0.14                 |
| Validation            | Zod                                    | 4.4.3                  |
| Testing               | Vitest                                 | 4.1.8                  |
| Lint / Format         | Biome                                  | 2.4.16                 |
| Observability         | OpenTelemetry + Grafana LGTM (local)   | grafana/otel-lgtm:0.8.1 |

---

## 4. Package Map

Per-package conventions worth knowing up front. Run `ls packages/<name>/src` for the actual layout — only non-obvious rules live here.

| Package            | Purpose                                              | Critical conventions                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`  | Prisma schema, DB client, shared types               | Singleton `PrismaClient` exported from `db.ts`; types re-exported via `index.ts` barrel; `prisma/` holds `schema.prisma`, `seed.ts`, migrations; `skills/` holds built-in skill definitions (one file per skill, mirroring `workflow/templates/`) |
| `packages/gateway` | Fastify 5 HTTP API (auth, RBAC, routes, webhooks)    | All extensions use `fastify-plugin`; Zod validation via `fastify-type-provider-zod`; Octokit lives in `lib/github.ts`; entry point `src/index.ts`                                              |
| `packages/worker`  | Temporal worker + Mastra agents                      | **`src/workflows/*` runs in a V8 isolate — `import type` only for external pkgs.** Activities are the deterministic boundary; agents/embeddings/models are imported FROM activities, never from workflows |
| `packages/web`     | Next.js 16 dashboard (App Router)                    | TanStack Query for server state, Zustand for client state; `app/page.tsx` is the dashboard home                                                                                               |
| `packages/cli`     | `auto-swe` CLI (workflows, runs, tokens; `bundle` local authoring + `bundles` distribution) | ESM Node 24+; auth via `AUTO_SWE_TOKEN` (personal access token from Settings → API tokens); thin fetch wrapper over the gateway REST API. **`bundle init/validate/sign`** is token-free local authoring over `@auto-swe/sdk` (P5); **`bundles list/export/install/install-from-url`** hits `/api/v1/admin/bundles` (P5) |
| `packages/sdk`     | `@auto-swe/sdk` — bundle authoring SDK (P4/WS5)      | Pure, I/O-free helpers over `@auto-swe/shared/bundle`: `defineAgent`/`defineSkill`/`defineTemplate`/`defineContainerStep`, `defineBundle` (+ content hash), `signBundle` (ed25519), `validateBundle` (schema + hash harness) |

Top-level files that matter:

- `docker-compose.infra.yml` — postgres + postgres-temporal + temporal (server + admin-tools + ui) + MinIO (artifact store) + setup containers
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
- **Temporal workflows:** `@temporalio/testing` TestWorkflowEnvironment (time-skipping) with fake activities — see `packages/worker/src/workflows/runnable.workflow.test.ts`. The shared interpreter is additionally unit-tested directly. First run downloads the test-server binary.
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

# Docker (infra = postgres + postgres-temporal + temporal (server + admin + ui) + minio; app = gateway + worker + web + otel-lgtm)
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

The project uses `@mastra/core@1.40.0` with the Vercel AI SDK for model binding:

- `Agent` constructor requires both `id` and `name` fields
- `createTool()` requires `outputSchema` on all tools (structured output)
- Tool execute functions return structured objects matching `outputSchema`
- Model binding: **always use `getModel(role)` from `packages/worker/src/lib/models.ts`** — never call `anthropic('...')` / `openai('...')` directly in agent code. Provider selection is config-driven.
- Structured generation: `agent.generate(messages, { output: zodSchema })`

### System Config (Integrations)

GitHub, Slack, artifact storage, issue-tracker connector, workflow defaults, and OAuth credentials are stored encrypted in the DB and managed via the admin UI. Code uses `resolveXxxConfig()` from `packages/shared/src/lib/systemConfig.ts` — DB-primary with env-var fallback for backwards compat. **Never read these from `process.env` directly in new code.**

| Admin page | What it manages | Resolver |
|---|---|---|
| `/admin/integrations → GitHub` | PAT, webhook secret, GHE URLs, OAuth app creds | `resolveGitHubConfig()` |
| `/admin/integrations → Slack` | bot token, client ID/secret, signing secret | `resolveSlackConfig()` |
| `/admin/integrations → Storage` | S3 backend, bucket, region, credentials | `resolveStorageConfig()` |
| `/admin/integrations → Tracker` | issue-tracker connector (Jira / Linear / GitHub Issues): provider, base URL, API token, Jira email — a read-only fetch at work-request submit time populates `ContextSnapshot.rawTicketData`; failures never block submission | `resolveTrackerConfig()` |
| `/admin/integrations → OAuth` | Google OAuth client ID/secret | `resolveGoogleOAuthConfig()` |
| `/admin/workflow` | branch prefix, PR templates, default team slug, lesson consolidation schedule, eval-regression schedule | `resolveWorkflowDefaults()` / `resolveConsolidationConfig()` / `resolveEvalScheduleConfig()` |

All six tables follow the singleton pattern (single row, `id = 'default'`, enforced by `CHECK` constraint). Encrypted fields use the same AES-256-GCM envelope as `ProviderCredential` — `CONFIG_ENCRYPTION_KEY` is required. Resolvers are in `packages/shared/src/lib/systemConfig.ts` (exported via `@auto-swe/shared/lib/systemConfig`).

**Restart-required changes:** `initAuth()` in `betterAuth.ts` reads OAuth creds once at startup. Changing GitHub OAuth or Google OAuth credentials requires a gateway restart.

### Agent Skills and Tool Access

Skills and tool configs are managed at `/admin/skills` and `/admin/agents` (admins), or per-team from `/teams/<id>` (team owners), or per-template from `/templates/<id>` (admins).

- **Skill** = named prompt fragment (`promptText`) injected into the agent system message at invocation time. Controls *how* an agent reasons. Built-in skills live in `packages/shared/src/skills/` (one file per skill); the seed creates them as `isBuiltIn: true` and `isVerified: true`. Custom skills are created with `isVerified: false`; the flag is reset to `false` whenever `promptText` is updated. Custom `promptText` is scanned for injection/exfiltration patterns by `scanSkillContent` (`packages/shared/src/lib/skillScanner`) — non-blocking; returns warnings. Scan patterns live in the `ScannerPattern` table (25 built-in INJECTION/EXFILTRATION patterns used by this scanner, 52 total across all scanner types, admin-extensible at `/admin/scanner`). Safe flag subset: `i`, `m`, `s`, `u`, `v` — `g`/`y` are rejected to prevent stateful `lastIndex` bugs.
- **Tool** = executable Mastra `createTool()` function. The implementer has four configurable workspace tools (`readFile`, `writeFile`, `listDirectory`, `bash`) listed in `IMPLEMENTER_TOOL_IDS` and controlled by the resolved `Agent`'s `toolKeys` (P1.5: replaced the `AgentToolConfig` table). A fifth tool, `loadSkill`, is automatically added when skills are present — it is **not** configurable via `toolKeys`. `null` `toolKeys` = all four workspace tools enabled. A sixth, `'mcp'` pseudo-key (P2/WS2; in `AGENT_TOOL_KEYS` but not `IMPLEMENTER_TOOL_IDS`) gates MCP tool loading: when an Agent lists `'mcp'` in `toolKeys` **and** references an active `mcp` Connection via `Agent.mcpConnectionId`, that server's tools bind at run time (`resolveAgentMcpUrl` → `loadMcpTools`) — for all three implementer activities (via `buildImplementerForActivity`) **and** the generic `runAgentNode` agent node. Admins manage `mcp` Connections at `/admin/mcp-connections` and attach one to an Agent via the `mcpConnectionId` field on the agent-library form. See `docs/agents.md` §3.5.

**Agent identity** is a free-form `string` (`AnySkillRole = string`; the `AgentRole` enum + `SkillOnlyRole` union were removed in P0/P1). `loadAgentSkills`/`loadAgentToolConfig` accept any key. The seeded SWE keys group as:
- **Model-backed roles (6):** `implementer`, `reviewer`, `planner`, `securityReview`, `validateContext`, `commitToMemory` — each has a GLOBAL `Agent` with a `modelSpec` (seeded). Note: `securityReview` is a legacy role preserved for forward compatibility; the canonical security analysis path is the three-agent **review network** (`runReviewNetwork`) which uses the `reviewer` model for all sub-agents.
- **Sub-role personas (4):** `securityReviewer`, `domainLogicReviewer`, `performanceReviewer`, `decomposer` — their `Agent` has no `modelSpec`; it carries `inheritsModelFrom` (→ `reviewer` / `planner`) so `resolveAgent` binds the parent's model.

**First-class `Agent` entity (single source of truth since P1.5):** the `Agent` table holds per-role model/prompt/skills/tools — the legacy `ModelRoleConfig` / `AgentSkillAssignment` / `AgentToolConfig` tables were **removed** in P1.5. `resolveAgent(key, ctx)` (`lib/config/agentResolver.ts`) is the sole resolver: most-specific active version (cascade + run-start `WorkflowRun.agentVersions` pin or explicit `key@version`), model via `modelSpec`/`inheritsModelFrom`, skills via `skillRefs`, tools via `toolKeys`. `getModel`/`getModelSpec`/`loadAgentSkills`/`loadAgentToolConfig` are shims over it. `resolveAgentSpec` (`agentSpec.ts`) → `AgentSpec` → the generic `runAgent` activity. Library API `/api/v1/admin/agent-library`, UI `/admin/agents/library`. The declarative **`agent` workflow node** (P2) dispatches `agentRef` to the `runAgentNode` activity.

**Progressive disclosure (implementer agent):** The implementer receives a compact L1 menu (skill name + description) in its system prompt and calls the `loadSkill` tool to fetch full `promptText` on demand — avoids injecting all skill text upfront. Reviewer sub-agents and planner/decomposer receive skill fragments directly in the system prompt.

**Scope cascade** for skills and tool configs follows the same 4-level pattern as model config (P5 added the `ORGANIZATION` tier between `TEAM` and `GLOBAL`):
1. `WORKFLOW_TEMPLATE` scope (if the run's template has an override)
2. `TEAM` scope (if the team has an override)
3. `ORGANIZATION` scope (P5; if the run's team belongs to an org with an override — `ctx.orgId` is derived transitively from `Team.orgId`)
4. `GLOBAL` scope (system-wide; built-in skills are seeded here)

Files: `packages/worker/src/lib/config/agentSkills.ts` (`loadAgentSkills`, `loadAgentToolConfig`, `skillsToPromptSuffix`), `packages/worker/src/lib/config/types.ts` (`AnySkillRole = string`; re-exports `ModelBackedAgentKey` from `@auto-swe/shared/agentKeys`), `packages/worker/src/lib/config/resolver.ts` (`resolveProviderCredential`, `resolveEmbeddingConfig`), `packages/worker/src/lib/config/agentResolver.ts` (`resolveAgent` — P1 Agent overlay; surfaces `mcpConnectionId`), `packages/worker/src/lib/config/agentSpec.ts` (`resolveAgentSpec`), `packages/worker/src/lib/config/agentRef.ts` (`parseAgentRef`), `packages/worker/src/lib/config/mcpConnection.ts` (`mcpUrlForConnection`, `resolveAgentMcpUrl` — P2/WS3), `packages/worker/src/agents/mcpTools.ts` (`loadMcpTools`, `isMcpToolEnabled`, `MCP_TOOL_KEY`), `packages/worker/src/activities/runAgent.ts` + `runAgentNode.ts`, gateway `packages/gateway/src/lib/agentLibraryService.ts`, `packages/shared/src/lib/skillScanner.ts`. Full API reference: `docs/agents.md`.

Note: `Agent` (and `ProviderCredential`) use partial unique indexes per scope — Prisma cannot express `WHERE scope = …` in upsert, so code uses `findFirst + conditional create` (not `upsert`) for GLOBAL-scope rows.

---

### Runtime Security Scanners

Six scanners run during agent execution. Each is independently advisory or blocking:

| Scanner | Stage | Type | Source |
|---|---|---|---|
| **Skill content scanner** | Skill save + LLM output per TDD iteration | Advisory | DB-backed `INJECTION`/`EXFILTRATION` patterns (60 s TTL) via `skillScanner.ts` |
| **Shell command scanner** | Pre-exec of every `bash` tool call | Soft-block | DB-backed `SHELL_COMMAND` patterns via `shellCommandScanner.ts`; returns error string to agent |
| **Sensitive file scanner** | Pre-write of every `writeFile` call | Hard-block | DB-backed `SENSITIVE_FILE` patterns via `sensitiveFileScanner.ts`; 6 built-in rules (`.env`, PEM/key files, SSH keys, credentials JSON); admin-extensible |
| **Pre-write content scanner** | Pre-write of every `writeFile` call | Soft-block | Regex rules in `preWriteSecurityCheck.ts`; tags trace error with `SECURITY_CHECK_FAILED_PREFIX` / `SECURITY_WARNINGS_PREFIX` |
| **Code security scanner** | Post-commit diff scan | Advisory | DB-backed `CODE_SECURITY` patterns via `codeSecurityScanner.ts`; findings flow through `CodeResult.codeSecurityFindings` to security reviewer |
| **LLM output scanner** | Post-generate per TDD iteration | Advisory | `scanSkillContent` (INJECTION/EXFILTRATION patterns); wrapped in try/catch — DB failure must not abort the activity |

**Pattern cache:** `shellCommandScanner`, `codeSecurityScanner`, and `sensitiveFileScanner` use `makePatternLoader()` from `scannerPatternLoader.ts` — a per-instance 60 s TTL factory that eliminates per-module cache boilerplate. Gateway and worker are separate processes — cache invalidation from pattern edits applies only via TTL expiry (no cross-process invalidation).

**Built-in patterns:** 52 patterns in `packages/shared/src/scannerPatterns/index.ts` — 14 INJECTION, 11 EXFILTRATION, 11 SHELL_COMMAND, 10 CODE_SECURITY, 6 SENSITIVE_FILE. Synced via `syncBuiltins()` at gateway startup (idempotent). Built-in patterns have `isBuiltIn: true`.

**Security events:** Scanner blocks tag `AgentTrace.error` with specific prefixes; advisory events write named `activity_event` rows (`'code_security.scan'`, `'llm.suspicious_output'`). The `GET /api/v1/admin/security-events` endpoint uses DB-level predicates per `SecurityEventType` so pagination is correct. See `/admin/security` (global dashboard) and `/runs/[id]` (per-run panel).

**Safe flag subset:** Regex flags accepted at the API: `i`, `m`, `s`, `u`, `v`. Flags `g` and `y` are rejected to prevent stateful `lastIndex` bugs in cached RegExp objects.

---

### Multi-Model Support

Model selection and provider credentials are fully DB-driven. Per-agent **model selection** (each agent's `modelSpec`) lives on the first-class `Agent`, managed at `/admin/agents/library` (admins) or per team from `/teams/<id>` (team owners); **provider credentials** and the **embedding model** are managed at `/admin/model-config`. There are no model/credential env vars; the worker refuses to start until the DB has every required row (verified by `assertConfigReady()` at boot).

**Scope cascade** at activity-call time (worker's `resolveAgent(key, ctx)`):

1. `WORKFLOW_TEMPLATE` row matching the run's template ID, if any
2. `TEAM` row matching the work request's team, if any
3. `ORGANIZATION` row matching the team's owning org, if any (P5; `ctx.orgId` derived from `Team.orgId`)
4. `GLOBAL` row (system-wide default — required for every role)

No fallback past GLOBAL — missing rows throw `ConfigMissingError`. The worker boot's `assertConfigReady()` walks every required row before the Temporal poller starts. The `ORGANIZATION` tier is consulted only when the run's team belongs to an org, so deployments that never create orgs behave exactly as the 3-level cascade did.

**Org multi-tenancy (P5):** the `Organization` boundary also carries RBAC and billing. `OrganizationMembership` (with the `OrgRole` enum: `ORG_ADMIN` / `ORG_MEMBER`) is the real access gate, enforced declaratively by the `requireAuth` onRequest hook: `requireAuth({ requiredOrgRole: 'ORG_MEMBER' | 'ORG_ADMIN', orgIdParam: 'orgId' })` resolves the membership for the route's `:orgId` param and checks the org role (`ORG_ADMIN` > `ORG_MEMBER`) — mirroring the team-scoped `requiredTeamRole`. So an `ORG_ADMIN` self-serves their own org regardless of platform role, and the platform `ADMIN` role bypasses the org check entirely. The one case the hook can't cover — work-request submission, where the org is derived from the target connection inside the handler rather than a route param — uses the `assertOrgAccess` helper (`packages/gateway/src/lib/orgAccess.ts`) inline (application-layer row isolation). Member CRUD lives at `/api/v1/admin/organizations/:orgId/members` and budget read/update at `/api/v1/admin/organizations/:orgId/budget`; both are surfaced in the `/admin/organizations/[orgId]` admin page. Billing aggregates per-org cost/runs/tokens into `OrgMonthlyUsage` — `finalizeWorkflowRun` runs the run-denormalize update + the `increment` upsert in one transaction, guarded by the pre-read `endedAt`, so a Temporal activity retry can't double-count (`runsCompleted` counts only `SUCCESS`; cost/tokens accrue for every terminal status). `Organization.monthlyBudgetUsdCents` caps monthly spend — work-request submit returns `402 ORG_BUDGET_EXCEEDED` when the current month's accrued cost meets or exceeds the cap. The month-bucket key (`currentYearMonth`, `'YYYY-MM'`) lives in `@auto-swe/shared/lib/billing` so the worker writer and gateway reader share one formula.

**Bootstrap flow** (fresh deployment):

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — creates the admin user.
2. Start gateway + web only.
3. The DB seed already created the 6 model-backed GLOBAL `Agent` rows (with default model specs) + the `EmbeddingConfig` singleton. Sign in as admin at `/admin/model-config → Credentials` and add a `ProviderCredential`.
4. Add at least one `ProviderCredential` for the providers the seeded specs reference (Anthropic by default; OpenAI for embeddings).
5. Go to `/admin/integrations → GitHub`. Enter the GitHub PAT and webhook secret. Save.
6. Configure any other integrations (Slack, Storage, OAuth) as needed.
7. Start the worker.

Per-role baked-in defaults (seeded onto the GLOBAL Agents by `syncAgents`):

| Role              | Default                       |
| ----------------- | ----------------------------- |
| `implementer`     | `anthropic/claude-opus-4-8`   |
| `reviewer`        | `anthropic/claude-opus-4-8`   |
| `planner`         | `anthropic/claude-sonnet-4-6` |
| `securityReview`  | `anthropic/claude-sonnet-4-6` |
| `validateContext` | `anthropic/claude-sonnet-4-6` |
| `commitToMemory`  | `anthropic/claude-opus-4-8`   |
| (embedding)       | `openai/text-embedding-3-large` |

**Spec format** is `<provider>/<model-id>`. Built-in providers: `anthropic`, `openai`, `google`. Any other provider name routes through `@ai-sdk/openai-compatible` and requires an `apiBase` on the credential row — covers OpenRouter, Ollama, vLLM, Groq, Cerebras, Inflection Pi, OpenCode Go, etc.

**Embeddings** have a dedicated singleton `EmbeddingConfig` table (one row, system-wide). The chosen model must produce 1536-dim vectors — `generateEmbedding` throws if it doesn't.

**Credentials** are stored AES-256-GCM encrypted in `provider_credentials.api_key_ciphertext`. The encryption key (`CONFIG_ENCRYPTION_KEY`, base64 32 bytes) is required to start gateway or worker — fail fast on missing/wrong-length. Rotation is not yet implemented; the `key_version` column is reserved for it.

**Mid-run config changes:** activities re-resolve their model on each call. An edit lands on the next LLM call within an already-running workflow rather than waiting for a fresh run. The dashboard surfaces this in a standing banner.

**Latest model IDs at the time of writing** (override defaults from the dashboard; pricing for these is in `MODEL_PRICES`):

| Provider  | Reasoning / heavy            | Balanced                    | Fast / cheap                            |
| --------- | ---------------------------- | --------------------------- | --------------------------------------- |
| Anthropic | `claude-opus-4-8`            | `claude-sonnet-4-6`         | `claude-haiku-4-5-20251001`             |
| OpenAI    | `gpt-5-5-pro`                | `gpt-5-5`                   | `gpt-5`                                 |
| Google    | `gemini-2.5-pro`             | `gemini-2.5-flash`          | `gemini-3.1-flash-lite-preview` / `gemini-2.5-flash-lite` |

Deprecation warning: `claude-sonnet-4-20250514` (the previous default for planner / securityReview / validateContext) **retires 2026-06-15** — anyone with a custom env override pinned to that ID must migrate to `claude-sonnet-4-6` before that date.

### Cost Tracking

`packages/worker/src/lib/costTracking.ts` prices each call from `MODEL_PRICES` (USD per MTok). Unknown models fall back to zero cost and emit `llm.cost_pricing_known=false` on the OTel span — usage is still recorded so the workflow runs aren't lost. Add new entries to `MODEL_PRICES` as roles are routed to new models, or set per-model env overrides:

```
MODEL_PRICE_<PROVIDER>_<MODEL>=<input>:<output>   # USD per MTok, non-alphanumerics → _
```

`recordLlmUsage()` takes a `ModelBackedAgentKey` so the price is looked up via the same `getModelSpec()` the agent uses to bind its model.

### Embeddings

`packages/worker/src/lib/embeddings.ts` resolves its `<provider>/<model>` spec, API key, and (for OpenAI-compatible providers) `apiBase` entirely from the DB-backed `EmbeddingConfig` singleton via `resolveEmbeddingConfig()` — there are no `EMBEDDING_MODEL` / `<PROVIDER>_API_BASE` env vars (model + credential config is fully DB-driven; see `docs/model-configuration.md`). Built-in: `openai`; any other provider name is treated as an OpenAI-compatible endpoint and requires an `apiBase` on the credential row. Output **must** be 1536-dimensional — the `memory_items.embedding` column is fixed at `vector(1536)` and the helper throws if the model returns a different shape.

### Agent Observability (AgentTracer)

Every LLM-calling activity must use `AgentTracer` to record tool calls, LLM responses, and activity events. These are persisted as `AgentTrace` rows in the `agent_traces` table, linked to the `WorkflowRun`. The `/runs/[id]` viewer uses them to show the full tool-call sequence per activity attempt.

Pattern used in all LLM activities (`executeImplementation`, `commitToMemory`, `consolidateLessons`, `qualityGates`, etc.):

```typescript
const tracer = new AgentTracer();
try {
  // LLM calls, tool calls, and event recording:
  tracer.addToolCall({ toolName, inputJson, outputJson, durationMs, error? });
  tracer.addLlmResponse({ role, inputJson: { systemPrompt, userMessage }, outputJson, durationMs });
  tracer.addActivityEvent({ name, outputJson, durationMs?, error? });
  return result;
} finally {
  // Always runs — even if the LLM call throws:
  await persistActivityTrace(tracer, 'implementer');
}
```

`persistActivityTrace` from `packages/worker/src/lib/activityContext.ts` auto-resolves the `runId` and `attempt` from Temporal context. **Always call it in a `finally` block so traces are persisted even when the LLM call throws.** Calling it only on the success path silently drops all trace records when the activity fails — the run viewer will show no events for the failed attempt.

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

# 2. Start infrastructure (postgres + postgres-temporal + temporal + minio — otel-lgtm starts with the app overlay, not here)
cp .env.example .env    # Fill in CONFIG_ENCRYPTION_KEY, SEED_ADMIN_PASSWORD, and optionally GITHUB_TOKEN/GITHUB_WEBHOOK_SECRET as bootstrap fallbacks
yarn docker:infra:up

# 3. Database setup
yarn db:migrate && yarn db:generate && yarn db:seed
#  ↳ seeds the admin user, default team, sample repo, and default workflow
#    template. Re-running `yarn workspace @auto-swe/shared exec prisma migrate reset`
#    is the cleanest way to
#    start over locally (migrations consolidate into a single init + the
#    pgvector HNSW index migration; see packages/shared/src/prisma/migrations).

# 4. Start gateway + web first (worker needs GitHub config in DB before starting)
yarn dev:gateway         # Terminal 1 — http://localhost:8080
yarn dev:web             # Terminal 2 — http://localhost:3000

# 4b. Configure integrations in the admin UI
#    Sign in at http://localhost:3000 with admin@auto-swe.local + SEED_ADMIN_PASSWORD
#    → /admin/model-config → Credentials → add a provider credential (agents are seeded with default specs)
#    → /admin/integrations → GitHub → enter GITHUB_TOKEN + GITHUB_WEBHOOK_SECRET → Save
#    (or skip if GITHUB_TOKEN is set in .env — the env var fallback still works)

# 5. Start the worker
yarn dev:worker          # Terminal 3 — reads GitHub token from DB (or .env fallback)

# 6. Drive it from the dashboard
#    Either click "+ Submit work request" or follow the onboarding panel.
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
| Auth                         | better-auth sessions (browser) + PATs (CLI/CI); short-lived JWTs only via the session-token bridge | One identity store; PATs survive restarts; the legacy refresh-token rotation flow was removed (ARCH-4) |
| DinD over K8s                | `docker run`/`exec`                                       | No cluster needed; same isolation model, zero infra beyond Docker |
| PAT or GitHub App            | PAT for simplicity; GitHub App for production             | GitHub App: short-lived tokens, per-installation scope, full audit trail; admin UI at /admin/integrations |
| pgvector for memory          | Vector embeddings on MemoryItem                          | Semantic similarity search for agent context enrichment           |
| Yarn 4 `node-modules` linker | Not PnP                                                   | Maximum tool compatibility with Prisma, Temporal, Docker          |
