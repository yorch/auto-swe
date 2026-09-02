# AGENTS.md — Project Guidelines for AI Agents

> Guidelines for any AI agent (Claude Code, Codex, Copilot, Cursor, etc.) working on this codebase.
>
> **This file holds rules, not status.** It describes how to work in this repo — conventions,
> constraints, and the gotchas that cause real bugs. What shipped when lives in git history;
> what the system does lives in [`docs/`](./docs/README.md).

---

## 1. Project Overview

**auto-swe** is a durable, governed multi-agent workflow orchestration platform, built as a Yarn 4
TypeScript monorepo. Workflows are versioned JSON DAGs executed on Temporal; agents run inside
isolated Docker workspaces. Autonomous software engineering — ticket in, reviewed draft pull
request out — is the flagship use case, seeded as ordinary library content rather than privileged
runtime code.

The platform provides human-in-the-loop governance, a multi-agent review network, layered runtime
security scanning, semantic memory (pgvector), sandboxed container steps, and cost/budget control.
For the product framing see [`docs/product-overview.md`](./docs/product-overview.md); for how the
system is put together see [`docs/architecture.md`](./docs/architecture.md).

---

## 2. Documentation Map

| Location | Contains |
|---|---|
| [`docs/`](./docs/README.md) | **Living references** — how the system works now. Start at `docs/README.md`. |
| [`.claude/skills/`](./.claude/skills/) | **Load-on-demand gotchas** — narrow, high-cost traps that only matter while touching one thing. Read the matching skill before editing a Dockerfile or a Prisma migration. |
| [`docs/history/`](./docs/history/) | **Frozen** — completed roadmaps, closed build plans, point-in-time reviews, research. Preserved for rationale; the code wins wherever they diverge. |

Do not consult `docs/history/` to learn current behaviour, and do not update it.

Skills exist so this file does not have to carry every trap: a gotcha that costs a rebuild but only
applies to one file belongs in a skill, not in the context of every session.

| Skill | Read it before |
|---|---|
| [`prisma-docker-migrations`](./.claude/skills/prisma-docker-migrations/SKILL.md) | Editing `packages/*/Dockerfile`, or when a built image fails at boot on a missing Prisma dependency |
| [`prisma-pgvector-hnsw`](./.claude/skills/prisma-pgvector-hnsw/SKILL.md) | Changing `schema.prisma`, or running any `prisma migrate` command |

---

## 3. Tech Stack

| Component             | Technology                             | Version                |
| --------------------- | -------------------------------------- | ---------------------- |
| Runtime               | Node.js                                | >=24.0.0               |
| Package Manager       | Yarn 4 (Berry, via corepack)           | 4.18.0                 |
| Language              | TypeScript                             | 7.0.2                  |
| HTTP Framework        | Fastify                                | 5.12.1                 |
| Orchestration server  | Temporal (Docker images)               | temporalio/server:1.31.2 + admin-tools 1.31 + ui 2.53.3 |
| Orchestration SDK     | @temporalio/{client,worker,workflow}   | 1.22.0                 |
| Agent Framework       | Mastra                                 | 1.60.0                 |
| LLM SDK               | Vercel AI SDK + provider adapters      | ai 7.x; @ai-sdk/{anthropic,openai,google,openai-compatible} |
| ORM                   | Prisma                                 | 7.9.1                  |
| Database              | PostgreSQL 18 + pgvector               | pgvector/pgvector:pg18 |
| Web Dashboard         | Next.js + React + Tailwind CSS         | 16.3.1 / 19.2.8 / 4.3.3 |
| Server State          | TanStack Query                         | 5.101.4                |
| Client State          | Zustand                                | 5.0.15                 |
| Validation            | Zod                                    | 4.4.3                  |
| Testing               | Vitest                                 | 4.1.11                  |
| Lint / Format         | Biome                                  | 2.5.9                 |
| Observability         | OpenTelemetry + Grafana LGTM (local)   | grafana/otel-lgtm:0.30.2 |

---

## 4. Package Map

Run `ls packages/<name>/src` for the actual layout — only non-obvious rules live here.

