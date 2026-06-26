# Provider Credential `apiStyle` — Implementation Plan

Spec: docs/specs/2026-06-18-provider-credential-api-style.md
Workspace: branch: feat/provider-credential-api-style
Jira: N/A

## Tasks

### Task 1: Prisma schema + migration

**What**: Add `OpenAIApiStyle` enum (`AUTO`, `CHAT_COMPLETIONS`, `RESPONSES`) and `apiStyle OpenAIApiStyle @default(AUTO) @map("api_style")` field to `ProviderCredential`. Run `yarn db:migrate` to create the migration, then `yarn db:generate` to regenerate the Prisma client.
**Files**: `packages/shared/src/prisma/schema.prisma`, new migration under `packages/shared/src/prisma/migrations/`
**Depends on**: none
**Verify**: `yarn db:generate` succeeds; `prisma.providerCredential.create({ data: { ..., apiStyle: 'CHAT_COMPLETIONS' } })` type-checks; existing rows default to `AUTO` (no data migration needed).

---

### Task 2: Model factory — `wrapWithStoreDisabled` + `buildModelUncached` branches

**What**: In `models.ts`, add `effectiveStyle(apiStyle, apiBase)` helper that coerces `AUTO` → `CHAT_COMPLETIONS` when `apiBase` is set. Update the `openai` branch of `buildModelUncached` to select `.chat()` / `.responses()` / default based on `effectiveStyle`. Implement `wrapWithStoreDisabled(model)` — a `LanguageModelV3` proxy that merges `{ openai: { store: false } }` into `providerOptions` on every `doGenerate` and `doStream` call. Update `resolveModel(spec, apiKey, apiBase, apiStyle?)` to accept the new optional param (default `'AUTO'`). Write unit tests covering all three branches and the `AUTO`+`apiBase` coercion.
**Files**: `packages/worker/src/lib/models.ts`, `packages/worker/src/lib/models.test.ts` (create if absent)
**Depends on**: Task 1
**Verify**: `yarn test --reporter=verbose packages/worker/src/lib/models.test.ts` — all new unit tests pass.

---

### Task 3: Resolver chain — thread `apiStyle` from DB to `getModel`

**What**: Update `decryptRow` in `resolver.ts` to include `apiStyle` from the DB row. Update `resolveProviderCredential` return type to `{ apiBase?: string; apiKey: string; apiStyle: string }`. Add `apiStyle` to `ResolvedModelConfig` in `types.ts`. Update `resolveModelForAgent` in `agentResolver.ts` to pass `apiStyle` into `ResolvedModelConfig`. Update `getModel(role)` in `models.ts` to pass `resolved.model.apiStyle` into `buildModel`.
**Files**: `packages/worker/src/lib/config/resolver.ts`, `packages/worker/src/lib/config/types.ts`, `packages/worker/src/lib/config/agentResolver.ts`, `packages/worker/src/lib/models.ts`
**Depends on**: Task 2
**Verify**: `yarn typecheck` passes with no new errors; `yarn test` passes.

---

### Task 4: Gateway write path — persist `apiStyle` through API

**What**: Add `apiStyle?: 'AUTO' | 'CHAT_COMPLETIONS' | 'RESPONSES'` to `CreateCredentialInput` type and the `updateCredential` body type in `credentialService.ts`. Persist the field in `createCredential` (`data.apiStyle = input.apiStyle ?? 'AUTO'`) and `updateCredential` (write when provided). Add `apiStyle: z.enum(['AUTO', 'CHAT_COMPLETIONS', 'RESPONSES']).default('AUTO').optional()` to the create and update Zod schemas in `modelConfig.ts`. Add integration test: POST a credential with `apiStyle: 'CHAT_COMPLETIONS'`, GET it back, assert value round-trips.
**Files**: `packages/gateway/src/lib/credentialService.ts`, `packages/gateway/src/routes/modelConfig.ts`, `packages/gateway/src/routes/modelConfig.test.ts`
**Depends on**: Task 1
**Verify**: `yarn test --reporter=verbose packages/gateway/src/routes/modelConfig.test.ts` — existing + new tests pass.

---

### Task 5: Admin UI — `apiStyle` field in CredentialsTab

**What**: In the CredentialsTab credential form, add an `apiStyle` `<Select>` with options `AUTO` / `Chat Completions` / `Responses API` and a hint: *"Chat Completions is recommended for gateway and proxy endpoints."*. Pre-populate from the existing credential when editing. Include `apiStyle` in the create/update mutation payload. Add an `API Style` badge column to the credential list table — render only when value is not `AUTO` to keep the default case noise-free.
**Files**: The CredentialsTab component (locate under `packages/web/src/app/admin/model-config/` or a nearby components file)
**Depends on**: Task 4
**Verify**: `yarn dev:web` — credential form shows the select; creating a credential with `CHAT_COMPLETIONS` persists and displays the badge; existing credentials show no badge (AUTO default).

---

## Parallelization note

Tasks 2 and 4 both depend only on Task 1 and touch no shared files — they can run concurrently.
