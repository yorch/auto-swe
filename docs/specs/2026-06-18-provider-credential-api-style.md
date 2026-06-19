# Provider Credential `apiStyle` — OpenAI API surface control

Jira: N/A
Date: 2026-06-18

## Problem

`@ai-sdk/openai` v3 changed its default callable (`createOpenAI()(modelId)`) from
`OpenAIChatLanguageModel` (Chat Completions at `/v1/chat/completions`) to
`OpenAIResponsesLanguageModel` (Responses API at `/v1/responses`). This breaks in
two distinct ways:

1. **Gateways / proxies** (e.g. SentinelOne's Serenity Model Gateway) may not implement
   `/v1/responses` for all models. Sending a Chat Completions model to the Responses API
   endpoint returns HTTP 404.

2. **Zero Data Retention (ZDR) organisations** — OpenAI's Responses API stores conversation
   items server-side and references them by ID (`fc_…`) across turns. ZDR orgs never persist
   those items, so the second turn of any tool-calling loop returns:
   `"Item … not found. Items are not persisted for Zero Data Retention organizations."`

Since `auto-swe` must support both official OpenAI and third-party gateway endpoints, a
per-credential switch is needed to control which API surface the worker uses.

## Approach

Add an `apiStyle` field to `ProviderCredential` with three values:

| Value             | Behaviour |
|-------------------|-----------|
| `AUTO`            | SDK default — currently Responses API for the `openai` provider. Use only for official OpenAI without ZDR. If `apiBase` is set on the credential the runtime treats this as `CHAT_COMPLETIONS` automatically. |
| `CHAT_COMPLETIONS` | Force `createOpenAI(...).chat(modelId)` → `/v1/chat/completions`. Works with every gateway, ZDR-safe, stateless by design. |
| `RESPONSES`       | Force `createOpenAI(...).responses(modelId)` → `/v1/responses` with `store: false` injected into every generate call, making it stateless (full `input` sent each turn, no server-side item references). Use only when the gateway explicitly supports the Responses API AND codex-class models are required. |

Default: `AUTO`. The runtime additionally coerces `AUTO` → `CHAT_COMPLETIONS` when
`apiBase` is set, so existing gateway credentials work without any manual change.

## Design

### Data layer

```prisma
enum OpenAIApiStyle {
  AUTO
  CHAT_COMPLETIONS
  RESPONSES
}

model ProviderCredential {
  // … existing fields …
  apiStyle  OpenAIApiStyle  @default(AUTO)  @map("api_style")
}
```

Migration: `packages/shared/src/prisma/migrations/<timestamp>_provider_credential_api_style/`.

### Resolver layer (`packages/worker/src/lib/config/`)

`resolver.ts` — `resolveProviderCredential` and `decryptRow` return the new field:
```ts
{ apiBase?: string; apiKey: string; apiStyle: OpenAIApiStyle }
```

`types.ts` — `ResolvedModelConfig` gains:
```ts
apiStyle: 'AUTO' | 'CHAT_COMPLETIONS' | 'RESPONSES';
```

`agentResolver.ts` — `resolveModelForAgent` passes `apiStyle` from the credential
through into `ResolvedModelConfig`.

### Model factory (`packages/worker/src/lib/models.ts`)

`buildModelUncached` receives `apiStyle` and selects the factory branch:

```ts
function effectiveStyle(apiStyle: OpenAIApiStyle, apiBase?: string): OpenAIApiStyle {
  return apiStyle === 'AUTO' && apiBase ? 'CHAT_COMPLETIONS' : apiStyle;
}

case 'openai': {
  const factory = createOpenAI({ apiKey, baseURL: apiBase });
  switch (effectiveStyle(apiStyle, apiBase)) {
    case 'CHAT_COMPLETIONS': return factory.chat(modelId);
    case 'RESPONSES':        return wrapWithStoreDisabled(factory.responses(modelId));
    default:                 return factory(modelId);          // AUTO — SDK default
  }
}
```

`wrapWithStoreDisabled` is a thin `LanguageModelV3` proxy that merges
`{ openai: { store: false } }` into `providerOptions` on every `doGenerate` /
`doStream` call. This keeps the injection at the model layer so no call site
changes are needed.

`getModel(role)` and `resolveModel(spec, apiKey, apiBase)` are updated to thread
`apiStyle` through. `resolveModel`'s signature gains an optional `apiStyle` parameter
(default `'AUTO'`) to keep existing callers (tests, CLI) unbroken.

### Gateway API (`packages/gateway/src/`)

`routes/modelConfig.ts` — add `apiStyle` to the create and update Zod schemas:
```ts
apiStyle: z.enum(['AUTO', 'CHAT_COMPLETIONS', 'RESPONSES']).optional()
```

`lib/credentialService.ts` — `CreateCredentialInput` and the `updateCredential` body
type gain `apiStyle?: OpenAIApiStyle`. Both `createCredential` and `updateCredential`
persist the field when provided (omit = keep existing / use DB default).

### Admin UI (`packages/web/`)

`CredentialsTab` credential form gains an `apiStyle` `<Select>` with three options and
a contextual hint: *"Chat Completions is recommended for all gateway and proxy endpoints.
Responses API requires a ZDR-compatible setup."*

The existing credential list table adds an `API Style` column (badge, hidden when `AUTO`
to keep the default case noise-free).

## Acceptance Criteria

- When a `ProviderCredential` has `apiStyle = CHAT_COMPLETIONS`, the worker calls
  `POST /v1/chat/completions` (never `/v1/responses`) for all agent generate calls
  backed by that credential.
- When `apiStyle = AUTO` and `apiBase` is set, the worker behaves identically to
  `CHAT_COMPLETIONS` — no `/v1/responses` call is made.
- When `apiStyle = AUTO` and `apiBase` is null (official OpenAI), the worker uses the
  SDK default (currently Responses API).
- When `apiStyle = RESPONSES`, every generate call includes `store: false` in the
  request body and never references a `previous_response_id`.
- Existing credentials without an explicit `apiStyle` value resolve to `AUTO` with no
  data migration required (Postgres column default covers them).
- The admin credential form allows reading and updating `apiStyle`; the value is
  round-tripped correctly through the gateway API.
- All existing gateway route tests pass without modification (the new field is optional).

## Out of Scope

- Non-`openai` providers (`anthropic`, `google`, `openai-compatible`) — `apiStyle` is
  stored on the credential row for all providers but only `buildModelUncached`'s
  `openai` branch reads it. Other branches are unaffected.
- Automatic ZDR detection at credential-save time (deferred — requires a test request
  to the provider, adds latency and a new failure mode).
- Per-agent or per-model `apiStyle` override (credential-level granularity is sufficient;
  finer control can be added later if needed).

## Risks & Open Questions

- **`wrapWithStoreDisabled` correctness** — the proxy must forward all `LanguageModelV3`
  interface methods faithfully. Risk: low; the interface is stable and the wrapper is
  narrow. *Resolved: implement and verify with a unit test.*
- **`RESPONSES` + multi-turn tool loop with `store: false`** — with `store: false` the
  SDK must send the full `input` array on each turn instead of a `previous_response_id`.
  Verify `@ai-sdk/openai` v3 handles this correctly; if not, `RESPONSES` mode is
  effectively non-functional for tool-calling. *Needs spike during implementation.*
- **Codex models on ZDR via `RESPONSES`** — if the SDK doesn't send full history with
  `store: false`, these models remain unusable on ZDR orgs regardless of this change.
  Acceptable: the mode is explicitly opt-in and the docs note the ZDR requirement.
  *Deferred.*

## Testing

- **Unit** — `buildModelUncached` branches: assert `.chat()` called for `CHAT_COMPLETIONS`,
  `.responses()` called for `RESPONSES`, and the `AUTO`+`apiBase` coercion.
- **Unit** — `wrapWithStoreDisabled`: assert `store: false` is present in the merged
  `providerOptions` passed to the underlying model's `doGenerate`.
- **Integration** — gateway `POST /api/v1/admin/model-config/credentials` and `PUT …/:id`:
  round-trip `apiStyle` through the API and verify DB persistence.
- **Manual** — submit a job with `apiStyle = CHAT_COMPLETIONS` against SMG and confirm
  `executeImplementation` reaches the tool-calling loop without 404.
