# Models and credentials

> How LLM model selection and provider credentials work in auto-swe.

The DB is the sole source of truth for LLM config — no env vars for models or API keys. The worker calls `assertConfigReady()` at boot and refuses to start until the required rows exist. All edits go through `/studio/models` (admins) or `/teams/<id>` (team owners).

---

## Concepts

### Scopes

Per-role model + system-prompt config lives on the first-class `Agent` table. Every `Agent` row lives at one of five scopes:

| Scope | Discriminator | Purpose |
| ----- | ------------- | ------- |
| `GLOBAL` | none | System-wide default. Exactly one row per role. |
| `ORGANIZATION` | `orgId` | Overrides GLOBAL for runs owned by teams in one org. |
| `TEAM` | `teamId` | Overrides ORGANIZATION + GLOBAL for runs owned by one team. |
| `CHANNEL` | `channelId` | Overrides TEAM for channel-resident runs only (Slack channel assistant). |
| `WORKFLOW_TEMPLATE` | `workflowTemplateId` | Overrides all lower scopes for runs of one template. |

Per-role model selection lives on `Agent.modelSpec` (`<provider>/<model>`); sub-roles can carry `Agent.inheritsModelFrom` instead to bind a parent role's model, and `Agent.credentialId` pins a specific credential. The resolver picks the most specific scope row that exists for a given call:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL → ConfigMissingError
```

A missing GLOBAL row is a startup error, not a runtime condition — `assertConfigReady()` at worker boot catches it before any activity runs.

`ProviderCredential` rows are scoped `GLOBAL`, `ORGANIZATION`, or `TEAM` — enforced by a DB CHECK, so there is deliberately no channel- or template-level credential tier. Credential resolution cascades `TEAM → ORGANIZATION → GLOBAL`. Templates and channels that want to pin a specific credential do so via `Agent.credentialId` pointing at one of those rows. The singleton `EmbeddingConfig` row covers the system-wide embedding model — no scope cascade (only one embedding role in the system).

## Per-scope system prompts

`Agent` has an optional `systemPrompt` field. When set, it replaces the agent's hardcoded system prompt for that scope. The cascade works identically to model selection:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL → (use agent's built-in prompt)
```

`systemPrompt` cascades **independently of `modelSpec`**: a higher-scope row may set the model and leave `systemPrompt` null, in which case the search for a prompt continues down the cascade. So a team override can change the model without losing the global default prompt, and vice versa.

The null default (no row has a `systemPrompt`) means the agent uses its built-in prompt unchanged. Setting a prompt at GLOBAL scope overrides it system-wide; a TEAM, CHANNEL, or WORKFLOW_TEMPLATE row can further refine it for a narrower audience.

Common uses:

- **Team-specific persona** — give the implementer agent extra context about a team's coding standards without modifying the built-in prompt.
- **Template-specific reasoning** — add domain knowledge (e.g. "this is a migration workflow; prefer additive schema changes") to a single template's agent.

The sole resolver is `resolveAgent(key, ctx)` in `packages/worker/src/lib/config/agentResolver.ts`, which returns the resolved model, system prompt, skills, and tools for a role in one pass; `getModel` / `getModelSpec` in `packages/worker/src/lib/models.ts` are thin shims over it. Activities bind the model and pass the resolved prompt as the `system` field in `agent.generate()`.

---

### Resolution context

Worker activities pick up `{ teamId, workflowTemplateId }` automatically via `currentRequestContext()`, which joins the Temporal `currentWorkflowId()` against `ActiveWorkflow → repository.teamId` and `WorkflowRun.templateId`. Nothing has to be passed through workflow inputs.

### Encryption

API keys are AES-256-GCM encrypted with a per-record 12-byte nonce. The master key is read once from `CONFIG_ENCRYPTION_KEY` (base64-encoded 32 bytes) at process start. Plaintext keys live in memory only during an in-flight request — they are never logged, never returned in API responses (only a `****<lastFour>` mask), and never persisted in the audit log.