| Package            | Purpose                                              | Critical conventions                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`  | Prisma schema, DB client, shared types, workflow spec + interpreter, config registry | Singleton `PrismaClient` exported from `db.ts`; types re-exported via the `index.ts` barrel; `src/prisma/` holds `schema.prisma`, `seed.ts`, migrations; `skills/` holds built-in skill definitions (one file per skill); `config/` holds the setting registry + its resolver and permission rules |
| `packages/gateway` | Fastify 5 HTTP API (auth, RBAC, routes, webhooks)    | All extensions use `fastify-plugin`; Zod validation via `fastify-type-provider-zod`; Octokit lives in `lib/github.ts`; entry point `src/index.ts`                                              |
| `packages/worker`  | Temporal worker + Mastra agents                      | **`src/workflows/*` runs in a V8 isolate — `import type` only for external packages.** Activities are the deterministic boundary; agents/embeddings/models are imported FROM activities, never from workflows |
| `packages/web`     | Next.js 16 dashboard (App Router)                    | TanStack Query for server state, Zustand for client state; `app/page.tsx` is the dashboard home                                                                                               |
| `packages/cli`     | `auto-swe` CLI                                       | ESM Node 24+; auth via `AUTO_SWE_TOKEN` (personal access token from Settings → API tokens); thin fetch wrapper over the gateway REST API. `bundle init/validate/sign` is token-free local authoring over `@auto-swe/sdk`; `bundles list/export/install` hits the admin API |
| `packages/sdk`     | `@auto-swe/sdk` — bundle authoring SDK               | Pure, I/O-free helpers over `@auto-swe/shared/bundle`: `defineAgent`/`defineSkill`/`defineTemplate`/`defineContainerStep`, `defineBundle` (+ content hash), `signBundle` (ed25519), `validateBundle` |

Top-level files that matter:

- `docker-compose.infra.yml` — postgres + postgres-temporal + temporal (server + admin-tools + ui) + Garage (`objectstore` profile) + setup containers
- `docker-compose.app.yml` — gateway + worker + web + otel-lgtm (overlay; not runnable standalone)
- `infra/` — helper scripts and Temporal dynamic config mounted into the temporal-setup containers
- `tsconfig.base.json` — shared TS config inherited by every package
- `vitest.config.ts` — root test runner; subpath aliases for `@auto-swe/shared/*` use array form (Vite prefix matching is order-sensitive)
- `biome.json` — single source of truth for lint + format
- `scripts/check-doc-drift.mjs` — CI doc-drift check (see §5)
- `.env.example` — environment variable template

---

## 5. Conventions

### Code Style

- TypeScript strict mode everywhere (`"strict": true` in tsconfig)
- Use `import type` for type-only imports — **critical** for Temporal workflow files (V8 isolate)
- Fastify plugin pattern (`fastify-plugin`) for all gateway extensions
- Zod schemas for request validation via `fastify-type-provider-zod`
- Boolean query params go through `booleanQueryParam()` (`gateway/src/lib/queryParams.ts`), never
  `z.coerce.boolean()` — coercion is `Boolean(input)`, so the string `false` arrives as `true` and
  the parameter silently means its opposite
- Prisma for all DB access — raw SQL (`$queryRawUnsafe`) only for pgvector operations (embeddings),
  plus the row/advisory-lock exception in §7
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

### Documentation

Docs describe the system **in present tense, as it is now**. This is a hard convention, because
prose has no compiler and status prose rots silently.

- **Never** write shipped-status, PR numbers, phase labels (`P2/WS3`), or "now shipped" narration
  into a living doc. That belongs in git history and the pull request.
- A roadmap or build-plan doc moves to `docs/history/` the day its work lands. It is frozen there,
  not maintained.
- **Before freezing a doc, sweep it for facts that are still true** — open gaps, items that never
  shipped, known limitations — and promote those into a living doc first. A roadmap is history; the
  fact that one of its items was never built is current state, and it must not be buried in a file
  nobody is supposed to read.
- **Known gaps live next to the feature**, in that doc's `## Limitations` section — never in a
  central list, which is what drifted before. Product-level boundaries and overall maturity are the
  exception and belong in `docs/product-overview.md` §7 and §8.
- **`yarn docs:check` is the compiler for the rules above.** Prose has no type system, so the
  checkable parts of these conventions are enforced in CI as their own job. It fails on:

  | Check | Source of truth |
  |---|---|
  | Countable claims — "15 node types", "61 Prisma models", "35 built-in skills" | `spec.ts`, `schema.prisma`, `skills/index.ts`, `scannerPatterns/`, `syncBuiltins.ts` |
  | Dependency versions in the tech-stack tables | every `package.json` (a truncated claim passes when it prefixes the real version) |
  | Forbidden status prose — phase labels, PR numbers, "now shipped", roadmap promises | the rules above (backticks and quotes are stripped first, so this file may quote what it bans) |
  | A capability doc with no `## Limitations` section | the gap-locality rule above |
  | Broken relative `.md` links, `docs/history/` included | the filesystem |

  Run it after changing the schema, the node-type union, the built-in skills, the scanner patterns,
  the seeded agents, or any dependency that a doc names by version.
- `docs/history/` is exempt from the check and from edits.

### Testing

- **Framework:** Vitest (`vitest.config.ts` at root)
- **Gateway routes:** Fastify's built-in `light-my-request` via `app.inject()`
- **Temporal workflows:** `@temporalio/testing` TestWorkflowEnvironment (time-skipping) with fake activities — see `packages/worker/src/workflows/runnable.workflow.test.ts`. The shared interpreter is additionally unit-tested directly. First run downloads the test-server binary.
- **Workflow determinism:** `runnable.replay.test.ts` replays committed history fixtures — one per control-flow shape (linear, fan-out, signal, HITL) — against current workflow code via `Worker.runReplayHistory`. Replay only guards paths a recorded history walked, so a new control-flow shape needs a new fixture. Running forward against fakes cannot catch a change that takes a *different path on replay* — the failure that strands a production workflow. **If it fails, do not re-record the fixture to make it pass**; re-record (`packages/worker/scripts/recordReplayHistory.ts`) only when the workflow's structure changed intentionally.
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
yarn db:migrate           # Create + apply a migration (dev)
yarn db:deploy            # Apply existing migrations (production)
yarn db:generate          # Generate Prisma client
yarn db:seed              # Seed admin user + sample repository
yarn db:studio            # Open Prisma Studio
yarn test                 # Run all tests (vitest)
yarn test:watch           # Vitest in watch mode
yarn lint                 # Lint + format check (biome check)
yarn lint:fix             # Auto-fix safe lint issues + format (biome check --write)
yarn format               # Format only (biome format --write)
yarn docs:check           # Fail on stale countable claims in the living docs

# Docker (infra = postgres + postgres-temporal + temporal + garage; app = gateway + worker + web + otel-lgtm)
yarn docker:infra:up      # Start infra services only
yarn docker:infra:down    # Stop infra services
yarn docker:app:up        # Start everything (infra + app)
yarn docker:app:down      # Stop everything
yarn docker:app:logs      # Tail logs (infra + app)
yarn docker:app:build     # Rebuild app images
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

The project uses `@mastra/core` with the Vercel AI SDK for model binding:

- `Agent` constructor requires both `id` and `name` fields
- `createTool()` requires `outputSchema` on all tools (structured output)
- Tool execute functions return structured objects matching `outputSchema`
- Model binding: **always use `getModel(key, ctx)` from `packages/worker/src/lib/models.ts`** — never call `anthropic('...')` / `openai('...')` directly in agent code. Provider selection is config-driven.
- Structured generation: `agent.generate(messages, { output: zodSchema })`

### System Config (Integrations)

GitHub, Slack, artifact storage, issue-tracker and knowledge-base connectors, Figma, workflow
defaults, and OAuth credentials are stored encrypted in the DB and managed via the admin UI. Code
uses `resolveXxxConfig()` from `packages/shared/src/lib/systemConfig.ts` — DB-primary with env-var
fallback. **Never read these from `process.env` directly in new code.**

| Admin page | Manages | Resolver |
|---|---|---|
| `/admin/integrations → GitHub` | PAT, webhook secret, GHE URLs, OAuth app creds | `resolveGitHubConfig()` |
| `/admin/integrations → Slack` | bot token, client ID/secret, signing secret | `resolveSlackConfig()` |
| `/admin/integrations → Storage` | S3 backend, bucket, region, credentials | `resolveStorageConfig()` |
| `/admin/integrations → Tracker` | issue tracker (Jira / Linear / GitHub Issues) | `resolveTrackerConfig()` |
| `/admin/integrations → Knowledge Base` | Confluence / Notion connector | `resolveKnowledgeBaseConfig()` |
| `/admin/integrations → Figma` | read-only Figma design connector | `resolveFigmaConfig()` |
| `/admin/integrations → OAuth` | Google OAuth client ID/secret; Okta SSO issuer + client ID/secret | `resolveGoogleOAuthConfig()`, `resolveOktaOAuthConfig()` |
| `/admin/workflow` | branch prefix, PR templates, default team slug, consolidation + eval schedules, CI wait strategy, Tier-2 defaults | `resolveWorkflowDefaults()` and friends |

Every config table is a singleton: one row, `id = 'default'`, enforced by a `CHECK` constraint.
Encrypted fields use the same AES-256-GCM envelope as `ProviderCredential`, so
`CONFIG_ENCRYPTION_KEY` is required to start either service.

**Tracker, knowledge-base, and Figma connectors** are fetched server-side at work-request submit
time and seed `ContextSnapshot`. They are best-effort: a failure never blocks submission. Each
carries an `allowPrivateNetwork` flag — an explicit opt-in required before the SSRF guard will
accept a self-hosted base URL on a private or internal address.

**Tier-2 resource & tuning defaults** live on the `WorkflowDefaults` singleton with a
`row?.x ?? default` fallback, so an unconfigured deployment keeps the built-in constants. They are
**GLOBAL-scope only** — not part of the per-team/-template cascade — and are edited at
`/admin/workflow`:

| Field(s) | Default | Consumed by |
|---|---|---|
| `budgetTiers` (6 columns → nested `{ tier: { inputTokens, outputTokens } }`) | STANDARD / LARGE / EPIC caps | `costTracking.ts` (`resolveBudgetTiers()`, falls back to `BUDGET_LIMITS`) |
| `maxTddIterations` / `maxEvalIterations` | 5 / 3 | `executeImplementation.ts` TDD loop / `evalHarness.ts` |
| `workspaceMemory` / `workspaceCpus` / `workspacePidsLimit` / `workspaceImage` | `4g` / 2 / 512 / `node:24-alpine` | `workspace.ts` container caps + default base image (an explicit `image` arg still wins) |
| `lessonRetrievalLimit` / `lessonRetrievalThreshold` | 5 / 0.7 | `executeImplementation.ts` `retrieveSimilarLessons` |
| `evalHealthMaxFlakeRate` / `evalHealthMaxStaleRate` / `evalHealthMinKappa` / `evalJudgeThreshold` | 0.1 / 0.1 / 0.4 / 0.5 | eval health gates / `runEvalNode.ts` judge scorer |
| `ciWaitMode` / `ciPollIntervalSec` / `ciPollGraceSec` / `ciPollDeadlineSec` | `signal` / 15 / 60 / 14400 | CI wait strategy. **Nullable** — a null column falls back to `CI_WAIT_MODE` / `CI_POLL_*`, so a deployment driving these from the environment keeps working until an admin saves |

The hot-path budget read is memoized behind the ~30 s config cache; coarser consumers
(`workspace.ts`, `evalHarness.ts`, `runEvalNode.ts`) call the resolver directly once per invocation
because they already sit behind a Docker or eval boundary.

**Per-entity knobs live on their own rows, not in the GLOBAL tier:** channel proactivity cooldowns
are nullable columns on `SlackChannel` (null = the worker's built-in default), and MCP per-connection
timeouts live on the `mcp` `Connection.config` JSON bag (`listTimeoutMs` / `callTimeoutMs`;
null = 15 s / 60 s).

**Restart required:** `initAuth()` in `betterAuth.ts` reads OAuth credentials once at startup.
Changing GitHub, Google, or Okta OAuth credentials requires a gateway restart. Okta is registered
through better-auth's `genericOAuth` plugin, whose `init` fetches the OIDC discovery document once
at startup — so the issuer is read at boot too, not per sign-in.

### Setting Registry (operator policy)

Knobs that are neither an integration credential nor bootstrap live in the **setting registry**:
one declaration per knob in `packages/shared/src/config/registry.ts` carrying its Zod schema,
default, the scopes it may be overridden at, the role required to change it, and whether it pins to
a run. That declaration is what validates a write, resolves a read, drives the `/admin/settings`
form, and gates permission — **adding a knob is a definition, not a migration plus a route plus a
form field.**

- Read with `resolveSetting(key, ctx)` / `resolveSettings(keys, ctx)` from
  `@auto-swe/shared/config`. **Never re-introduce a module-scope `const` for an operator-tunable
  value.** Pass the fullest scope context available — a lookup missing `teamId` silently resolves a
  broader value.
- A setting's identity is the property it is stored under in `SETTING_DEFINITIONS`; there is no
  `key` field to keep in sync.
- Where the knob also has a nullable column on its own entity (`SlackChannel.reactiveCooldownMinutes`),
  that column wins and the definition must **not** list that scope in `overridableAt` — otherwise the
  effective-config view reports an override the worker never reads.
- Resolution is `run pin → WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL → env var →
  default`, behind the same ~30 s cache as the agent resolver. A stored value that fails its schema
  degrades to the next tier rather than throwing.
- `runPinned: true` freezes the value into `WorkflowRun.pinnedSettings` at run start. Use it for
  anything a run makes a structural decision on — the interpreter bounds are pinned because the
  workflow isolate cannot read the DB and a replay must not take a different path.
- Storage is `config_settings`, one JSON value per `(key, scope)`, with **partial** unique indexes
  per scope — so writes use `findFirst` + conditional create, never `upsert`, exactly like `Agent`.
- Permissions are `config_permissions` rows, not code. `requiredRole` is a floor no grant can lower;
  ADMINs bypass grants; managing grants is ADMIN-only.

The singleton integration tables above are **not** absorbed into the registry — their shape is
relational and their secrets use the AES-GCM envelope. Full reference:
[`docs/configuration.md`](./docs/configuration.md).

### Agents, Skills, and Tool Access

**`Agent` is the single source of truth** for per-key model, prompt, skills, and tools. It is a
first-class, versioned entity; there are no separate role/skill/tool config tables.
`resolveAgent(key, ctx)` (`lib/config/agentResolver.ts`) is the **sole** resolver: it picks the
most-specific active version (cascade below, plus the run-start `WorkflowRun.agentVersions` pin or
an explicit `key@version` ref), binds the model via `modelSpec` or `inheritsModelFrom`, and loads
skills via `skillRefs` and tools via `toolKeys`. `getModel` / `getModelSpec` / `loadAgentSkills` /
`loadAgentToolConfig` are thin shims over it. `resolveAgentSpec` composes the result into an
`AgentSpec`, which the generic `runAgent` activity executes.

**Agent identity is a free-form `string`** (`AnySkillRole = string`) — there is no enum. New agents
are added as data, not code. Seeded built-ins split by how they bind a model:

- **Model-backed** (own `modelSpec`): `implementer`, `reviewer`, `planner`, `securityReview`,
  `validateContext`, `commitToMemory`, `channelAssistant`, `evalJudge`, `workflowAuthor`,
  `workflowExplainer`.
- **Sub-role personas** (`inheritsModelFrom`): `securityReviewer` / `domainLogicReviewer` /
  `performanceReviewer` (← `reviewer`); `decomposer` / `prdAnalyst` / `prdDecomposer` (← `planner`);
  `ciFixer` / `reviewFixer` / `gateFixer` / `mergeConflictResolver` (← `implementer`);
  `lessonConsolidator` (← `commitToMemory`).

`securityReview` is **not** legacy, despite what it used to say here. It backs
`scanDiffForSecurityIssues`, the post-diff gate that runs on `executeImplementation` and on all
three fix paths and throws a non-retryable `SECURITY_GATE_FAILURE` on any CRITICAL finding. It is a
different mechanism from `runReviewNetwork`: the review network gives three personas an opinion on
the whole change and routes on their verdicts; this scans the diff alone and fails the activity
outright. Removing the Agent row breaks every implementation run — `assertConfigReady` requires it
wherever those steps are installed.

`MODEL_BACKED_AGENT_KEYS` in `@auto-swe/shared/agentKeys` is a narrow convenience set used for
cost pricing and the model-config UI labels — it is **not** the agent universe.

**Skill** = a named prompt fragment (`promptText`) injected into the agent system message; it
controls *how* an agent reasons. Built-ins live one-per-file in `packages/shared/src/skills/` and
seed as `isBuiltIn` + `isVerified`. Custom skills seed as `isVerified: false`, and the flag resets
to `false` whenever `promptText` is edited. Custom text is scanned by `scanSkillContent`
(non-blocking; returns warnings).

**Tool** = an executable Mastra `createTool()` function. The implementer has four configurable
workspace tools (`readFile`, `writeFile`, `listDirectory`, `bash`) listed in `IMPLEMENTER_TOOL_IDS`
and gated by the resolved Agent's `toolKeys`; `null` means all four are enabled. A fifth tool,
`loadSkill`, is added automatically when skills are present and is **not** configurable via
`toolKeys`. A sixth `'mcp'` pseudo-key (in `AGENT_TOOL_KEYS`, not in `IMPLEMENTER_TOOL_IDS`) gates
MCP tool loading: when an Agent lists `'mcp'` **and** references an active `mcp` Connection via
`Agent.mcpConnectionId`, that server's tools bind at run time for the implementer activities and
the generic agent node.

> **Gotcha:** `packages/worker` declares `@modelcontextprotocol/sdk` directly even though it only
> ever imports `@mastra/mcp`. `@mastra/mcp` moved to the MCP SDK 2.x packages but still depends on
> `@modelcontextprotocol/ext-apps`, which statically imports `@modelcontextprotocol/sdk/types.js`
> and only declares it as a peer. Nothing else in the tree provides it, so without the direct
> dependency every `import '@mastra/mcp'` throws `Cannot find package` — at worker boot, not just
> in tests. Drop it only once `@mastra/mcp` ships a release whose `ext-apps` no longer needs it.

**Progressive disclosure (implementer only):** the implementer receives a compact menu of skill
names + descriptions and calls `loadSkill` to fetch full text on demand, so unused skills cost no
tokens. Reviewer sub-agents, planner, and decomposer receive their fragments inline instead — they
have no tools.

**Scope cascade** — every per-key config resolves through five levels, most specific first:

```
WORKFLOW_TEMPLATE  →  CHANNEL  →  TEAM  →  ORGANIZATION  →  GLOBAL
```

`CHANNEL` applies only when `ctx.channelId` is set (channel-resident runs); `ORGANIZATION` only
when the run's team belongs to an org (`ctx.orgId` derives transitively from `Team.orgId`). A
deployment with neither behaves exactly like the three-level cascade. There is **no fallback past
GLOBAL** — a missing row throws `ConfigMissingError`, and `assertConfigReady()` walks every
required row at worker boot before the Temporal poller starts.

> **Gotcha:** `Agent` and `ProviderCredential` use *partial* unique indexes per scope. Prisma cannot
> express `WHERE scope = …` in an upsert, so use `findFirst` + conditional `create` — never
> `upsert` — for GLOBAL-scope rows.

Key files: `lib/config/agentResolver.ts` (`resolveAgent`), `lib/config/agentSpec.ts`,
`lib/config/agentRef.ts`, `lib/config/agentSkills.ts`, `lib/config/resolver.ts`,
`lib/config/mcpConnection.ts`, `agents/mcpTools.ts`, `activities/runAgent.ts` +
`runAgentNode.ts`, gateway `lib/agentLibraryService.ts`, `shared/lib/skillScanner.ts`.
Full reference: [`docs/agents.md`](./docs/agents.md).

### Runtime Security Scanners

Six scanners run during agent execution, each independently advisory or blocking:

| Scanner | Stage | Behaviour | Source |
|---|---|---|---|
| **Sensitive file** | Pre-write of every `writeFile` | **Hard-block** | `SENSITIVE_FILE` patterns via `sensitiveFileScanner.ts` |
| **Pre-write content** | Pre-write of every `writeFile` | **Soft-block** (CRITICAL hard-blocks) | Static rules in `preWriteSecurityCheck.ts`; tags traces with `SECURITY_CHECK_FAILED_PREFIX` / `SECURITY_WARNINGS_PREFIX` |
| **Shell command** | Pre-exec of every `bash` call | **Soft-block** (returns an error string to the agent) | `SHELL_COMMAND` patterns via `shellCommandScanner.ts` |
| **Code security** | Post-commit diff scan | Advisory | `CODE_SECURITY` patterns via `codeSecurityScanner.ts`; findings reach the security reviewer through `CodeResult.codeSecurityFindings` |
| **Skill content** | Skill save + LLM output per TDD iteration | Advisory | `INJECTION` / `EXFILTRATION` patterns via `skillScanner.ts` |
| **LLM output** | Post-generate per TDD iteration | Advisory | `scanSkillContent`; wrapped in try/catch — a DB failure must never abort the activity |

**Built-in patterns:** 62 patterns in `packages/shared/src/scannerPatterns/index.ts` — 13 INJECTION,
11 EXFILTRATION, 18 SHELL_COMMAND, 10 CODE_SECURITY, 6 SENSITIVE_FILE, 4 PII. Synced idempotently by
`syncBuiltins()` at gateway startup and admin-extensible at `/admin/scanner`.

`EXFILTRATION` patterns are written for **prose** — skill text and LLM output — and several are far
too broad for a shell (`https?://\S+` matches most build commands). Shell-context exfiltration is
covered by dedicated `SHELL_COMMAND` rules that target outbound movement of *local data* (upload
flags, request-capture sinks, metadata endpoints, netcat egress, remote copy, credential-file reads,
encode-then-pipe) rather than network access as such. **Do not wire the EXFILTRATION set into the
shell scanner** — it would soft-block routine `curl`/`git clone` and drive the agent into retry
loops.

**The shell scanner also enforces the sensitive-file policy.** `scanShellCommand` extracts write
targets from a command (redirects, `tee`, `dd of=`, `cp`/`mv` destinations) and runs each through
`checkSensitiveFilePath`, so a `SENSITIVE_FILE` pattern added at `/admin/scanner` covers `bash` as
well as the `writeFile` tool. Extraction is a heuristic over command text, not a shell parser — it
raises the floor and is not a containment boundary.

**Pattern cache:** `shellCommandScanner`, `codeSecurityScanner`, and `sensitiveFileScanner` share
`makePatternLoader()` — a per-instance 60 s TTL cache. Gateway and worker are separate processes,
so a pattern edit propagates only via TTL expiry; there is no cross-process invalidation. The
loader's only filter is "does it compile" — it makes **no** judgement about how expensive a row is
to run, because a wrong guess silently stops an admin's block rule from applying.

**Safe regex flag subset:** `i`, `m`, `s`, `u`, `v`. `g` and `y` are rejected at the API to prevent
stateful `lastIndex` bugs in cached RegExp objects. `SAFE_FLAGS_RE` in
`shared/lib/regexSafety.ts` is the one definition; the gateway's Zod schema imports it.

**Scanner patterns are DATA, so their execution is bounded, not analysed.** Admin- and
bundle-supplied bodies run in-process against agent text on every `bash` call, every `writeFile`
path, every skill save and every TDD iteration. JavaScript's backtracking engine has no execution
budget and a running regex cannot be interrupted from the thread executing it, so containment is
structural in the runtime sense: `shared/lib/regexExec.ts` owns a single pooled `worker_thread`
that executes every scanner pattern and is `terminate()`d when a batch overruns its wall-clock
budget. That budget is the `workspace.regexScanBudgetMs` setting (default 250 ms, ADMIN-only,
platform-wide — see the Setting Registry section above) resolved once per scan call and passed
through `runRegexBatch`'s `opts.budgetMs`; a resolution failure falls back to the default rather
than throwing, since a scan must never abort its caller. The budget is **per target**: each window
a blocking scanner passes gets the full budget against every pattern, so a long command is bounded
by `windows × budget`, not held to one budget for all of them. On an overrun the batch is bisected
against a fresh thread to attribute the hang to a specific pattern; the well-behaved patterns'
results are kept. An isolated overrun is then **confirmed** — the lone pattern is re-run by itself
on a fresh thread — and only a second overrun blames the pattern; a pattern that completes on the
re-run is treated as evaluated. Warm round trips cost ~0.1 ms.

Built-in `SHELL_COMMAND` patterns of the form `\bword\b … tail` bound the scan after the word to
the next occurrence of the same word set (`restOfSegment` in `scannerPatterns/index.ts`), so their
cost stays linear in a 20k window; `regexExec.test.ts` times the whole built-in set against
adversarial windows. A plain `[^;&|]*` there is quadratic — attempted at every occurrence of the
word, each attempt scanning to the end of the segment — and 20k of `curl curl curl …` costs more
than the entire budget for one pattern.

- **Blocking scanners fail closed.** `scanShellCommand` and `checkSensitiveFilePath` return a block
  message when the scan cannot complete — they cannot say the input is clean, so they do not.
- **Advisory scanners degrade.** `scanSkillContent` returns `incomplete: true` alongside whatever
  it did find; `scanDiffForCodeIssues` logs and returns partial findings. No scanner throws — per
  the observability rules a scan must never abort the calling activity.
- **Blocking scanners never truncate.** Truncation in a blocking scanner is a bypass (20k of
  leading `# ` comment pushes a real command past a cap). They use `chunkScanText`, which covers
  the whole input in overlapping windows. `capScanText` (20 k) remains, restricted to the advisory
  scanners where a missed match past the cap costs only a warning.
- **Write time is empirical, not structural.** `POST`/`PUT /admin/scanner-patterns` runs the
  candidate through `probeRegexBacktracking`, which executes it under the same budget against
  repetition-heavy input built from its own alphabet, and rejects with `REDOS_RISK` if it overruns.
  This is sound but incomplete — it misses polynomial blow-ups and blow-ups needing input it cannot
  synthesise (`\p{Script=Greek}`) — and it is an early error for the admin, not the containment.
  `checkRegexSafety`, which bundle install and the SDK share, is pure and synchronous: compile,
  flags, and length only, with **no** claim about execution cost.

Limitations of this arrangement, stated so nothing above reads as more than it is:

- A pattern that overruns twice in isolation is **quarantined per process for
  `REGEX_QUARANTINE_TTL_MS`** (10 min) and skipped by scans inside that window. The executor
  reports the skipped keys in `quarantinedPatternKeys` and does not mark those scans `incomplete`,
  so the caller decides: `scanShellCommand` and `checkSensitiveFilePath` block on a non-empty
  list (a rule they never ran cannot clear the input), while the advisory scanners proceed without
  the rule. For a blocking scanner the quarantine therefore turns "two burned budgets per scan" into
  an immediate block, and an admin must fix or disable the row at `/admin/scanner` to restore
  agent `bash` access; it does not silently drop the rule. It is logged loudly on every skip; the
  quarantine is per-process, so gateway and worker quarantine independently and both forget on
  restart. When the TTL lapses the pattern runs again, and a still-bad one costs another two
  budgets before it is re-quarantined.
- The scan during which a pattern overran fails closed, so an agent can see one spurious block
  before the quarantine takes effect.
- N distinct pathological patterns cost N × two budgets per target before they are all
  quarantined. The budget bounds a hang; it does not make scanning free.

**Security events:** blocks tag `AgentTrace.error` with the prefixes above; advisory events write
named `activity_event` rows (`'code_security.scan'`, `'llm.suspicious_output'`). The
`GET /api/v1/platform/security-events` endpoint derives each `SecurityEventType` with DB-level
predicates so pagination stays correct.

### Multi-Model Support

Model selection and provider credentials are fully DB-driven — there are **no model or credential
env vars**, and the worker refuses to start until every required row exists.

**Spec format** is `<provider>/<model-id>`. Built-in providers: `anthropic`, `openai`, `google`.
Any other provider name routes through `@ai-sdk/openai-compatible` and requires an `apiBase` on the
credential row — this covers OpenRouter, Ollama, vLLM, Groq, Cerebras, and similar.

**Credentials** are AES-256-GCM encrypted in `provider_credentials.api_key_ciphertext`.
`CONFIG_ENCRYPTION_KEY` (base64, 32 bytes) is required to start the gateway or worker — both call
`assertEncryptionKeyConfigured()` first thing and exit on a missing or wrong-length key. Rotation
is a two-key dance (`CONFIG_ENCRYPTION_KEY_VERSION` + `CONFIG_ENCRYPTION_KEY_PREVIOUS`, then
`yarn keys:rotate`); see [`docs/model-configuration.md`](./docs/model-configuration.md).

**Mid-run config changes:** activities re-resolve their model on every call, so an edit lands on the
next LLM call inside an already-running workflow rather than waiting for a fresh run.

Seeded model defaults (applied to the GLOBAL Agents by `syncBuiltins`):

| Agent | Default |
| ----- | ------- |
| `implementer`, `reviewer`, `commitToMemory`, `channelAssistant`, `workflowAuthor` | `anthropic/claude-opus-4-8` |
| `planner`, `securityReview`, `validateContext`, `workflowExplainer` | `anthropic/claude-sonnet-4-6` |
| `evalJudge` | `anthropic/claude-haiku-4-5-20251001` |
| (embedding) | `openai/text-embedding-3-large` |

Current model IDs — override defaults from the dashboard; pricing for these lives in `MODEL_PRICES`:

| Provider  | Reasoning / heavy            | Balanced                    | Fast / cheap                            |
| --------- | ---------------------------- | --------------------------- | --------------------------------------- |
| Anthropic | `claude-opus-4-8`            | `claude-sonnet-4-6`         | `claude-haiku-4-5-20251001`             |
| OpenAI    | `gpt-5-5-pro`                | `gpt-5-5`                   | `gpt-5`                                 |
| Google    | `gemini-2.5-pro`             | `gemini-2.5-flash`          | `gemini-3.1-flash-lite-preview` / `gemini-2.5-flash-lite` |

> **Deprecation:** `claude-sonnet-4-20250514` retires **2026-06-15**. Any custom override still
> pinned to that ID must migrate to `claude-sonnet-4-6`.

Bootstrap for a fresh deployment is in [`docs/model-configuration.md`](./docs/model-configuration.md)
and §8 below.

### Cost Tracking

`packages/worker/src/lib/costTracking.ts` prices each call from `MODEL_PRICES` (USD per MTok).
Unknown models fall back to zero cost and emit `llm.cost_pricing_known=false` on the OTel span —
usage is still recorded, so runs are never lost to a missing price. Add new entries as agents are
routed to new models, or set a per-model env override:

```
MODEL_PRICE_<PROVIDER>_<MODEL>=<input>:<output>   # USD per MTok, non-alphanumerics → _
```

Pricing keys off the resolved `provider/model` spec only — it is decoupled from agent identity,
which is retained purely for attribution and telemetry.

### Embeddings

`packages/worker/src/lib/embeddings.ts` resolves its spec, API key, and (for OpenAI-compatible
providers) `apiBase` from the DB-backed `EmbeddingConfig` singleton. Built-in: `openai`; any other
provider name is treated as an OpenAI-compatible endpoint and requires an `apiBase`.

Output **must** be 1536-dimensional — `memory_items.embedding` is fixed at `vector(1536)` and the
helper throws if the model returns a different shape.

### Agent Observability (AgentTracer)

Every LLM-calling activity must use `AgentTracer` to record tool calls, LLM responses, and activity
events. These persist as `AgentTrace` rows and power the `/runs/[id]` viewer.

```typescript
const tracer = new AgentTracer();
try {
  tracer.addToolCall({ toolName, inputJson, outputJson, durationMs, error? });
  tracer.addLlmResponse({ role, inputJson: { systemPrompt, userMessage }, outputJson, durationMs });
  tracer.addActivityEvent({ name, outputJson, durationMs?, error? });
  return result;
} finally {
  // Always runs — even if the LLM call throws:
  await persistActivityTrace(tracer, 'implementer');
}
```

`persistActivityTrace` (from `lib/activityContext.ts`) auto-resolves `runId` and `attempt` from
Temporal context. **Always call it in a `finally` block.** Calling it only on the success path
silently drops every trace record when the activity fails — exactly when you need them.

### Temporal Workflow Constraints

- Workflow files run in a **V8 isolate**, not Node.js
- Only `import type` is allowed for external packages
- All runtime imports must come from `@temporalio/workflow`
- Activities are the boundary between deterministic replay and the non-deterministic outside world (LLM calls, Docker, GitHub API, DB)

### Docker-in-Docker Workspace

- The worker process needs the Docker socket mounted (`/var/run/docker.sock`)
- Containers are created with `docker run`, commands executed with `docker exec`
- **Always** clean up containers in a `finally` block — leaked containers accumulate
- Shell escaping: `shellQuote()` in `activities/workspace.ts` wraps every `docker exec … sh -c` and every clone/checkout argument. It is the injection boundary for agent-generated commands — treat any change to it, or any caller that bypasses it, as security-critical.

### Yarn 4 Docker Builds

- Dockerfiles use a **3-stage build** (builder → prod-deps → runtime)
- `yarn workspaces focus <pkg> --production` strips devDependencies in the prod-deps stage
- Dependencies are hoisted to root `node_modules/`; per-workspace `node_modules/` may be empty

Every way this build breaks fails *after* the image is built, not during it — a missing transitive
dependency, a generated client at the wrong path, a layer that stores `node_modules` twice. Read
[`prisma-docker-migrations`](./.claude/skills/prisma-docker-migrations/SKILL.md) before editing any
Dockerfile; it has the specific rules and what has already been tried and does not work.

---

## 7. Forbidden Actions

- Do **NOT** use Express.js — the project uses **Fastify 5.x**
- Do **NOT** use K8s APIs — workspaces use Docker-in-Docker for isolation
- Do **NOT** auto-merge PRs on target repositories — humans merge
- Do **NOT** store secrets in code or commit `.env` files
- Do **NOT** modify the Temporal server or its configuration
- Do **NOT** use raw SQL except for pgvector operations — use the Prisma client for everything else.
  The one other exception is a lock Prisma cannot express — `SELECT … FOR UPDATE` on a row or
  `pg_advisory_xact_lock` inside a transaction — and each such call is marked with a
  `// CLAUDE.md §7 exception:` comment so a grep finds every one
- Do **NOT** add dependencies without checking whether an existing one covers the need
- Do **NOT** write status prose, PR numbers, or phase labels into a living doc (§5)

---

## 8. Local Development Quickstart

```bash
# 1. Install
corepack enable && yarn install

# 2. Start infrastructure (postgres + postgres-temporal + temporal + garage)
cp .env.example .env    # Fill in CONFIG_ENCRYPTION_KEY, SEED_ADMIN_PASSWORD, and optionally
                        # GITHUB_TOKEN / GITHUB_WEBHOOK_SECRET as bootstrap fallbacks
yarn docker:infra:up

# 3. Database setup
yarn db:migrate && yarn db:generate && yarn db:seed
#  ↳ seeds the admin user, default team, sample connection, default workflow template,
#    built-in skills + scanner patterns, and the GLOBAL Agent rows.

# 4. Start gateway + web first (the worker needs GitHub config in the DB before it starts)
yarn dev:gateway         # Terminal 1 — http://localhost:8080
yarn dev:web             # Terminal 2 — http://localhost:3000

# 5. Configure integrations in the admin UI
#    Sign in at http://localhost:3000 with admin@auto-swe.local + SEED_ADMIN_PASSWORD
#    → /admin/model-config → Credentials → add a provider credential
#    → /admin/integrations → GitHub → enter the PAT + webhook secret → Save
#      (or skip if GITHUB_TOKEN is set in .env — the env fallback still works)

# 6. Start the worker
yarn dev:worker          # Terminal 3 — reads GitHub config from the DB

# 7. Drive it from the dashboard, or headlessly with a PAT from Settings → API tokens:
TOKEN=<paste-PAT>
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"externalTicketId":"JIRA-1","description":"Add GET /health endpoint","repoIds":["<connection-uuid>"]}'
```

Monitor at `http://localhost:3000` (dashboard), `/runs` (history), and `http://localhost:8233`
(Temporal UI). To start over locally,
`yarn workspace @auto-swe/shared exec prisma migrate reset` is the cleanest path — a generated
`init` baseline plus one hand-written migration (`custom_constraints_and_indexes`) for DDL the
Prisma DSL cannot express (CHECK constraints, partial unique indexes, the pgvector HNSW index,
array `NOT NULL`).

Full production runbook: [`docs/deployment.md`](./docs/deployment.md).

---

## 9. Reference: Key Design Decisions

| Decision                     | Choice                                                    | Rationale                                                         |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| HTTP framework               | Fastify 5.x over Express                                  | ~3x throughput, built-in schema validation, plugin architecture   |
| Auth                         | better-auth sessions (browser) + PATs (CLI/CI); short-lived JWTs via the session-token bridge | One identity store; PATs survive restarts |
| DinD over K8s                | `docker run` / `exec`                                     | No cluster needed; same isolation model, zero infra beyond Docker |
| PAT or GitHub App            | PAT for simplicity; GitHub App for production             | GitHub App gives short-lived tokens, per-installation scope, and a full audit trail |
| pgvector for memory          | Vector embeddings on `MemoryItem`                         | Semantic similarity search for agent context enrichment           |
| Yarn 4 `node-modules` linker | Not PnP                                                   | Maximum tool compatibility with Prisma, Temporal, Docker          |
| Agent identity as a string   | No enum; agents are data                                  | New agents ship as seed content, not code changes                 |
| Human-governed merges        | Nothing shipped merges a PR; the system opens them        | The one decision that stays human                                 |
