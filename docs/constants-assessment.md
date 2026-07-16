# Constants & Configuration Assessment (2026-07)

> A survey of the tunable / policy / operational constants scattered across the
> codebase, with a disposition for each: keep inline, **centralize** (dedupe into
> a shared const), move to **ENV** (deploy-time infra knob), or move to
> **DB config** (operator-tunable policy, no redeploy). Point-in-time snapshot;
> the code is authoritative where it has since diverged.

## Framing

The codebase already has three well-established homes for configuration, and the
right disposition for most constants is "it's already in the right place":

| Home | Examples | When to use |
|---|---|---|
| **Module const** | `scannerPatterns/index.ts`, `MODEL_PRICES`, `crypto.ts` params, `@auto-swe/shared/lib/billing` | A value with one correct definition, reused or invariant, not operator-facing |
| **`process.env`** | `CONFIG_ENCRYPTION_KEY`, `DATABASE_URL`, `BUNDLE_TRUSTED_KEYS`, config-cache TTL | Deploy-time infra/secrets that vary by environment |
| **DB cascade** | `resolveWorkflowDefaults()` (CI-poll timings, branch prefix), model config, `Organization.monthlyBudgetUsdCents`, per-channel flags, `ScannerPattern` table | Operator/tenant policy that must change without a redeploy |

The guiding principle: **do not over-centralize** (coupling independent local
knobs is a worse "altitude" problem than a little duplication), and **do not
move to DB speculatively** (each DB knob costs schema + migration + resolver +
cache + admin UI + tests). Reserve DB config for values an operator genuinely
needs to change per-deployment/tenant at runtime.

## Already well-placed — leave alone

- **Cryptographic invariants** (`crypto.ts`: `aes-256-gcm`, key/nonce/tag bytes,
  `CURRENT_KEY_VERSION` — the reserved rotation seam) — must not vary.
- **`currentYearMonth()`** month-bucket — intentionally single-sourced in
  `@auto-swe/shared/lib/billing` so the worker writer and gateway reader can't
  drift; the org $ cap itself is already DB config.
- **Embedding `1536`** — structurally bound to the `vector(1536)` column, not a
  tunable.
- **SSRF guard** (`ssrfGuard.ts`) — already consolidated from the old
  `credentialService` + `bundleFetch` copies.
- **`BUILTIN_SCANNER_PATTERNS`** — single-sourced and DB-synced; the
  admin-extensible `ScannerPattern` table is the DB-config path.
- **`BUNDLE_TRUSTED_KEYS`** — deliberately ENV, *not* DB: a signature trust
  anchor must not be mutable from the database. Do **not** move it.
- **Statistical constants** (`Z_95`, `MIN_SAMPLES_FOR_SIGNIFICANCE`) — math, not
  policy.
- **Vendor endpoint URLs** (Figma/Linear API bases) — fixed; self-hosted base
  URLs already flow through `resolveTrackerConfig`.
- **Config-cache TTL** (`lib/config/cache.ts`) and **CI-poll timings**
  (`waitForCiByPolling.ts` via `resolveWorkflowDefaults`) — already ENV/DB
  backed; these are the patterns to imitate.
- **Temporal heartbeat interval** (`execUtils.ts`, 30 s) — coupled to the
  workflow `heartbeatTimeout`; keep local.
- **Slack platform limits** (3000-char truncation) — dictated by the API.

## Tier 1 — CENTRALIZE (behavior-preserving refactors) — *implemented*

| Constant(s) | Was | Now |
|---|---|---|
| **Pagination `limit`/`offset`** | `.int().min(1).max(X).default(Y)` + `offset` copy-pasted across ~10 routes with inconsistent caps | `paginationQuery({maxLimit, defaultLimit})` factory in `gateway/src/lib/pagination.ts`; each route keeps its own caps (values unchanged) |
| **`PAT_PREFIX` (`'ats_'`)** | declared in `tokens.ts` and `plugins/auth.ts` | single-sourced (drift here silently breaks token verification) |
| **GitHub pagination** (`PER_PAGE=100`, `MAX_PAGES=5`) | `lib/github.ts` + `routes/webhooks.ts` (`CHECK_RUNS_*`) | single-sourced from `lib/github.ts` |
| **Scanner cache TTL (`60_000`)** | `shared/skillScanner.ts` + `worker/scannerPatternLoader.ts` | `@auto-swe/shared/lib/scannerCache` — a documented cross-process contract |
| **`SKIP_SENTINEL`** (`/^skip\b/i`) | copy-pasted across 4-5 channel-assistant files | `worker/src/activities/channelConstants.ts` |
| **Memory dedup threshold (`0.85`)** | `passiveIngestChannelMemory` + consolidation defaults | shared channel const (fallback only; DB overrides preserved) |

