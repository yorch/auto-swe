# Provider credential private-network opt-in — Implementation Plan

Spec: docs/specs/2026-10-07-provider-credential-private-network.md
Workspace: worktree: .claude/worktrees/provider-credential-private-network (branch `provider-credential-private-network`, off `origin/main`)
Jira: N/A

## Progress

- [ ] Task 1: Store the flag and honour it at admin save time
- [ ] Task 2: Keep the flag out of team admins' hands
- [ ] Task 3: Credential probe honours the flag, scoped to its origin
- [ ] Task 4: Model discovery honours the flag
- [ ] Task 5: "Allow private network" checkbox on the admin credential form
- [ ] Task 6: Document the opt-in and the unguarded runtime path

## Tasks

### Task 1: Store the flag and honour it at admin save time

**What**: First run `yarn install` and `yarn db:generate` in the worktree, so the gates and the
lefthook hooks run. Read the `prisma-pgvector-hnsw` skill before touching the schema. Add
`allowPrivateNetwork Boolean @default(false) @map("allow_private_network")` to `ProviderCredential`,
and add the column to the `CREATE TABLE "provider_credentials"` statement in the
`00000000000000_init` baseline. This is the repo's convention: recent schema changes edit the
baseline in place.
- `redactCredential` returns the flag. `createCredential` and `updateCredential` persist it.
- `CredentialCreateSchema` and `CredentialUpdateSchema` accept `allowPrivateNetwork: z.boolean().optional()`.
- `createCredentialAndAudit` and `updateCredentialAndAudit` validate with
  `checkProbeUrl(apiBase, { allowPrivate })` instead of `isSafeProbeUrl`. On update, both the
  effective `apiBase` and the effective flag are the body value if present, else the stored value
  (AC 4). The check therefore runs whenever either of them changes, not only when `apiBase` is sent.
**Files**: `packages/shared/src/prisma/schema.prisma`, `packages/shared/src/prisma/migrations/00000000000000_init/migration.sql`, `packages/gateway/src/lib/credentialService.ts`, `packages/gateway/src/routes/modelConfig.ts`, `packages/gateway/src/routes/modelConfig.ssrf.test.ts`
**Depends on**: none
**Verify**: New cases for AC 1–4 in `modelConfig.ssrf.test.ts`, red then green:
`yarn vitest run packages/gateway/src/routes/modelConfig.ssrf.test.ts`. Then `yarn typecheck`.

### Task 2: Keep the flag out of team admins' hands

**What**: The team create route (`TeamCredentialCreate`) and the team update route
(`/:id/credentials/:credId`) return `403 FORBIDDEN` when the body has the
`allowPrivateNetwork` key, whatever its value, before any write (AC 5). Check for the key in the
handler: Zod strips unknown keys before the handler sees them, so the team schemas declare the key
as `z.unknown().optional()` purely so it can be detected. When a team update changes `apiBase` on
a credential with the flag set, the team route passes `allowPrivateNetwork: false` alongside it
(AC 6). The new `apiBase` is then validated strictly by Task 1's check.
**Files**: `packages/gateway/src/routes/modelConfig.ts`, `packages/gateway/src/routes/modelConfig.test.ts`
**Depends on**: Task 1
**Verify**: AC 5–6 cases in `modelConfig.test.ts`, red then green:
`yarn vitest run packages/gateway/src/routes/modelConfig.test.ts`.

### Task 3: Credential probe honours the flag, scoped to its origin

**What**:
- `modelListRequest` takes `allowPrivateNetwork?: boolean` and validates `apiBase` with
  `checkProbeUrl(apiBase, { allowPrivate })`. Built-in providers keep their fixed URLs.
- Add one exported helper in `modelDiscovery.ts`, `fetchModelList(request, allowPrivate, init)`.
  It fetches through `createOriginScopedFetch(allowPrivate ? [new URL(url).origin] : [])`, so the
  waiver covers only that origin (AC 10).
- `probeCredential` takes the flag and uses the helper. `POST /credentials/:id/test` passes
  `cred.allowPrivateNetwork`.
