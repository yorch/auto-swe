# Model & Credential Configuration

> How LLM model selection and provider credentials work in auto-swe.

The DB is the sole source of truth for LLM config — no env vars for models or API keys. The worker calls `assertConfigReady()` at boot and refuses to start until the required rows exist. All edits go through `/admin/model-config` (admins) or `/teams/<id>` (team owners).

---

## Concepts

### Scopes

Every `ModelRoleConfig` row lives at one of three scopes:

| Scope | Discriminator | Purpose |
| ----- | ------------- | ------- |
| `GLOBAL` | none | System-wide default. Exactly one row per role. |
| `TEAM` | `teamId` | Overrides GLOBAL for runs owned by one team. |
| `WORKFLOW_TEMPLATE` | `workflowTemplateId` | Overrides TEAM + GLOBAL for runs of one template. |

The resolver picks the most specific scope row that exists for a given call:

```
WORKFLOW_TEMPLATE → TEAM → GLOBAL → ConfigMissingError
```

A missing GLOBAL row is a startup error, not a runtime condition — `assertConfigReady()` at worker boot catches it before any activity runs.

`ProviderCredential` rows are scoped only `GLOBAL` or `TEAM`. Templates that want to pin a specific credential do so via `ModelRoleConfig.credentialId` pointing at a GLOBAL or TEAM row. The singleton `EmbeddingConfig` row covers the system-wide embedding model — no scope cascade (only one embedding role in the system).

## Per-scope system prompts

`ModelRoleConfig` has an optional `systemPrompt` field. When set, it replaces the agent's hardcoded system prompt for that scope. The cascade works identically to model selection:

```
WORKFLOW_TEMPLATE → TEAM → GLOBAL → (use agent's built-in prompt)
```

The null default (no row has a `systemPrompt`) means the agent uses its built-in prompt unchanged. Setting a prompt at GLOBAL scope overrides it system-wide; a TEAM or WORKFLOW_TEMPLATE row can further refine it for a narrower audience.

Common uses:

- **Team-specific persona** — give the implementer agent extra context about a team's coding standards without modifying the built-in prompt.
- **Template-specific reasoning** — add domain knowledge (e.g. "this is a migration workflow; prefer additive schema changes") to a single template's agent.

The resolver function is `resolveSystemPrompt(role, ctx?)` in `packages/worker/src/lib/models.ts`. Activities call it alongside `getModel()` and pass the result as the `system` field in `agent.generate()`.

---

### Resolution context

Worker activities pick up `{ teamId, workflowTemplateId }` automatically via `currentRequestContext()`, which joins the Temporal `currentWorkflowId()` against `ActiveWorkflow → repository.teamId` and `WorkflowRun.templateId`. Nothing has to be passed through workflow inputs.

### Encryption

API keys are AES-256-GCM encrypted with a per-record 12-byte nonce. The master key is read once from `CONFIG_ENCRYPTION_KEY` (base64-encoded 32 bytes) at process start. Plaintext keys live in memory only during an in-flight request — they are never logged, never returned in API responses (only a `****<lastFour>` mask), and never persisted in the audit log.

### Caching

The worker keeps a process-local 30-second cache of resolved `ModelRoleConfig`, `ProviderCredential`, and `EmbeddingConfig` rows (`packages/worker/src/lib/config/cache.ts`). Tune the TTL with `CONFIG_CACHE_TTL_MS`. The cache holds decrypted plaintext API keys for its TTL window — if you rotate a credential, expect up to `CONFIG_CACHE_TTL_MS` of lag before workers pick it up.

### Bootstrap (fresh deployment)

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — schema + admin user.
2. Start gateway + web only (not the worker yet).
3. Sign in as admin at `/admin/model-config`. Click **Seed Anthropic defaults** on the Roles tab. This creates the 6 GLOBAL `ModelRoleConfig` rows plus the `EmbeddingConfig` singleton.
4. Add at least one `ProviderCredential` on the Credentials tab. For the seeded defaults you need at minimum `anthropic` (for the agent roles) and `openai` (for embeddings).
5. Start the worker. `assertConfigReady()` walks the DB; missing pieces are listed in a single rolled-up error pointing back to the dashboard.

Per-role baked-in defaults used by the seed button (also recorded in `AGENTS.md` §6):

| Role / Slot | Default |
| ----------- | ------- |
| `IMPLEMENTER` / `REVIEWER` / `COMMIT_TO_MEMORY` | `anthropic/claude-opus-4-7` |
| `PLANNER` / `SECURITY_REVIEW` / `VALIDATE_CONTEXT` | `anthropic/claude-sonnet-4-6` |
| Embeddings | `openai/text-embedding-3-large` |

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

Admin-only, via the model-config admin page. Set scope to WORKFLOW_TEMPLATE and supply the template ID. The dashboard's template editor doesn't yet have a built-in section for this; it'll come in a follow-up.

### Rotating an API key

1. **Admin → Model Config → Credentials → Edit \<provider\>**.
2. Paste the new key (the API key field is blank-by-default; an empty submission keeps the existing key).
3. Save. The worker's cache picks up the new key within 30 seconds (or immediately if `CONFIG_CACHE_TTL_MS` is lower); workflows mid-run will use the new key on their next LLM call.

