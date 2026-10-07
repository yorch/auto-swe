# Provider credential private-network opt-in

Jira: N/A
Date: 2026-10-07
Status: Approved
Last reviewed: 2026-10-07

## Problem

A provider credential whose host resolves to a private address cannot be tested or used for model
discovery. Examples are a self-hosted OpenAI-compatible server on a LAN, VPN or Tailscale IP, or a
built-in provider whose public hostname resolves privately behind corporate DNS or a fake-IP proxy.
The credential probe (`POST /credentials/:id/test`) and `discoverProviderModels` run through
`createGuardedFetch()` with no private-network allowance, so they fail with the fixed string
`blocked address`. A host spelled as a private name or address (`10.0.0.5`, `*.internal`) is
already refused at save time with `400 UNSAFE_API_BASE`.

The worker's runtime model and embedding calls (`models.ts`, `embeddings.ts`) are not guarded, so
such a credential would work in a run. It cannot be verified or discovered from the admin UI, and
cannot be saved at all when its host is written as a private address.

Every other operator-supplied URL that may legitimately be internal (tracker, knowledge base, MCP
connection) already has an `allowPrivateNetwork` opt-in. Provider credentials do not.

## Approach

Add `allowPrivateNetwork` to `ProviderCredential`, with the same semantics as the connectors' and
MCP connections' opt-in. Private addresses (RFC 1918, CGNAT, ULA, `198.18/15`) are waived for that
credential's own origin only. Loopback, link-local, unspecified, reserved and cloud-metadata
addresses stay refused. Only a platform ADMIN may set the flag. It applies to every provider,
built-in or OpenAI-compatible.

## Design

- **Schema.** `ProviderCredential.allowPrivateNetwork Boolean @default(false)`, mapped to
  `allow_private_network`. Per repo convention the column is added to the `00000000000000_init`
  baseline migration. `redactCredential` returns the flag, so it appears in API responses and in
  the audit-log `before`/`after`.
- **One request builder, one fetch.** `modelListRequest` (shared by the probe and discovery) gains
  `allowPrivateNetwork`. It validates `apiBase` with `checkProbeUrl(apiBase, { allowPrivate })`
  instead of `isSafeProbeUrl`. Both callers fetch through
  `createOriginScopedFetch(allowPrivate ? [origin of request.url] : [])`, so the waiver covers
  exactly the host the request is built for. For a built-in provider that host is the fixed
  provider URL. Redirects stay `manual`, as today.
- **Save time.** `createCredentialAndAudit` and `updateCredentialAndAudit` validate with
  `checkProbeUrl(apiBase, { allowPrivate: effectiveFlag })`. On update, the effective flag and
  `apiBase` are the body value if present, else the stored value. The update is partial, like the
  rest of `CredentialUpdateSchema`, so turning the flag on or off alone re-validates the stored
  `apiBase`.
- **Permission.** The admin schemas (`CredentialCreateSchema`, `CredentialUpdateSchema`) accept
  `allowPrivateNetwork: z.boolean().optional()`. The team routes (`TeamCredentialCreate`, team
  update) reject a body carrying the field with `403 FORBIDDEN`. That way a team admin learns the
  flag was not applied, instead of having it silently stripped. A team-route update that changes
  `apiBase` on a credential with the flag set resets it to `false`, because the platform admin
  opted in a host, not whatever host comes next.
- **UI.** `CredentialsTab.tsx` gets a "Allow private network" checkbox on the create and edit
  forms, matching the wording and help text of the MCP page's `McpPrivateNetworkField`. It is
  shown on the admin `/studio/models` page only, not on the team credential view.

Alternative considered and discarded: a platform-wide setting listing private hosts (like
`skills.import.privateNetworkHosts`). A per-credential flag matches the connector and MCP
precedent, and it travels with the URL it trusts.

## Acceptance Criteria

1. When an ADMIN creates a credential with `apiBase: "http://10.0.0.5:8000/v1"` and
   `allowPrivateNetwork: true`, the system shall return `201`, and the response `data` shall carry
   `allowPrivateNetwork: true`.
2. If an ADMIN creates that credential without `allowPrivateNetwork`, then the system shall return
   `400 UNSAFE_API_BASE`, as today.
3. If an ADMIN creates a credential with `apiBase: "http://127.0.0.1:11434/v1"` (or
   `http://169.254.169.254/`) and `allowPrivateNetwork: true`, then the system shall return
   `400 UNSAFE_API_BASE` with a reason containing `never allowed`.
4. When an ADMIN sends `PATCH` with only `allowPrivateNetwork: false` to a credential whose stored
   `apiBase` is private, the system shall return `400 UNSAFE_API_BASE` and leave the row unchanged.
5. If a team-admin create or update request body contains `allowPrivateNetwork` (any value), then
   the system shall return `403 FORBIDDEN` and write nothing.
6. When a team-admin update changes `apiBase` on a credential with `allowPrivateNetwork: true`, the
   system shall store `allowPrivateNetwork: false`. The new `apiBase` is validated strictly.
7. When `probeCredential` runs for a credential with `allowPrivateNetwork: true` whose host
   resolves to `10.0.0.5`, the request shall be sent and the probe shall return the HTTP status.
   With the flag `false`, it shall return `error: 'blocked address'`.
8. While `allowPrivateNetwork` is `true`, a host resolving to `127.0.0.1` or `169.254.169.254`
   shall still yield `blocked address` from the probe and from discovery.
9. When `discoverProviderModels` lists a GLOBAL credential with `allowPrivateNetwork: true` whose
   host resolves to a private address, that provider's entry shall have `ok: true`.
10. The private-network waiver shall apply only to the origin of the credential's list-models URL:
    a request from the same fetch to any other origin that resolves privately shall be refused.
11. The `/studio/models` credential create and edit forms shall render an "Allow private network"
    checkbox, unchecked by default, that sends `allowPrivateNetwork` on save.

## Out of Scope

- Guarding the worker's runtime model and embedding calls. They are unguarded today, and adding a
  guard there is a separate, wider change. Recorded as a limitation in
  `docs/model-configuration.md`.
- Allowing loopback with the opt-in. It stays never-allowed, as everywhere else. A model server on
  the host is reached through `host.docker.internal` or a LAN address.
- Letting team admins set the flag.
- Changing the fixed `blocked address` wording.

## Risks & Open Questions

- **Gateway as an SSRF proxy into the private network (Resolved).** With the flag, an ADMIN can
  make the gateway connect to an internal host. The probe returns only a status, and discovery
  returns only model ids. The flag is ADMIN-only, origin-scoped, audited, and off by default.
  The same trust the MCP opt-in already grants.
- **Schema change (Resolved).** The column is additive with a `false` default, so existing rows
  keep today's behaviour. No feature flag is warranted beyond the per-row opt-in itself.
- **DNS rebinding (Resolved).** Unchanged. The guarded dispatcher pins the connection to the
  checked addresses.

## Testing

- `packages/shared`: `modelListRequest` and `discoverProviderModels` with an injected resolver,
  covering private allowed, private refused, and loopback/metadata refused with the flag
  (AC 7–10).
- `packages/gateway`: `modelConfig` route tests via `app.inject()` for AC 1–6, plus
  `credentialService` probe tests.
- `packages/web`: `CredentialsTab` test for the checkbox (AC 11).
- `yarn docs:check`, `yarn invariants:check`, typecheck, lint (with explicit paths, since this is a
  worktree), and `yarn test`.