Deliberately **not** centralized (over-centralization avoided):
- **Fan-out default `4`** (`interpreter.DEFAULT_FANOUT_CONCURRENCY` vs
  `costEstimator.DEFAULT_FANOUT_WIDTH`) — semantically distinct (runtime
  concurrency vs cost-estimation width assumption) and coupling them risks an
  import cycle; they carry a cross-reference comment already.
- **Per-surface `MIN_*_LENGTH` / `MAX_*_CHARS`** channel knobs that merely
  *happen* to share a value — independently tunable per surface; left local.

## Tier 2 — DB CONFIG (operator policy) — *proposed, not yet built*

Each of these is a value an operator would plausibly change per-deployment or
per-tenant without shipping code. They are **not** in this change — each needs
schema + migration + resolver (+ cache + admin UI + tests), so they should be
approved and built individually. Listed by value/effort.

| Constant | Location | Proposed home | Notes |
|---|---|---|---|
| **`BUDGET_LIMITS`** (per-tier token budgets) | `worker/lib/costTracking.ts` | new `BudgetTierConfig` or `workflow_defaults` | Clearest case — the DB already holds org $ caps; token tiers are pure policy |
| **Channel proactivity** (`REACTIVE_COOLDOWN_MS`, `ORG_FLAG_COOLDOWN_MS`, similarity floors, nudge windows) | `channelReactive/flagOrgSignals/channelOpenItems` | `SlackChannel` / channel config | The channel already carries DB feature-flags + budgets; these ride alongside |
| **Eval health/judge thresholds** (`DEFAULT_HEALTH_THRESHOLDS`, `judgeThreshold`) | `worker/lib/evalSuiteHealth.ts`, `scorerCombination.ts` | `resolveEvalScheduleConfig` (already DB-backed) | Regression-gate policy per the evals RFC |
| **Iteration caps** (`MAX_TDD_ITERATIONS=5`, `MAX_EVAL_ITERATIONS=3`) | `executeImplementation.ts`, `evalHarness.ts` | `workflow_defaults` | Quality/cost knob |
| **Memory retrieval thresholds** (`0.7`/`0.65`/`0.75` floors) | `lessonRetrieval.ts`, `channelMemory.ts` | memory / workflow config | Relevance is a quality knob; also close the gap that `consolidateLessons` lacks the per-scope DB override its channel twin has |
| **MCP timeouts** (`15s`/`60s`) | `agents/mcpTools.ts` | the `mcp` Connection row | A slow MCP server is an ops reality; per-connection override |
| **Workspace resource caps + default image** (`4g`/`2`/`512`, `node:24-alpine`) | `activities/workspace.ts` | `workflow_defaults` or `WorkspaceLimitsConfig` | Also an infra-sizing concern; per-repo `executorImage` already exists |

## Tier 3 — ENV (deploy-time infra knobs) — *implemented*

| Constant | Location | Env var | Default |
|---|---|---|---|
| Session-cache revocation lag | `plugins/auth.ts` | `SESSION_CACHE_TTL_MS` | `60000` |
| Bundle install-from-URL size cap | `lib/bundleFetch.ts` | `BUNDLE_MAX_BYTES` | `5000000` |
| OTel metric export interval | `worker/lib/telemetry.ts` | `OTEL_METRIC_EXPORT_INTERVAL` | `30000` |

## Also flagged (not changed here)

- **Temporal retry/timeout tiers** — the `{ backoffCoefficient: 2, ... }` policy
  objects and `startToClose`/`heartbeat` literals recur ~20× across workflow
  files. A shared `proxyOptions` module would dedupe them, but the values are
  load-bearing (agent activities need 30 m + 5 m heartbeat) and the refactor
  touches every workflow file — deferred as a focused follow-up rather than
  bundled here.
- **`betterAuth.ts`** reads `BASE_URL` / `CLIENT_ORIGIN` directly from
  `process.env` at module load — the closest thing to violating the
  "no `process.env` in new code" rule; acceptable since OAuth config is
  restart-required, noted for the record.
- **Two dev-secret fallbacks** (`JWT_DEV_FALLBACK`, `DEV_FALLBACK_SECRET`) are
  maintained separately; both fail fast outside dev, so low risk.