### Caching

The worker keeps a process-local 30-second cache of resolved `Agent`, `ProviderCredential`, and `EmbeddingConfig` rows (`packages/shared/src/config/cache.ts`). Tune the TTL with `CONFIG_CACHE_TTL_MS`. The cache holds decrypted plaintext API keys for its TTL window — if you rotate a credential, expect up to `CONFIG_CACHE_TTL_MS` of lag before workers pick it up.

### Model catalog

`model_catalog_entries` holds one row per `<provider>/<model-id>` spec: its `kind` (`CHAT` or
`EMBEDDING`), input and output price in USD per million tokens, and a `status` (`ACTIVE`,
`DEPRECATED`, `RETIRED`) that governs which models are offered, never whether one is priced. The
catalog is global — prices are facts about a vendor, not per-team policy — and a `0`/`0` row is a
known, free model such as a self-hosted endpoint, distinct from an unknown one.

`syncModelCatalog` seeds it at gateway startup from `BUILTIN_MODELS`
(`packages/shared/src/lib/builtinModels.ts`). Code owns a built-in row until an admin edits it:

| Row state | On each startup |
|---|---|
| Missing | Created as built-in |
| Built-in, untouched | Kept in step with code, so a price corrected in code reaches every deployment |
| Built-in, `isCustomized` | Left as the admin set it |
| An admin's own row for a model that later ships built-in | Adopted as built-in and customized, keeping the admin's prices |

Nothing is deleted: a model dropped from `BUILTIN_MODELS` stays priced for the runs that used it.

**Pricing reads the catalog.** Each LLM and embedding call is priced from its spec's catalog row,
falling back to `BUILTIN_MODELS` when the catalog has none — so a model is priced before the gateway
has seeded the catalog. The lookup is exact: a near-miss such as `gpt-5-5` for `gpt-5.5` is unknown
and priced at $0, never at its neighbour's rate. A row with a negative or non-finite price is
skipped. The worker reads the catalog once per config-cache window, so an edit lands within
`CONFIG_CACHE_TTL_MS`; a call's cost is fixed when it is recorded, so an edit never reprices history.
If the catalog cannot be read, pricing uses the last good read, else the built-in table, and retries
after one window — a pricing failure never fails a call.

**Prompt caching is priced from the usage the provider reports.** A call's input total includes the
tokens it read from or wrote to the provider's prompt cache; those are costed at multiples of the
model's input price (`cacheMultipliers` in `builtinModels.ts`), and the rest at the input price.
Anthropic models read at 0.1× and write at 1.25×, on every Claude spec including catalog-only ones;
`openai/gpt-5` reads at 0.1×. Any other model's cached input is priced as ordinary input. The
multipliers scale whatever input price the catalog holds, so a customized price needs no second
edit. The budget tiers still meter every input token, cached or not. The span records the counts as
`llm.cache_read_tokens` and `llm.cache_write_tokens`.

