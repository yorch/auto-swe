# Model & Credential Configuration

> How LLM model selection and provider credentials work in auto-swe.

If you're reading this because env vars don't seem to be taking effect anymore: that's intentional — they're a first-boot seed only. All ongoing changes go through the dashboard or the gateway API.

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
WORKFLOW_TEMPLATE → TEAM → GLOBAL → env-var fallback
```

`ProviderCredential` rows are scoped only `GLOBAL` or `TEAM`. Templates that want to pin a specific credential do so via `ModelRoleConfig.credentialId` pointing at a GLOBAL or TEAM row.

### Resolution context

Worker activities pick up `{ teamId, workflowTemplateId }` automatically via `currentRequestContext()`, which joins the Temporal `currentWorkflowId()` against `ActiveWorkflow → repository.teamId` and `WorkflowRun.templateId`. Nothing has to be passed through workflow inputs.

### Encryption

API keys are AES-256-GCM encrypted with a per-record 12-byte nonce. The master key is read once from `CONFIG_ENCRYPTION_KEY` (base64-encoded 32 bytes) at process start. Plaintext keys live in memory only during an in-flight request — they are never logged, never returned in API responses (only a `****<lastFour>` mask), and never persisted in the audit log.

### Caching

The worker keeps a process-local 30-second cache of resolved `ModelRoleConfig` and `ProviderCredential` rows (`packages/worker/src/lib/config/cache.ts`). Negative results — env-fallback specs and missing credentials — are NOT cached, so a freshly-inserted row takes effect on the next call. Tune the TTL with `CONFIG_CACHE_TTL_MS`.

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

## How env vars interact

Env vars are consulted in three cases only:

1. **First worker boot on a fresh DB.** `seedConfigFromEnv()` reads `*_MODEL` and provider `*_API_KEY` / `*_API_BASE` pairs, encrypts the keys, and inserts GLOBAL rows. Idempotent: subsequent boots are no-ops unless someone empties the tables.
2. **Resolver env-fallback path.** If the GLOBAL row for a role doesn't exist (DB blip during seed, unit tests, etc.), the resolver falls back to reading `<ROLE>_MODEL` directly. Returns scope `ENV_FALLBACK`.
3. **Embeddings spec.** `EMBEDDING_MODEL` is read directly from env on every embedding call (default `openai/text-embedding-3-large`). The corresponding API key still flows through the credential resolver, but the model selection itself is intentionally not in the DB — there's only one embedding role in the system, so a per-role table would be overkill. Output must be 1536-dim or `generateEmbedding` throws (pgvector column is fixed-width).

Auto-discovery scans `*_API_BASE` env vars during seed; opt out with `LLM_PROVIDER_AUTODISCOVER=false`. A built-in blocklist skips known non-LLM prefixes (see `AUTODISCOVER_BLOCKLIST` in `packages/worker/src/lib/config/resolver.ts` for the canonical list).

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
| Resolver | `packages/worker/src/lib/config/resolver.ts` | Cascade + cache |
| Context lookup | `packages/worker/src/lib/config/contextLookup.ts` | currentWorkflowId → teamId/templateId |
| Seed | `packages/worker/src/lib/config/seed.ts` | Env → DB on first boot |
| Worker integration | `packages/worker/src/lib/models.ts` | Async `getModel` / `getModelSpec` (per-role chat models) |
| Embeddings | `packages/worker/src/lib/embeddings.ts` | Spec from `EMBEDDING_MODEL` env var (one role across the system); credentials still go through the resolver |
| Gateway routes | `packages/gateway/src/routes/modelConfig.ts` | Admin + team-scoped CRUD + probe |
| Dashboard | `packages/web/src/app/admin/model-config/page.tsx`, `packages/web/src/components/modelConfig/*` | Tabbed admin UI + team detail integration |

---

## Troubleshooting

**"Provider credential for '\<name\>' has an apiKey but no apiBase"** (thrown from `buildModelUncached` or `buildEmbeddingModel`): an OpenAI-compatible credential row exists with an `apiKey` but no `apiBase`. Set the `apiBase` from the dashboard, or delete the row and let the env-fallback take over.

**Dashboard shows a credential I didn't add at GLOBAL scope**: the first-boot seed scanned env vars and found a `<X>_API_BASE` + `<X>_API_KEY` pair. Delete it from the dashboard, or set `LLM_PROVIDER_AUTODISCOVER=false` before the next fresh boot.

**Test button returns "apiBase rejected: host '…' is on a private network"**: the gateway's SSRF guard blocks loopback / RFC1918 / link-local / `.local` / `.internal` hosts. Use a publicly routable URL or set up a tunnel.

**Model changes don't seem to apply mid-run**: confirm the activity is past the `await getModel(...)` call before you edited. Already-bound `LanguageModel` instances aren't swapped mid-`generate()`; the next call after the cache TTL (default 30s) picks up the new value.

**Worker boot logs `[config] env→DB seed failed (non-fatal)`**: the DB was unreachable at the moment of seeding. The worker still comes up; activities run via the env-fallback path until the DB recovers and the next role's first call writes through.