- Tests inject a resolver/classifier through `GuardOptions` rather than reaching the network. If
  the helper needs a test seam for that, it takes an optional `GuardOptions` argument, the same way
  the existing guarded-fetch tests do.
**Files**: `packages/shared/src/lib/modelDiscovery.ts`, `packages/shared/src/lib/modelDiscovery.test.ts`, `packages/gateway/src/lib/credentialService.ts`, `packages/gateway/src/lib/credentialService.probe.test.ts`
**Depends on**: Task 1
**Verify**: AC 7, 8 and 10 cases, red then green:
`yarn vitest run packages/shared/src/lib/modelDiscovery.test.ts packages/gateway/src/lib/credentialService.probe.test.ts`.
Cases: private host + flag → status returned; private host, no flag → `blocked address`; loopback or
metadata + flag → `blocked address`; a second, private-resolving origin through the same fetch →
refused.

### Task 4: Model discovery honours the flag

**What**: `discoverProviderModels` passes `cred.allowPrivateNetwork` to `listProviderModels`,
which passes it to `modelListRequest` and fetches through Task 3's `fetchModelList` instead of the
module-level strict `guardedFetch`. Remove that module-level fetch if this change leaves it unused.
The worker's `discoverModels` activity calls `discoverProviderModels` unchanged, so it picks the
flag up without edits.
**Files**: `packages/shared/src/lib/modelDiscovery.ts`, `packages/shared/src/lib/modelDiscovery.test.ts`
**Depends on**: Task 3
**Verify**: AC 9 case (plus AC 8 for discovery) in `modelDiscovery.test.ts`:
`yarn vitest run packages/shared/src/lib/modelDiscovery.test.ts packages/worker/src/activities/discoverModels.test.ts`.

### Task 5: "Allow private network" checkbox on the admin credential form

**What**: Add an "Allow private network" checkbox to the create and edit forms in
`CredentialsTab.tsx`. It is unchecked by default and pre-filled from the credential when editing.
Copy the label and help text of `McpPrivateNetworkField` (`studio/mcp/page.tsx`) rather than
extracting a shared component: it is page-local, and two copies don't justify an abstraction. The
form sends `allowPrivateNetwork` on create and on update. The credential type in
`useModelConfig.ts` gains `allowPrivateNetwork: boolean`, and the mutation bodies accept it.
**Files**: `packages/web/src/components/modelConfig/CredentialsTab.tsx`, `packages/web/src/components/modelConfig/CredentialsTab.test.ts`, `packages/web/src/hooks/useModelConfig.ts`
**Depends on**: Task 1
**Verify**: AC 11 case in `CredentialsTab.test.ts`:
`yarn vitest run packages/web/src/components/modelConfig/CredentialsTab.test.ts`, then
`yarn typecheck`. Manual check with `yarn dev:web`: the checkbox renders on `/studio/models` →
Credentials.

### Task 6: Document the opt-in and the unguarded runtime path

**What**:
- `docs/configuration.md` "Outbound URL guard": name provider credentials among the call sites
  that have an `allowPrivateNetwork` opt-in, scoped to the credential's origin, and ADMIN-only.
- `docs/model-configuration.md`: describe the checkbox and when to use it (LAN/VPN/Tailscale model
  servers; built-in providers behind corporate DNS or fake-IP proxies). Explain that loopback stays
  refused, and that `host.docker.internal` or a LAN address is the way to reach a model server
  running on the host.
- Add to its `## Limitations` section that the worker's runtime model and embedding calls are not
  routed through the outbound guard.
- Present tense only, with no status prose (CLAUDE.md §5).
**Files**: `docs/configuration.md`, `docs/model-configuration.md`
**Depends on**: Tasks 1–5
**Verify**: `yarn docs:check` and `yarn invariants:check` pass. Then the full gates: `yarn typecheck`,
`yarn test`, and `yarn biome check defaults docs infra packages scripts site biome.json package.json tsconfig.base.json vitest.config.ts`
(explicit paths, because this is a worktree).
