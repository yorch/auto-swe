# Configuration

Every knob in auto-swe lives in one of three places, and which one it lives in follows a single
rule: **what must be true before a process can reach the database stays in the environment;
everything else is data an operator can change without a deploy.**

| Tier | Lives in | Contents | Changed by |
|---|---|---|---|
| Bootstrap | Environment, permanently | `DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`, `TEMPORAL_ADDRESS`, `PORT`, JWT/auth secrets, `BUNDLE_TRUSTED_KEYS`, `NEXT_PUBLIC_*`; sign-in credentials (`GITHUB_CLIENT_*`, `GOOGLE_CLIENT_*`, `OKTA_*`); artifact storage (`ARTIFACT_S3_*`, `AWS_*`); workspace sizing and images (`WORKSPACE_*`); `WORKER_MAX_CONCURRENT_ACTIVITIES`; `SCANNER_REGEX_BUDGET_MS`; the scheduled sweeps (`REPO_ACCESS_SYNC_*`, `REPO_DEPENDENCY_SCAN_*`, `MODEL_DISCOVERY_*`, `RUN_REAPER_*`) | The deploy pipeline |
| Integrations | Singleton config tables | GitHub, Slack, issue tracker, knowledge base, Figma, workflow defaults | Admins, at `/studio/integrations` and `/govern/workflow-defaults` |
| Policy | The setting registry | Operator knobs that used to be constants in the worker | Admins and grant holders, at `/govern/platform-settings` |

The bootstrap tier is deliberately not DB-backed. `CONFIG_ENCRYPTION_KEY` decrypts every other
secret, and `BUNDLE_TRUSTED_KEYS` is the trust anchor for bundle signatures — anyone with database
write access could otherwise mark a malicious bundle verified.

The bootstrap tier also holds anything an admin edit could never usefully change, or should not be
able to. Sign-in credentials and the Okta issuer are read once when the gateway boots, so an
editable copy needs a restart to apply and would only add a second place to look. Storage is a
deploy-time infrastructure choice, and workspace sizing and sidecar images describe the host the
worker runs on. The worker validates those variables at boot and refuses to start on one it cannot
use — a malformed image reference, a non-numeric limit, or `WORKSPACE_BLOCK_METADATA` set to anything
but `true` or `false`. The gateway does the same for the sweep variables: a flag that is not `true` or
`false`, or a cron expression that is not five fields. The sweeps are environment variables rather
than settings because the gateway applies them to Temporal once, at startup, so an edit in a form
would not take effect until a restart. Past boot the resolvers fall back to defaults instead of throwing, because they
run on paths (the scanners) that must never abort their caller.

