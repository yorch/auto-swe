# Bundles — Distribution & Reuse

> A bundle is a versioned, self-describing export of a tagged set of library entities (agents,
> skills, scanner patterns, and templates). It is the portable unit for moving reusable content
> between auto-swe deployments or between an author's local workspace and the platform.

---

## What a bundle carries

Only secret-free, deployment-portable library content is exported:

| Entity | Included |
|---|---|
| `Agent` | Global definitions with `modelSpec` or `inheritsModelFrom`, `systemPrompt`, `skillRefs`, `toolKeys` |
| `Skill` | Name, description, prompt text, `origin`, `isVerified` |
| `ScannerPattern` | Label, type, pattern, flags (safe subset only), `origin` |
| `WorkflowTemplate` | Active version's `WorkflowSpec`, `name`, `description`, `inputSchema`, `origin` |

Connection **instances** (URLs, credentials, team bindings, `mcpConnectionId`) are **never**
exported. A bundle only *declares* the connection types its templates require through
`dependencies`, so an installer can re-wire them to local `Connection` rows.

## Manifest format (v2)

`packages/shared/src/bundle/index.ts` owns the schema and the hashing rules. The manifest looks
like:

```json
{
  "bundleSchemaVersion": 2,
  "metadata": {
    "name": "acme-support-pack",
    "version": "1.0.0",
    "createdAt": "...",
    "contentHash": "sha256-hex",
    "signature": "base64-ed25519",
    "signedBy": "acme-release-key"
  },
  "entities": { "agents": [], "skills": [], "scannerPatterns": [], "templates": [] },
  "dependencies": [{ "connectionType": "slack" }, { "connectionType": "zendesk" }]
}
```

The `contentHash` is a sha256 over the canonicalized manifest **minus** `metadata.contentHash`,
`metadata.signature`, and `metadata.signedBy`. Because the hash covers `metadata.name`,
`metadata.version`, `createdAt`, `source`, and `description`, a bundle's identity is bound to its
content: relabeling or re-versioning a signed bundle invalidates the hash and the signature.
Schema v1 bundles (which signed only entities and dependencies) are rejected outright.

## Trust model

Bundles can be signed offline with an ed25519 private key. On install, the gateway re-derives the
content hash and verifies the detached signature against the deployment's trust anchors.

| Verification | Meaning |
|---|---|
| `VERIFIED` | Signature validates against a key in `BUNDLE_TRUSTED_KEYS` and the content hash matches |
| `UNVERIFIED` | No signature, no matching trusted key, or hash mismatch; install is still allowed but flagged |

`BUNDLE_TRUSTED_KEYS` is env-only (a JSON array of `{ id, publicKeyPem }`) so that DB write access
does not let an attacker mark arbitrary content as verified. `BUNDLE_MAX_BYTES` caps the size of a
bundle fetched from a URL (default 5 MB).

## Authoring a bundle

Use `@auto-swe/sdk` in scripts or the `auto-swe bundle` CLI subcommand (no token required):

```typescript
import { defineAgent, defineBundle, signBundle, validateBundle } from '@auto-swe/sdk';

const manifest = defineBundle({
  name: 'acme-support-pack',
  version: '1.0.0',
  description: 'Support reply agents and skills for Acme',
  agents: [defineAgent({ key: 'acme.supportResponder', name: 'Support Responder', /* ... */ })],
  skills: [defineSkill({ name: 'support-kb-retrieval', promptText: '...' })],
  dependencies: [{ connectionType: 'zendesk' }],
});

const signed = signBundle(manifest, privateKeyPem, 'acme-release-key');
const { ok, errors } = validateBundle(signed);
```

`validateBundle` checks the schema, re-derives the content hash, and runs the same scanner-pattern
safety gate the server applies. It is intentionally pure and synchronous so it runs in CI.

The CLI also scaffolds, validates, and signs:

```bash
auto-swe bundle init ./support-pack --name acme-support-pack --version 1.0.0
auto-swe bundle validate ./support-pack/manifest.json
auto-swe bundle sign ./support-pack/manifest.json --key=release-key.pem
```

