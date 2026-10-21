# Configuration

Every knob in auto-swe lives in one of three places, and which one it lives in follows a single
rule: **what must be true before a process can reach the database stays in the environment;
everything else is data an operator can change without a deploy.**

| Tier | Lives in | Contents | Changed by |
|---|---|---|---|
| Bootstrap | Environment, permanently | `DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`, `TEMPORAL_ADDRESS`, `PORT`, JWT/auth secrets, `BUNDLE_TRUSTED_KEYS`, `NEXT_PUBLIC_*`; sign-in credentials (`GITHUB_CLIENT_*`, `GOOGLE_CLIENT_*`, `OKTA_*`); artifact storage (`ARTIFACT_S3_*`, `AWS_*`); workspace sizing, images and network (`WORKSPACE_*`); the harness model proxy (`HARNESS_MODEL_PROXY_*`, `REGISTRY_PROXY_*`); `WORKER_MAX_CONCURRENT_ACTIVITIES`; `SCANNER_REGEX_BUDGET_MS`; the scheduled sweeps (`REPO_ACCESS_SYNC_*`, `REPO_DEPENDENCY_SCAN_*`, `MODEL_DISCOVERY_*`, `RUN_REAPER_*`, `AUTOMATION_DECISION_PRUNE_*`, `SKILL_SOURCE_SYNC_*`, `SLACK_CHANNEL_SYNC_*`, `CALLBACK_DELIVERY_*`, `CALLBACK_DELIVERY_PRUNE_*`, `AGENT_TRANSCRIPT_PRUNE_*`, `AGENT_TRACE_ROLLUP_*`) | The deploy pipeline |
| Integrations | Singleton config tables | GitHub, Slack, issue tracker, knowledge base, Figma, workflow defaults | Admins, at `/admin/integrations` and `/admin/workflow-defaults` |
| Policy | The setting registry | Operator knobs that used to be constants in the worker | Admins and grant holders, at `/admin/platform-settings` |

Each integration tab compares its form with the saved config: Save stays disabled with "No unsaved
changes" until something differs (a typed secret or a cleared field counts), the footer shows the
number of unsaved changes, and reloading, following an in-app link or switching tabs asks before it
discards them.

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

The `assistant` group holds `assistant.enabled` (ADMIN-only, default off), the switch for the in-app
assistant: off, the gateway refuses every request made with an assistant token, including the next
call of a conversation already under way, and the dashboard does not offer the panel. It is read per
request through the settings cache. `assistant.maxStepsPerTurn` (default 12) bounds the model steps
one reply may take, each tool call being one; a reply that reaches it ends with what it has and says
so. `assistant.generateTitles` (default on) lets the `assistantTitler` agent name each conversation
(its model is set in the agent library); off, a conversation keeps the start of its first message as its title
until the user renames it.

The assistant's tools in the worker call the gateway at `API_INTERNAL_URL` (default
`http://localhost:8080`; both compose files set `http://gateway:8080`), the same variable the web
server reads for its own fetches.