One workspace value stays in the registry: `workspace.gitHelperImage`, which cascades to team and
organization because a team on an isolated network may need its own mirror. The bounds on agent runs
(`workspace.agentRunMaxSteps`, `workspace.agentRunMaxWallClockSeconds`,
`workspace.agentRunMaxConcurrentGlobal`, `workspace.agentRunMaxConcurrentPerTeam` and
`workspace.agentRunAllowWorkflowChanges`) are registry settings too, all ADMIN-only; see
[agent-runs.md](./agent-runs.md#6-bounds).

The `mcp` group holds the switches and bounds of the MCP server: `mcp.enabled`,
`mcp.writeToolsEnabled`, `mcp.writeCallsPerMinute` and `mcp.maxConcurrentRuns`, all ADMIN-only and read
per request, so they take effect within the settings cache's ~30 s with no restart; see
[mcp-server.md](./mcp-server.md#settings).

The `skills` group holds two settings, both ADMIN-only and GLOBAL only. `skills.import.privateNetworkHosts`
(default empty) names hosts a skill source may live on even though they are, or are spelled as, a private
address; a host qualifies only if it is also an approved repository host, and cloud metadata and loopback
addresses stay refused whatever is listed. `skills.import.blockOnScanWarnings` is default on. While
it is on, importing skills from an external source refuses any chosen skill whose description or text
draws a scanner warning (an incomplete scan included) and names it in the response; off, such a skill is
installed unverified with the warnings recorded on its first revision. It is read on each import, so a
change applies within the settings cache's ~30 s; see
[agents.md](./agents.md#66-external-skill-sources).

This doc covers the third tier. For integration credentials see
[model-configuration.md](./model-configuration.md) and the admin pages themselves; for the
environment see [deployment.md](./deployment.md).

---

## 1. Settings are declared, not stored ad hoc

A setting is one declaration in `packages/shared/src/config/registry.ts`:

```ts
'channel.reactiveCooldownMinutes': defineSetting({
  group: 'channel',
  label: 'Interjection cooldown',
  description: 'Minimum gap between unprompted interjections in one channel…',
  schema: z.number().int().positive().max(10_080),
  defaultValue: 10,
  overridableAt: ['TEAM', 'ORGANIZATION'],
  requiredRole: 'LEAD',
  runPinned: false,
  restartRequired: false,
  unit: 'minutes',
}),
```

That one declaration is what validates a write, resolves a read, decides who may change it, and
renders the admin form. There is no migration, no request schema, and no form field to write — which
is the point: a knob that costs five files to add stays a `const` instead.

`defaultValue` is always the constant the setting replaced, so a deployment that configures nothing
behaves exactly as it did before the setting existed.

A setting's identity is the property it is stored under — `channel.reactiveCooldownMinutes`
above. That key is the storage key and the subject of permission grants, so renaming one orphans
every row and grant that referenced it.

| Field | Meaning |
|---|---|
| `schema` | Zod schema. Validates writes *and* values read back out of the database. |
| `overridableAt` | Scopes below GLOBAL where an override may be set. Empty means platform-wide only. |
| `requiredRole` | A floor. No grant can let an actor below it write the key. |
| `runPinned` | Frozen into a run's snapshot at start; see §4. |
| `restartRequired` | Surfaced in the UI. The resolver does not enforce it. |

---

## 2. Resolution order

`resolveSetting(key, ctx)` in `packages/shared/src/config/resolveSetting.ts` is the only read path:

```
run pin  →  WORKFLOW_TEMPLATE  →  CHANNEL  →  TEAM  →  ORGANIZATION  →  GLOBAL  →  default
```

The five scope tiers are the same cascade agents and provider credentials resolve through
(see [architecture.md](./architecture.md)). A tier only participates when the context carries its id,
so a deployment with no organizations behaves exactly like a three-level cascade.

Two properties worth knowing:

- **Every candidate override for one context is fetched in a single query** and cached under one key,
  so resolving twenty settings for a run costs one round trip. The cache is the same ~30 s TTL the
  agent and credential resolvers use.
- **A stored value that no longer parses is ignored, not thrown.** A row written before a schema
  tightened degrades that one key to the next tier down, rather than failing every activity that
  reads configuration. The rejection is logged, so a saved value cannot vanish without a trace.
- **A row at a scope the definition forbids is ignored too.** `overridableAt` is enforced on the way
  out as well as on the way in — a platform-wide security control that a stray row can switch off
  would not be a control.

Where a knob also has its own column on the entity it belongs to — `SlackChannel` carries the
per-channel interjection cooldown, for instance — that column is the narrow override and always
wins. Those keys deliberately do **not** offer a `CHANNEL` scope in the registry, because a row
there would be stored and never read, and the effective-config view would report it as winning.

`resolveEffectiveSettings(ctx)` returns every setting with the tier that supplied it. That is the
effective-config view behind `/govern/platform-settings`, and the answer to "why is this run behaving that
way".

---

## 3. Who may change what

Two independent gates, both of which must pass.

**The definition's `requiredRole` is a floor.** No grant can let an `ENGINEER` write a key marked
`ADMIN`.

**A grant must authorise the actor.** Grants are rows in `config_permissions`, not a map in code, so
widening who configures what is an admin action rather than a deploy:

| Column | Meaning |
|---|---|
| `keyPattern` | An exact key, a `group.*` prefix, or `*`. Deliberately not a glob library — an operator reading a grant should know what it covers without learning a syntax. |
| `userId` *or* `role` | Exactly one, enforced by a CHECK constraint. A role grant covers every holder of that role. |
| `scope` + `teamId`/`orgId` | The authority's reach. A TEAM grant covers that team and the channels and templates beneath it; an ORGANIZATION grant covers anything inside the org but never the GLOBAL row. |

A write is authorised against the tenant it actually lands in, not the ids in the request: a CHANNEL
override is checked against the team that owns the channel.

Platform admins bypass grants — they can already write every singleton config table, so requiring
them to grant themselves access would be ceremony. Managing grants is itself admin-only: a
permission model whose holders can mint further grants widens itself.

Every write, and every grant and revocation, lands in `ConfigAuditLog` with its before-state.

---

## 4. Run-pinned settings

Some values a run makes a structural decision on. If `workflow.maxTransitions` changed halfway
through a run, the second half would disagree with the first, and — because the interpreter's path
is recorded in Temporal history — a replay could diverge from the code that produced it.

Settings marked `runPinned` are therefore resolved once, when the `WorkflowRun` row is created,
and stored on `WorkflowRun.pinnedSettings` alongside the existing agent-version pin. For the life of
that run, `resolveSetting` reads the snapshot instead of the live cascade, and the effective-config
view reports the value's source as `PINNED`.

Everything else re-resolves on every call. That is what lets a model or credential edit land inside
an already-running workflow rather than waiting for a fresh run.

A run created before the snapshot column existed carries `NULL`, and falls back to the built-in
defaults.

---

## 5. Storage

`config_settings` holds one JSON value per `(key, scope)`. Uniqueness is a *partial* index per scope
— `WHERE scope = 'GLOBAL'`, `WHERE scope = 'TEAM'`, and so on — which Prisma cannot express in an
`upsert`, so writes use `findFirst` then create. This is the same constraint `Agent` and
`ProviderCredential` live with.

A CHECK constraint enforces that a row carries exactly the id for its own scope, so a TEAM row can
never also name an organization.

Both tables are registered with the tenant guard. The settings read is a deliberate exception — its
GLOBAL branch selects rows that belong to no tenant by definition — so it is wrapped in
`runUnscoped` with the reason attached.

The singleton integration tables are **not** absorbed into the registry. Their shape is genuinely
relational, their secrets use the AES-256-GCM envelope, and they work; the registry covers what had
no home.

---

## 6. Adding a setting

1. Add a definition to `packages/shared/src/config/registry.ts`, with the current constant as
   `defaultValue`.
2. Replace the constant at its call site with `resolveSetting(key, ctx)` — or `resolveSettings` when
   a caller needs several, which costs the same single query.
3. Pass the fullest scope context available. A lookup with a missing `teamId` silently resolves a
   broader value than intended.

There is no step 4. Storage, validation, the API, the admin form, and the audit trail all follow
from the definition.

---

## Limitations

- **The registry does not yet cover every compiled-in constant.** Temporal retry and timeout
  profiles (`packages/worker/src/workflows/proxyOptions.ts`), the context-spill budgets in
  `runnable.ts`, the model price table in `costTracking.ts`, and several agent loop caps are still
  code. Each is a definition away, but they are not done.
- **`WorkflowDefaults` is platform-wide.** Branch prefix, PR templates, budget tiers, workspace
  sizing, and the TDD/eval iteration caps resolve from one global row and do not cascade to a team.
  Moving them into the registry would give them the cascade; until then `/govern/workflow-defaults` edits them
  for the whole deployment.
- **Cache invalidation is per process.** A write invalidates the writing process's cache
  immediately; the other service picks the change up when its ~30 s TTL expires. Gateway and worker
  are separate processes and there is no cross-process invalidation, the same limitation the scanner
  pattern cache carries.
- **`restartRequired` is advisory.** The UI says a restart is needed; nothing enforces or performs
  it.
- **Grants are not scoped below a team.** Authority is expressed at GLOBAL, ORGANIZATION, or TEAM.
  There is no way to grant someone control of one channel's settings without granting the team.
- **No config export or import.** Bundles cover agents, skills, templates, and container steps;
  settings and grants are not part of a bundle, so promoting a configuration between environments is
  still manual.