`@auto-swe/sdk` is a private workspace package that is never published, so the scaffold's
`package.json` links it from the auto-swe checkout the CLI runs from
(`"@auto-swe/sdk": "link:<checkout>/packages/sdk"`) rather than naming a registry version. Build
that checkout once, and install the scaffold with Yarn or pnpm, which understand `link:`. The
starter agent's key is namespaced by the bundle name (`<name>.reviewer`) so installing the starter
cannot replace the platform's own `reviewer`.

## Installing a bundle

Admin-only routes under `/api/v1/platform/bundles` support install from a file or a URL:

```bash
auto-swe bundles install ./support-pack/manifest.json
auto-swe bundles install-from-url https://releases.acme.example/support-pack/1.0.0/manifest.json
auto-swe bundles list
```

On install the gateway:

1. Parses and validates the manifest schema.
2. Re-derives the content hash and verifies the signature against `BUNDLE_TRUSTED_KEYS`.
3. Validates every scanner pattern for unsafe flags, compile errors, and length limits.
4. Refuses, with `409 PROTECTED_CONTENT_OVERWRITE`, any bundle entry that would replace GLOBAL
   content the deployment owns — a seeded built-in (`origin = 'swe-starter'`, or a core row with a
   null origin) or an admin-authored row (`origin` null): an agent by key, a skill by name, a
   scanner pattern by label, a workflow template by name. The response's `conflicts` names every
   one, by kind. The check runs inside the install transaction, immediately before the writes, so
   it decides on the rows the writes then act on. A bundle may replace its own earlier content
   freely. Passing `overwriteProtected: true` (CLI: `--overwrite-protected`) replaces protected
   content deliberately. Both outcomes are audited against the `Bundle` entity: a refusal records
   the conflicts, and a forced install records exactly which protected keys it replaced
   (`replacedProtected`), not only that the flag was set.
5. Installs a template without rewriting history. A new template is created at v1, ACTIVE, and is
   never made the global default. For an existing template a changed spec is appended as a new
   version — no existing version is rewritten, since runs pin their version — and it becomes active
   only while the template is still ACTIVE on the version the previous install wrote (the newest
   version with no author). A version an admin promoted, or an archived template, is left as it is;
   `isDefault` and `status` are never written on an existing template.
6. Strips deployment-local IDs and re-establishes `Agent`/`Skill`/template ownership in the target
   deployment.
7. Records the result as an `InstalledBundle` row, marking it `VERIFIED` or `UNVERIFIED`.

Exported templates may embed local connection references (e.g. an `mcp` node's `connectionRef`); the
installer preserves the spec but those references only resolve if a matching `Connection` is created
separately.

## Limitations

- **Protection is by origin, and `overwriteProtected` is all-or-nothing.** A row counts as the
  deployment's when its origin is null or `swe-starter`; content another bundle installed can be
  replaced by any later bundle that ships the same key, name or label. A forced install replaces
  every conflict it names — there is no per-entry opt-in.
- **The protected check is not a lock.** It reads inside the install transaction, but a row created
  concurrently by another transaction after that read — a `syncBuiltins` on another gateway booting
  at the same moment — can still be overwritten.
- **A bundle's template versions are indistinguishable from built-in ones.** Both are authorless, so
  "the version the previous install wrote" is the newest authorless version. After a forced install
  over a built-in template, the next built-in sync and the next bundle install each see the other's
  version as the previous one.
- **Bundles do not export connection instances.** A template that needs Zendesk, Slack, or an MCP
  server only declares `dependencies[].connectionType`; the installer must map those to local
  `Connection` rows.
- **No central registry.** There is no auto-swe marketplace or hosted registry; distribution is
  file/URL based and trust is pinned to ed25519 public keys.
- **MCP connection IDs are not portable.** A template spec referencing an `mcp` connection will
  carry a local UUID; another deployment must create an `mcp` `Connection` and update the template
  or the node will fail at run time.
- **Template versions are exported as a single spec.** The active version is frozen into the bundle;
  experiment versions and version history are not carried.
- **Skill/tool bindings are resolved at install time, not at export.** If a bundle references a tool
  or skill key that does not exist in the target, the install succeeds but the agent may fail when
  the workflow reaches that node.