The `mcp` group holds the switches and bounds of the MCP server: `mcp.enabled`,
`mcp.writeToolsEnabled`, `mcp.writeCallsPerMinute` and `mcp.maxConcurrentRuns`, all ADMIN-only and read
per request, so they take effect within the settings cache's ~30 s with no restart; see
[mcp-server.md](./mcp-server.md#settings).

The `models` group holds `models.privateNetworkHosts` (ADMIN-only, GLOBAL only, default empty): hosts a
provider credential's `apiBase` may name even though they are, or resolve to, a private address. It lifts
the private-address refusal everywhere the host is checked. Saving a credential checks the `apiBase` as
text only; the **Test** button, model discovery, the catalog refresh and run-time inference, embedding
and Claude Code model-proxy calls resolve the name and pin the connection to a checked address, and
run-time calls also refuse redirects. Loopback, link-local / cloud-metadata, unspecified, multicast and
reserved addresses stay refused whatever is listed, an unreadable setting lists no host, and a Claude Code harness run without the model proxy is outside the guard. See
[model-configuration.md](./model-configuration.md#troubleshooting).

It also holds `models.priceListUrl` (ADMIN-only, GLOBAL only, sensitive): the community price list, in
LiteLLM's `model_prices_and_context_window.json` format, that suggests a new model's prices to the
catalog's **Add** form and bulk add, and gives the scheduled catalog refresh figures to cross-check.
It defaults to LiteLLM's file on GitHub; an empty value turns the lookup
off, and a mirror on a private network needs its host in `models.privateNetworkHosts`. See
[model-configuration.md](./model-configuration.md#model-catalog).

The `skills` group holds two settings, both ADMIN-only and GLOBAL only. `skills.import.privateNetworkHosts`
(default empty) names hosts a skill source may live on even though they are, or are spelled as, a private
address; a host qualifies only if it is also an approved repository host, and cloud metadata and loopback
addresses stay refused whatever is listed. `skills.import.blockOnScanWarnings` is default on. While
it is on, importing skills from an external source refuses any chosen skill whose description or text
draws a scanner warning (an incomplete scan included) and names it in the response; off, such a skill is
installed unverified with the warnings recorded on its first revision. It is read on each import, so a
change applies within the settings cache's ~30 s; see
[agents.md](./agents.md#66-external-skill-sources).

The check that flags a moved ref on a tracked skill source is a scheduled sweep like the other gateway
sweeps, so it is environment-only and applied once at gateway startup (a change needs a restart):
`SKILL_SOURCE_SYNC_ENABLED` (default `true`; it spends one API request per source and changes no skill)
and `SKILL_SOURCE_SYNC_CRON` (five-field cron, UTC, default `41 5 * * *`). The gateway refuses to start on
a value it cannot use. See [agents.md](./agents.md#66-external-skill-sources).

The Slack channel sync, which re-checks each channel's privacy and records who is in each private
one, is a sweep too: `SLACK_CHANNEL_SYNC_ENABLED` (default `false`: it needs the bot's `channels:read`
and `groups:read` scopes, and its member lists show a private channel's content to its members),
`SLACK_CHANNEL_SYNC_CRON` (default `29 * * * *`) and `SLACK_CHANNEL_SYNC_STALE_HOURS` (default `6`, a
whole number from 1 to 9999), how old a channel's member list may be and still count. See
[channel-assistant.md](./channel-assistant.md#6-memory).

The automation ledger's retention sweep is environment-only too: `AUTOMATION_DECISION_PRUNE_ENABLED`
(default `true`) and `AUTOMATION_DECISION_PRUNE_CRON` (default `37 4 * * *`). How long it keeps decisions
is the registry setting `workflow.automationDecisionRetentionDays` (ADMIN, GLOBAL only, default 90 days,
at least 7), read on each sweep. See [automations.md](./automations.md#the-ledger).

The run-callback sweeps are environment-only for the same reason: `CALLBACK_DELIVERY_ENABLED` (default
`true`) and `CALLBACK_DELIVERY_CRON` (default `* * * * *`) send due deliveries;
`CALLBACK_DELIVERY_PRUNE_ENABLED` (default `true`) and `CALLBACK_DELIVERY_PRUNE_CRON` (default
`47 4 * * *`) delete old ones, keeping them for `workflow.callbackDeliveryRetentionDays` (ADMIN, GLOBAL
only, default 30 days). See [run-callbacks.md](./run-callbacks.md#5-delivery).

The agent-transcript retention sweep is environment-only for the same reason: `AGENT_TRANSCRIPT_PRUNE_ENABLED`
(default `true`) and `AGENT_TRANSCRIPT_PRUNE_CRON` (default `57 4 * * *`). How long transcripts keep
is a setting (`workflow.transcriptRetentionDays`), read on each sweep; so is how long the transcript
access log keeps (`workflow.transcriptAccessLogRetentionDays`, ADMIN, GLOBAL only, default 2555 days,
365 to 3650). The same sweep deletes artifacts left `pending` by an object-store upload that never
completed. See [transcripts.md](./transcripts.md).

The usage rollup sweep is environment-only as well: `AGENT_TRACE_ROLLUP_ENABLED` (default `true`) and
`AGENT_TRACE_ROLLUP_CRON` (default `13 1 * * *`) build the daily summaries the usage report reads
for completed days, and `AGENT_TRACE_ROLLUP_BACKFILL_DAYS` (default `0`, at most 9999; set it on the
worker) also builds days that have none, back that many days or to the oldest trace, ten days
per sweep. With the sweep off the report is slower on long windows and otherwise the same, up to floating-point tolerance and the two cases listed under Limitations in architecture.md (spend of deleted runs, traces committed late). See
[architecture.md](./architecture.md#8-observability--cost).

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
effective-config view behind `/admin/platform-settings`, and the answer to "why is this run behaving that
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

### The audit log

`/admin/audit` (ADMIN only) lists the log newest first, 50 per page, filtered by action, actor,
entity type and a UTC date range. Free-text search matches a person's email or name (as their actor
ids), the entity type as a substring, and an entity or actor id only when the whole UUID is typed —
both id columns are `uuid`, which a substring match cannot reach. The table shortens ids, so a
copied prefix finds nothing.

`GET /api/v1/platform/audit-log/export` returns the same filter as a streamed CSV
(`time,action,actor,entity_type,entity_id,before,after`), newest first, one row per entry. It holds
at most 50,000 rows. `X-Export-Row-Limit` carries that cap and `X-Export-Truncated` is `true` only
when more entries matched than the cap, in which case the file is the newest part of the result and
the page says so with the limit. A cell starting with `=`, `+`, `-`, `@`, tab or carriage return is
prefixed with `'` so a spreadsheet does not run it.

---

## 4. Run-pinned settings

Some values a run makes a structural decision on. If `workflow.maxTransitions` changed halfway
through a run, the second half would disagree with the first, and — because the interpreter's path
is recorded in Temporal history — a replay could diverge from the code that produced it.

Settings marked `runPinned` are therefore resolved once, when the `WorkflowRun` row is created,
and stored on `WorkflowRun.pinnedSettings` alongside the existing agent-version pin. A channel
assistant turn's row is created by `startChannelRun` and pins at the scope the turn's own reads use:
the channel template, the channel, and the channel's team and organization. For the life of
that run, `resolveSetting` reads the snapshot instead of the live cascade, and the effective-config
view reports the value's source as `PINNED`.

Everything else re-resolves on every call. That is what lets a model or credential edit land inside
an already-running workflow rather than waiting for a fresh run.

A snapshot that lacks a key — the row was created before the column existed, or before the setting
was marked `runPinned` — is completed on the run's first read of its context. `currentRequestContext()`
in the worker, which activities resolve their settings through, adds each missing key at the value
that context resolves it to now, so the read that triggered it and every later one see the same
value. `createWorkflowRun` does the same when it runs against an existing row (a retry, or a reused
workflow id). A value already pinned is never changed, and the write is a compare-and-set on the
stored snapshot, so concurrent activities of one run converge on a single pin rather than
overwriting each other. A pin that cannot be written — the database errors, or the row keeps
changing for three attempts — is logged, and the read falls back to the live value; the next
context lookup, after the ~30 s cache window, tries again. A channel turn's missing keys are pinned
at its channel's scope, the same one `startChannelRun` uses.

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

**Clearing a stored secret.** A save can only replace a secret, so
`DELETE /api/v1/platform/config/:integration/secrets/:field` removes one. It accepts the secret
fields of `github` (`token`, `webhookSecret`, `appClientSecret`, `appPrivateKey`), `slack`
(`botToken`, `clientSecret`, `signingSecret`), `issue-tracker` (`apiToken`, `webhookSecret`),
`knowledge-base` and `figma` (`apiToken`); any other field is refused with `NOT_A_SECRET`, and a
field with nothing stored returns `NOT_STORED`. Clearing hands the value back to its environment
variable when one is set, and to "not configured" when it is not. The call is audited.

**Test connection with unsaved values.** The `github`, `slack`, `issue-tracker`, `knowledge-base`
and `figma` `/test` routes accept an optional draft body (the tracker test also takes its
`ticketId`). A field left out, or a secret left blank, uses the stored value. Each test has a host
guard: a stored secret is valid on the stored host only, so a draft that changes the GitHub API
URL, or the tracker or knowledge-base provider or base URL, must carry the secret typed alongside
it. Figma's host is fixed, so a typed token can only reach Figma. A typed URL goes through the same
guard the connector applies at run time: GitHub needs a public address, and the tracker and
knowledge base honour the `allowPrivateNetwork` value on the form. Failures report fixed wording
per status class and never echo the remote response body.

**Outbound URL guard.** Every request to an operator-supplied URL (connector base URLs, MCP
servers, bundle URLs, provider `apiBase` probes, skill sources, CI log links) is checked twice. The
text check (`shared/lib/ssrfGuard.ts`) refuses a bad scheme and a host written as a loopback,
private, link-local or metadata name or address, and is the early error at save time. At
connection time `createGuardedFetch` (`shared/lib/guardedDispatcher.ts`) resolves the host name
once, classifies every address it returns with the same rules (plus multicast and reserved ranges),
and refuses the request if any one is refused, so a public name such as `10.1.1.17.nip.io` or a
rebinding name does not reach an internal host. The connection is then made to an address from that
checked answer (the check is the dispatcher's `lookup`), while TLS server name and `Host` stay the
hostname, so certificate validation is unchanged. A private address is allowed only where the call
site's opt-in (`allowPrivateNetwork`, or an opted-in skill-source host) allows it; loopback,
link-local, unspecified, multicast, reserved and cloud-metadata addresses are refused regardless.
A DNS failure or timeout (5 s) refuses with a fixed message and never echoes resolver detail.
Redirects are followed by hand or refused, so each hop passes through the same guard.
Where one call talks to a single trusted host and may be redirected elsewhere (the CI log download,
an MCP server), the private-network allowance is scoped to that host's origin and every other
origin is checked strictly. The exception is a CI log download for a repository on a GitHub
Enterprise host (not github.com): its log storage lives on the same internal network, so every hop
may resolve to a private address, while loopback, link-local, unspecified, reserved and metadata
addresses stay refused on every hop. The check classifies one source of truth for addresses: besides
loopback, link-local and cloud metadata (including GCP's `fd20:ce::254` and OCI's legacy
`192.0.0.192`), the IETF protocol, documentation, 6to4 relay, Teredo and discard ranges are
refused. The benchmarking block `198.18.0.0/15` is classed with the private networks, because
fake-IP proxy tools (Clash, Surge, sing-box) answer every DNS name with an address in it: it is
refused by default and allowed with the private-network opt-in, so a deployment behind such a tool
needs the opt-in on every connector it uses. Connections use HTTP/1.1 and try the checked addresses IPv4 first. Production
always drives the dispatcher with undici's own `fetch`; only tests substitute one.
`yarn invariants:check` fails a bare `fetch` (a call, a `= fetch` default or `fetch` passed as a
value) in the modules whose requests are all operator-supplied: the bundle, credential-probe, MCP
probe, model-discovery, Atlassian, GitHub Issues, skill-source, MCP tool and GitHub SCM modules.
Octokit and GitHub Enterprise API calls, an aliased `fetch`, and another HTTP client are not seen.

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

- **The audit log's entity-id search is exact.** Only a complete UUID matches an entity or actor id;
  a prefix or fragment returns nothing. The CSV export stops at 50,000 rows, newest first, and the
  rest of a larger result is reachable only by narrowing the filters or date range and exporting
  again. The browser holds the whole file in memory before saving it.
- **Pinning needs a direct connection.** With a process-wide proxy (`NODE_USE_ENV_PROXY`,
  `--use-env-proxy` on the command line or in `NODE_OPTIONS`) the proxy resolves the target, so the
  host is resolved and checked beforehand but the connection cannot be pinned to that answer. The
  check still needs local DNS: a network that only resolves through its proxy fails closed, with the
  fixed "could not be resolved" refusal. A literal IP address is classified as written. The guard does not cover the
  Okta issuer's discovery fetch (made by the sign-in library at start-up), the model providers'
  own SDK calls from the worker, the GitHub Enterprise and Octokit calls (those hosts are governed
  by `github.repositoryHosts`, and a private host is legitimate there), or fixed public hosts such
  as Slack, Linear, Notion and Figma.
- **The draft GitHub test cannot reach a private address.** A GitHub Enterprise host that is written
  as a private address, or whose name resolves to one, is refused when its URL is typed but
  unsaved; the stored configuration is not re-checked by that guard, so save it and test the
  saved values.
- **The registry does not yet cover every compiled-in constant.** Temporal retry and timeout
  profiles (`packages/worker/src/workflows/proxyOptions.ts`), the context-spill budgets in
  `runnableContext.ts`, the model price table in `costTracking.ts`, and several agent loop caps are still
  code. Each is a definition away, but they are not done.
- **`WorkflowDefaults` is platform-wide.** Branch prefix, PR templates, budget tiers, workspace
  sizing, and the TDD/eval iteration caps resolve from one global row and do not cascade to a team.
  Moving them into the registry would give them the cascade; until then `/admin/workflow-defaults` edits them
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