**In the dashboard**, `/studio/models` → **Catalog** lists every model with its price, status and
source — *built-in*, *customized* (an admin's edit, which startup keeps), or *custom* — and, on a
customized row whose shipped values have since changed, what code now ships beside a **Reset**.
Above it, *Unpriced in use* lists the models configured or called in the last 30 days that nothing
prices, each with its likely intended spec and an **Add to catalog** that prefills it. The agent
and embedding model-spec fields are pickers over the catalog — chat models for agents, embedding
models for the embedding config — showing each model's price; a deprecated one is labelled and a
retired one is not offered.

**Discovering new models.** *New from providers* → **Check providers for new models** lists models
through each GLOBAL provider credential — the same list-models endpoints, auth and SSRF guard as the
credential **Test** — and shows the ones nothing prices, each with an **Add** prefilled with its
id, kind and display name. Discovery only suggests: it writes nothing, so a discovered model is not
"known" until an admin adds it with a price.

**The workflow editor's cost estimate** prices each step from the same source. A step's
`costHint` names a role; `GET /model-catalog/role-pricing` — readable by any signed-in user, since
template authors cannot read the agent library — returns, per role, the model its GLOBAL agent runs
(following `inheritsModelFrom`) and that model's catalog price, else its built-in one. A role whose
model nothing prices keeps the estimator's default, which tracks the seeded agents' built-in prices
(`costEstimator.test.ts` fails when they drift apart).

**Setting a price** — for a negotiated rate, a self-hosted model (`0`/`0`), or a model the built-in
table lacks — is a Catalog tab edit, or a call to the catalog API under
`/api/v1/platform/model-catalog` (recipes in [Scripted operations](#scripted-operations)). Any signed-in user can read the catalog; every write
is ADMIN-only, because a price decides what USD budgets see, and is recorded in the config audit log
as a `ModelCatalogEntry`.

| Route | Effect |
|---|---|
| `GET /model-catalog` | Lists the catalog. `?kind=CHAT\|EMBEDDING`; RETIRED rows only with `?includeRetired=true`. A built-in row carries `builtin`, the values code ships, so a customized row shows what it diverges from |
| `POST /model-catalog` | Adds a model. A spec already in the catalog is a `409` |
| `PUT /model-catalog/:id` | Edits prices, `kind`, `status`, `displayName` or `notes` — never `provider` or `modelId`. An edit to a built-in row marks it customized, so startup seeding keeps it |
| `POST /model-catalog/:id/reset` | Restores a built-in row to the values code ships and clears customized |
| `DELETE /model-catalog/:id` | Removes a custom row. A built-in row is a `409` — startup would re-create it; set it RETIRED |
| `GET /model-catalog/unpriced` | Specs in use that nothing prices, each with where it is used and the spec it most likely meant |
| `POST /model-catalog/discover` | Lists models through each GLOBAL credential and returns, per provider, the ones nothing prices — or why that provider could not be listed. Writes nothing |

**Unpriced models are reported on save, and refused at run time only under a USD cap.** Saving an agent version or the embedding config
returns `catalogWarnings` beside `scanWarnings` when its model is not priced (with a did-you-mean
such as `gpt-5-5` → `gpt-5.5`), is DEPRECATED or RETIRED, or is the wrong `kind`. The save still
succeeds: a model released today, a self-hosted endpoint or a pinned version must not be blocked on a
price. `/model-catalog/unpriced` collects the same gap across every active agent, the embedding
config, and the models recorded LLM calls used in the last 30 days.

At run time a model with no price is refused only where a USD-denominated cap would otherwise stop
counting: an organization with a monthly budget (every run whose ledger row reaches that
organization: the implementer and its fix sessions, the review network, planner, decomposers,
security gate, memory passes, and generic `agent` nodes) and a channel with a monthly budget. The
refusal is a non-retryable `MODEL_UNPRICED` naming the model; while the catalog cannot be read it is
a retryable `MODEL_PRICE_UNAVAILABLE`. Without such a cap the call proceeds at $0.

`MODEL_PRICE_<PROVIDER>_<MODEL>` environment overrides are not read. The worker names any that are
set at startup.

### Bootstrap (fresh deployment)

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — schema + admin user.
2. Start gateway + web only (not the worker yet).
3. The DB seed already created the built-in `Agent` rows — 17 model-backed with default model specs, plus 11 sub-role personas that inherit a parent's model — along with the `EmbeddingConfig` singleton. Sign in as admin and add a `ProviderCredential` at `/studio/models` → Credentials.
4. Add at least one `ProviderCredential` on the Credentials tab. For the seeded defaults you need at minimum `anthropic` (for the agent roles) and `openai` (for embeddings).
5. Start the worker. `assertConfigReady()` walks the DB; missing pieces are listed in a single rolled-up error pointing back to the dashboard.

Per-role baked-in defaults seeded onto the GLOBAL Agents (also recorded in `AGENTS.md`):

| Role / Slot | Default |
| ----------- | ------- |
| `implementer` / `reviewer` / `commitToMemory` / `channelAssistant` / `workflowAuthor` | `anthropic/claude-opus-5-5` |
| `planner` / `securityReview` / `validateContext` / `workflowExplainer` | `anthropic/claude-sonnet-5-5` |
| `evalJudge` | `anthropic/claude-haiku-4-5-20251001` (distinct model to avoid self-preference bias) |
| Embeddings | `openai/text-embedding-3-large` |

The 11 sub-role personas carry no `modelSpec` — each binds its parent's model via
`inheritsModelFrom`. `contentWriter`, `brandReviewer`, `supportResponder`, `productAnalyst`,
`prdWriter`, and `issueDrafter` are model-backed agents added for the non-SWE workflow packs. Full roster in [`agents.md` §1](./agents.md#1-agents).

When a seeded default changes, the startup sync moves an existing deployment forward only where
nobody chose otherwise. A built-in GLOBAL Agent whose latest version still carries the default it
was seeded with (`PREVIOUS_DEFAULT_MODEL_SPECS` in `shared/src/lib/syncBuiltins.ts`) gets a new
version on the current default, copying every other field and its skill refs — the same new-version
cut the Agent library makes for an admin's edit. The old version is never rewritten, so a run
already pinned to it keeps the model it started with; new runs pick up the new version. Any other
value — a different model, a scoped override, a deactivated lineage — is left alone.

---

## Day-2 operations

### Adding a new provider

Pick a name (`opencodego`, `groq`, `bedrock`, …). If the provider speaks the OpenAI Chat Completions API, it's plug-and-play:

1. Sign into the dashboard as an admin → **Admin → Model Config → Credentials → + New credential**.
2. Provider name: lowercase kebab-case, e.g. `opencodego`.
3. Scope: GLOBAL (visible everywhere) or TEAM.
4. API base: e.g. `https://opencode.ai/zen/go/v1`.
5. API key: paste from your password manager — you won't see it again after save.
6. Click **Test** to verify the credential works (issues a `GET <base>/models` probe).

If the provider speaks a different API (e.g. Anthropic-style `/v1/messages`), you need a code change in `packages/worker/src/lib/models.ts` `buildModelUncached()` to construct the right SDK client. The current built-ins are `anthropic`, `openai`, `google`; everything else routes through `@ai-sdk/openai-compatible`.

### Overriding a model for one team

1. **Teams → \<team-slug\> → Team overrides**.
2. Pick the role row → **Override** → enter a model spec (e.g. `openai/gpt-6.1-sol`).
3. Optionally pin a specific credential (the picker shows GLOBAL + this team's TEAM-scope creds).

Removes via the **Reset** button. Resetting causes the next activity call for that role to fall back to GLOBAL.

### Overriding a model for one workflow template

Admin-only, from the Agent library at `/studio/agents/library`. Create an Agent for the key with scope `WORKFLOW_TEMPLATE` and supply the template ID. The template editor itself carries no model section — template-scoped overrides are edited in the Agent library.

### Rotating an API key

1. **Admin → Model Config → Credentials → Edit \<provider\>**.
2. Paste the new key (the API key field is blank-by-default; an empty submission keeps the existing key).
3. Save. The worker's cache picks up the new key within 30 seconds (or immediately if `CONFIG_CACHE_TTL_MS` is lower); workflows mid-run will use the new key on their next LLM call.

This rotates the *provider's* key, not the master key auto-swe encrypts it with. For that, see below.

### Rotating `CONFIG_ENCRYPTION_KEY`

The master key wrapping every stored secret. `decryptSecret` picks its key by the row's
`key_version`, so old and new can coexist for the length of a rotation:

```bash
# 1. New key
openssl rand -base64 32

# 2. Set on BOTH gateway and worker, then restart both
CONFIG_ENCRYPTION_KEY=<new>
CONFIG_ENCRYPTION_KEY_VERSION=<old version + 1>    # default is 1
CONFIG_ENCRYPTION_KEY_PREVIOUS=<old>

# 3. Check, then rotate
yarn keys:rotate --dry-run
yarn keys:rotate

# 4. Once it reports nothing left, drop CONFIG_ENCRYPTION_KEY_PREVIOUS and restart
```

`yarn keys:rotate` runs through `tsx`, a devDependency, so it works from a checkout but not
inside a production image (`yarn workspaces focus --production` strips it). There, run the
compiled entry point directly:

```bash
node packages/shared/dist/scripts/rotateEncryptionKey.js --dry-run
node packages/shared/dist/scripts/rotateEncryptionKey.js
```

Step 2 is what makes this safe against a live deployment: rows written under the old key still
decrypt, while new writes are stamped with the new version. The rotation is resumable — a row
already at the target version is skipped — and it never writes a row it could not read, so an
interrupted run leaves a mix of versions that a re-run finishes.

`CONFIG_ENCRYPTION_KEY_PREVIOUS` holds exactly one older key, the version immediately below the
current one. That is the only state a rotation passes through; a general version→key map would let
arbitrarily many retired keys linger, which is the opposite of the point.

**Do not drop the previous key while `yarn keys:rotate` still reports failures.** It exits non-zero
and names each row it could not decrypt; those rows are left untouched and are unrecoverable if the
key that wrote them is gone.

### Auditing changes

**Admin → Model Config → Audit log** shows the last 100 mutations across agent configs and credentials. Secret material is redacted (only `lastFour` survives in `beforeJson`/`afterJson`). Use this when investigating cost spikes or unexpected behavior changes.

---

## Env vars

The only LLM-related env var is `CONFIG_ENCRYPTION_KEY` — required for the gateway and worker to start. It's a base64-encoded 32-byte AES-256-GCM master key used to encrypt/decrypt `provider_credentials.api_key_ciphertext`. Generate one with `openssl rand -base64 32` or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

`CONFIG_CACHE_TTL_MS` (optional, default 30000) tunes the resolver cache.

There are no env vars for model selection, provider API keys, or embedding settings — all of those live in the DB. If you're upgrading from a previous version that read `*_MODEL` / `ANTHROPIC_API_KEY` / etc., nothing is migrated automatically: the DB seed creates the model-backed `Agent` rows (with default specs) + the `EmbeddingConfig` singleton (historical `openai/text-embedding-3-large` default); re-enter provider credentials in the dashboard.

---

## Scripted operations

Everything in the dashboard maps 1:1 to gateway endpoints. A few common recipes:

Per-agent model, prompt, skills, and tools all live on the `Agent` entity, so they are written
through the **agent-library** API — there is no separate model-config write endpoint. Agent keys are
free-form strings (`implementer`, not `IMPLEMENTER`), and every write cuts a new immutable version.

```bash
TOKEN=<admin-PAT>

# Override one agent's model for one team. Scope discriminators are exclusive:
# TEAM scope takes teamId and nothing else.
curl -X POST http://localhost:8080/api/v1/platform/agent-library \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "key": "implementer",
    "name": "Implementer (payments override)",
    "scope": "TEAM",
    "teamId": "<team-uuid>",
    "modelSpec": "anthropic/claude-opus-5-5"
  }'

# Rotate a credential (admin scope). Provider + scope are immutable; only
# apiBase and apiKey can change.
curl -X PUT http://localhost:8080/api/v1/platform/credentials/<credential-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"apiKey": "sk-ant-new..."}'

# Probe a credential (issues a list-models HTTP call).
curl -X POST http://localhost:8080/api/v1/platform/credentials/<credential-id>/test \
  -H "Authorization: Bearer $TOKEN"

# Price a self-hosted model as free.
curl -X POST http://localhost:8080/api/v1/platform/model-catalog \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider": "ollama", "modelId": "llama-4", "inputUsdPerMTok": 0, "outputUsdPerMTok": 0}'

# Apply a negotiated rate to a built-in model (marks it customized), then undo it.
curl -X PUT http://localhost:8080/api/v1/platform/model-catalog/<entry-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputUsdPerMTok": 3.5, "outputUsdPerMTok": 17}'
curl -X POST http://localhost:8080/api/v1/platform/model-catalog/<entry-id>/reset \
  -H "Authorization: Bearer $TOKEN"

# Which models in use have no price?
curl http://localhost:8080/api/v1/platform/model-catalog/unpriced \
  -H "Authorization: Bearer $TOKEN"

# What do the providers offer that the catalog lacks?
curl -X POST http://localhost:8080/api/v1/platform/model-catalog/discover \
  -H "Authorization: Bearer $TOKEN"
```

Team owners use the parallel team-scoped routes — `/api/v1/teams/<teamId>/agent-library` for agent
overrides and `/api/v1/teams/<teamId>/credentials` for credentials. Same shapes; scope is forced
server-side. Full endpoint table in [`agents.md` §9](./agents.md#9-skill--agent-library-api).

### What happens when you delete a pinned credential

`Agent.credentialId` is `ON DELETE SET NULL`. Deleting a credential row leaves any rows that pinned it pointing at NULL, so the resolver falls back to the standard provider-name credential cascade on the next call. No data loss; just a silent demotion. The audit log captures the credential's removal but not the implicit fallback.

---

## Wire-level details

| Layer | File | Notes |
| ----- | ---- | ----- |
| Prisma schema | `packages/shared/src/prisma/schema.prisma` | `Agent`, `ProviderCredential`, `ConfigAuditLog`, enums |
| Crypto | `packages/shared/src/lib/crypto.ts` | AES-256-GCM helpers |
| Resolver | `packages/worker/src/lib/config/agentResolver.ts`, `packages/worker/src/lib/config/resolver.ts` | `resolveAgent` (Agent overlay) + cascade + cache + ConfigMissingError |
| Context lookup | `packages/worker/src/lib/config/contextLookup.ts` | currentWorkflowId → teamId/templateId |
| Startup check | `packages/worker/src/lib/config/assertReady.ts` | Walks every required row at worker boot |
| Worker integration | `packages/worker/src/lib/models.ts` | Async `getModel` / `getModelSpec` (per-role chat models) |
| Embeddings | `packages/worker/src/lib/embeddings.ts` | Reads the singleton `EmbeddingConfig` via `resolveEmbeddingConfig` |
| Gateway routes | `packages/gateway/src/routes/modelConfig.ts` | Admin + team-scoped credential CRUD, embedding-config CRUD, audit log, credential probe |
| Gateway routes | `packages/gateway/src/routes/modelCatalog.ts` + `lib/modelCatalogService.ts` | Model catalog CRUD and reset, the unpriced report, and the `catalogWarnings` agent and embedding saves return |
| Dashboard | `packages/web/src/app/studio/models/page.tsx`, `packages/web/src/components/modelConfig/*` | Tabbed admin UI (Roles / Credentials / Embeddings / Audit log) + team detail integration |

---

## Troubleshooting

**Worker exits at boot with `"LLM configuration incomplete"`**: the `assertConfigReady()` startup check found missing GLOBAL rows. The full error lists everything missing. Bring up the gateway + web, sign in as admin, add the required `ProviderCredential` rows (the agents themselves are seeded), then restart the worker.

**`"Provider credential for '<name>' has an apiKey but no apiBase"`** (thrown from `buildModelUncached` or `buildEmbeddingModel`): an OpenAI-compatible credential row exists with an `apiKey` but no `apiBase`. Set the `apiBase` from the dashboard.

**`"Agent for '<role>' pins a credential for a different provider"`**: caught at worker boot by `assertConfigReady`. Either unpin the credential (so the resolver looks one up by provider name) or pick a credential whose `provider` matches the spec.

**Test button returns `"apiBase rejected: host '…' is on a private network"`**: the gateway's SSRF guard blocks loopback / RFC1918 / link-local / `.local` / `.internal` hosts. Use a publicly routable URL or set up a tunnel.

**Model changes don't seem to apply mid-run**: confirm the activity is past the `await getModel(...)` call before you edited. Already-bound `LanguageModel` instances aren't swapped mid-`generate()`; the next call after the cache TTL (default 30s) picks up the new value.

---

## Limitations

- **The config cache means edits are eventually consistent.** Model config is cached in-process with
  a ~30 s TTL (`CONFIG_CACHE_TTL_MS`) and gateway and worker are separate processes, so the two can
  briefly disagree after an edit. A `generate()` call already in flight keeps the model it bound.
- **Pricing is keyed on the resolved `provider/model` spec.** A model with no catalog row and no
  `BUILTIN_MODELS` entry records usage at **zero cost** — the span carries
  `llm.cost_pricing_known=false` — wherever no USD cap applies. Per-run budget tiers are enforced on
  tokens, so an unpriced model is still capped there. Where an organization or channel monthly
  budget applies, the call is refused instead (see above). Embedding calls and the eval harness are
  not covered by that refusal, and a cost shown for a run on an unpriced model is $0.
- **The editor's cost estimate prices GLOBAL defaults.** It uses the model each role's GLOBAL agent
  runs, so a team, organization or template override of that agent's model is not reflected, and
  token counts come from each step's static `costHint`, not from measured runs.
- **Discovery runs only on demand, through GLOBAL credentials.** Nothing checks providers on a
  schedule, and a model reachable only through a team or organization credential is not listed.
  It suggests by name, not by capability: speech, transcription, image, video and moderation models
  are dropped by a name filter that can miss one or drop one it should not, and outside Google —
  which says which methods a model serves — whether a model is chat or embedding is read from its
  id. Up to five pages per provider are followed.
- **The model pickers suggest; they do not restrict.** A spec the catalog lacks can be typed and
  saved, and is recorded at $0 until it is added — the save's `catalogWarnings` and the unpriced
  panel say so, but nothing blocks it.
- **Unpriced-model detection is exact-match plus a heuristic.** The did-you-mean only proposes a
  priced spec that differs by `.`/`-` or case, or the single nearest spec from the same provider
  within two edits; a model it cannot match is reported with no suggestion.
- **Prices are base rates apart from prompt caching.** Data-residency and fast-mode premiums and
  long-context surcharges are not modelled, so a call that used them is recorded at the base rate.
- **Cache rates are code, not catalog data.** They cannot be edited from the dashboard. Only the
  models named above carry a discount, so a cached read on any other model is recorded at the full
  input price, which overstates it. Anthropic one-hour cache writes (2× input) are priced at the
  five-minute rate.
- **No batch pricing.** Nothing calls a provider's batch API, so the batch discount never applies.
- **Credential resolution has no fallback past GLOBAL.** The TEAM → ORGANIZATION → GLOBAL cascade
  ends there; a missing GLOBAL row is a `ConfigMissingError`, not a silent skip.
- **Embeddings are locked to 1536 dimensions.** `memory_items.embedding` is `vector(1536)`, so a
  model returning any other shape throws. Changing dimension is a migration plus a re-embed of every
  `MemoryItem`, and there is no tooling for it.
- **The boot check reflects install state at boot.** `assertConfigReady` gates on the agents the
  installed templates can reach. Activating a template afterwards is not re-checked, so a newly
  reachable agent with no credential fails at its node instead of at startup. Restart the worker to
  restore fail-fast.
