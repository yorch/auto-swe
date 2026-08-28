# Model & Credential Configuration

> How LLM model selection and provider credentials work in auto-swe.

The DB is the sole source of truth for LLM config — no env vars for models or API keys. The worker calls `assertConfigReady()` at boot and refuses to start until the required rows exist. All edits go through `/admin/model-config` (admins) or `/teams/<id>` (team owners).

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

The worker keeps a process-local 30-second cache of resolved `Agent`, `ProviderCredential`, and `EmbeddingConfig` rows (`packages/worker/src/lib/config/cache.ts`). Tune the TTL with `CONFIG_CACHE_TTL_MS`. The cache holds decrypted plaintext API keys for its TTL window — if you rotate a credential, expect up to `CONFIG_CACHE_TTL_MS` of lag before workers pick it up.

### Bootstrap (fresh deployment)

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — schema + admin user.
2. Start gateway + web only (not the worker yet).
3. The DB seed already created the built-in `Agent` rows — 13 model-backed with default model specs, plus 11 sub-role personas that inherit a parent's model — along with the `EmbeddingConfig` singleton. Sign in as admin and add a `ProviderCredential` at `/admin/model-config` → Credentials.
4. Add at least one `ProviderCredential` on the Credentials tab. For the seeded defaults you need at minimum `anthropic` (for the agent roles) and `openai` (for embeddings).
5. Start the worker. `assertConfigReady()` walks the DB; missing pieces are listed in a single rolled-up error pointing back to the dashboard.

Per-role baked-in defaults seeded onto the GLOBAL Agents (also recorded in `AGENTS.md`):

| Role / Slot | Default |
| ----------- | ------- |
| `implementer` / `reviewer` / `commitToMemory` / `channelAssistant` / `workflowAuthor` | `anthropic/claude-opus-4-8` |
| `planner` / `securityReview` / `validateContext` / `workflowExplainer` | `anthropic/claude-sonnet-4-6` |
| `evalJudge` | `anthropic/claude-haiku-4-5-20251001` (distinct model to avoid self-preference bias) |
| Embeddings | `openai/text-embedding-3-large` |

The 11 sub-role personas carry no `modelSpec` — each binds its parent's model via
`inheritsModelFrom`. `contentWriter` is a model-backed agent added for the document workspace. Full roster in [`agents.md` §1](./agents.md#1-agents).

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
2. Pick the role row → **Override** → enter a model spec (e.g. `openai/gpt-5-5`).
3. Optionally pin a specific credential (the picker shows GLOBAL + this team's TEAM-scope creds).

Removes via the **Reset** button. Resetting causes the next activity call for that role to fall back to GLOBAL.

### Overriding a model for one workflow template

Admin-only, from the Agent library at `/admin/agents/library`. Create an Agent for the key with scope `WORKFLOW_TEMPLATE` and supply the template ID. The template editor itself carries no model section — template-scoped overrides are edited in the Agent library.

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
curl -X POST http://localhost:8080/api/v1/admin/agent-library \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "key": "implementer",
    "name": "Implementer (payments override)",
    "scope": "TEAM",
    "teamId": "<team-uuid>",
    "modelSpec": "anthropic/claude-opus-4-8"
  }'

# Rotate a credential (admin scope). Provider + scope are immutable; only
# apiBase and apiKey can change.
curl -X PUT http://localhost:8080/api/v1/admin/credentials/<credential-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"apiKey": "sk-ant-new..."}'

# Probe a credential (issues a list-models HTTP call).
curl -X POST http://localhost:8080/api/v1/admin/credentials/<credential-id>/test \
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
| Dashboard | `packages/web/src/app/admin/model-config/page.tsx`, `packages/web/src/components/modelConfig/*` | Tabbed admin UI (Roles / Credentials / Embeddings / Audit log) + team detail integration |

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
- **Pricing is keyed on the resolved `provider/model` spec.** A model with no `MODEL_PRICES` entry
  and no `MODEL_PRICE_*` override records usage at **zero cost** rather than failing — the span
  carries `llm.cost_pricing_known=false`. Budget caps are enforced on tokens, so an unpriced model
  is still capped, but its USD figures read as $0.
- **Credential resolution has no fallback past GLOBAL.** The TEAM → ORGANIZATION → GLOBAL cascade
  ends there; a missing GLOBAL row is a `ConfigMissingError`, not a silent skip.
- **Embeddings are locked to 1536 dimensions.** `memory_items.embedding` is `vector(1536)`, so a
  model returning any other shape throws. Changing dimension is a migration plus a re-embed of every
  `MemoryItem`, and there is no tooling for it.
- **The boot check reflects install state at boot.** `assertConfigReady` gates on the agents the
  installed templates can reach. Activating a template afterwards is not re-checked, so a newly
  reachable agent with no credential fails at its node instead of at startup. Restart the worker to
  restore fail-fast.
