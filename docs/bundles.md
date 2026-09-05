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
  agents: [defineAgent({ key: 'supportResponder', name: 'Support Responder', /* ... */ })],
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
4. Strips deployment-local IDs and re-establishes `Agent`/`Skill`/template ownership in the target
   deployment.
5. Records the result as an `InstalledBundle` row, marking it `VERIFIED` or `UNVERIFIED`.

Exported templates may embed local connection references (e.g. an `mcp` node's `connectionRef`); the
installer preserves the spec but those references only resolve if a matching `Connection` is created
separately.

## Limitations

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