There's no automatic key-version migration yet — the `key_version` column on `provider_credentials` is reserved for future multi-key support.

### Auditing changes

**Admin → Model Config → Audit log** shows the last 100 mutations across model role configs and credentials. Secret material is redacted (only `lastFour` survives in `beforeJson`/`afterJson`). Use this when investigating cost spikes or unexpected behavior changes.

---

## Env vars

The only LLM-related env var is `CONFIG_ENCRYPTION_KEY` — required for the gateway and worker to start. It's a base64-encoded 32-byte AES-256-GCM master key used to encrypt/decrypt `provider_credentials.api_key_ciphertext`. Generate one with `openssl rand -base64 32` or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

`CONFIG_CACHE_TTL_MS` (optional, default 30000) tunes the resolver cache.

There are no env vars for model selection, provider API keys, or embedding settings — all of those live in the DB. If you're upgrading from a previous version that read `*_MODEL` / `ANTHROPIC_API_KEY` / etc., nothing is migrated automatically (the original embedding-config migration was squashed into the consolidated init migration): re-create the model role configs via the "Seed Anthropic defaults" button (which also creates the `EmbeddingConfig` singleton with the historical `openai/text-embedding-3-large` default) and re-enter provider credentials in the dashboard.

---

## Scripted operations

Everything in the dashboard maps 1:1 to gateway endpoints. A few common recipes:

```bash
# Bulk-seed a team's per-role overrides via the admin endpoint.
# Repeat per role; the server upserts on (role, scope, teamId).
TOKEN=<admin-PAT>
curl -X PUT http://localhost:8080/api/v1/admin/model-config \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "role": "IMPLEMENTER",
    "scope": "TEAM",
    "teamId": "<team-uuid>",
    "modelSpec": "anthropic/claude-opus-4-7"
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

Team owners use the parallel `/api/v1/teams/<teamId>/{model-config,credentials}` routes — same shape, scope is forced server-side.

### What happens when you delete a pinned credential

`ModelRoleConfig.credentialId` is `ON DELETE SET NULL`. Deleting a credential row leaves any rows that pinned it pointing at NULL, so the resolver falls back to the standard provider-name credential cascade on the next call. No data loss; just a silent demotion. The audit log captures the credential's removal but not the implicit fallback.

---

## Wire-level details

| Layer | File | Notes |
| ----- | ---- | ----- |
| Prisma schema | `packages/shared/src/prisma/schema.prisma` | `ModelRoleConfig`, `ProviderCredential`, `ConfigAuditLog`, enums |
| Crypto | `packages/shared/src/lib/crypto.ts` | AES-256-GCM helpers |
| Resolver | `packages/worker/src/lib/config/resolver.ts` | Cascade + cache + ConfigMissingError |
| Context lookup | `packages/worker/src/lib/config/contextLookup.ts` | currentWorkflowId → teamId/templateId |
| Startup check | `packages/worker/src/lib/config/assertReady.ts` | Walks every required row at worker boot |
| Worker integration | `packages/worker/src/lib/models.ts` | Async `getModel` / `getModelSpec` (per-role chat models) |
| Embeddings | `packages/worker/src/lib/embeddings.ts` | Reads the singleton `EmbeddingConfig` via `resolveEmbeddingConfig` |
| Gateway routes | `packages/gateway/src/routes/modelConfig.ts` | Admin + team-scoped CRUD, embedding-config CRUD, "Seed defaults" bootstrap, probe |
| Dashboard | `packages/web/src/app/admin/model-config/page.tsx`, `packages/web/src/components/modelConfig/*` | Tabbed admin UI (Roles / Credentials / Embeddings / Audit log) + team detail integration |

---

## Troubleshooting

**Worker exits at boot with `"LLM configuration incomplete"`**: the `assertConfigReady()` startup check found missing GLOBAL rows. The full error lists everything missing. Bring up the gateway + web, sign in as admin, hit "Seed Anthropic defaults" on the Roles tab, add the required `ProviderCredential` rows, then restart the worker.

**`"Provider credential for '<name>' has an apiKey but no apiBase"`** (thrown from `buildModelUncached` or `buildEmbeddingModel`): an OpenAI-compatible credential row exists with an `apiKey` but no `apiBase`. Set the `apiBase` from the dashboard.

**`"ModelRoleConfig for '<role>' pins a credential for a different provider"`**: caught at worker boot by `assertConfigReady`. Either unpin the credential (so the resolver looks one up by provider name) or pick a credential whose `provider` matches the spec.

**Test button returns `"apiBase rejected: host '…' is on a private network"`**: the gateway's SSRF guard blocks loopback / RFC1918 / link-local / `.local` / `.internal` hosts. Use a publicly routable URL or set up a tunnel.

**Model changes don't seem to apply mid-run**: confirm the activity is past the `await getModel(...)` call before you edited. Already-bound `LanguageModel` instances aren't swapped mid-`generate()`; the next call after the cache TTL (default 30s) picks up the new value.
