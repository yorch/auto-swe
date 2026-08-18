import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { z } from 'zod';
import {
  checkRegexSafety,
  MAX_PATTERN_SOURCE_LENGTH,
  MAX_SKILL_PROMPT_TEXT_LENGTH,
} from '../lib/regexSafety.js';

/**
 * Bundle format (P4/WS1) — a versioned, self-describing export of a *tagged set*
 * of library entities, portable across deployments.
 *
 * Only secret-free, deployment-portable library content travels in a bundle:
 * Agents, Skills, scanner patterns, and Templates. Connection **instances**
 * (which hold URLs/credentials and team bindings) are NEVER exported — a bundle
 * only *declares* the connection types its content requires, via `dependencies`.
 * Deployment-local fields (ids, team/credential/mcp bindings, timestamps,
 * versions) are stripped on export and re-established on install.
 *
 * ## Schema version history
 *
 * - **v1** — `contentHash` covered `{ entities, dependencies }` ONLY. The bundle's
 *   *identity* (`metadata.name`, `metadata.version`, `createdAt`, `source`) was
 *   outside the signed payload, so a vendor-signed bundle could be relabelled to
 *   any name/version and still install as VERIFIED (and `InstalledBundle` upserts
 *   by name, so signed content could shadow another bundle's identity), and an old
 *   signed release could be replayed under a bumped version string.
 * - **v2** — `contentHash` covers the WHOLE manifest minus the three fields that
 *   cannot be self-referential (`metadata.contentHash`, `metadata.signature`,
 *   `metadata.signedBy`). Identity is therefore signed.
 *
 * **v1 bundles are rejected, not silently re-interpreted.** {@link parseBundle}
 * throws {@link BundleSchemaVersionError} for any non-current schema version, so a
 * v1 bundle can never verify under the v2 rules (its hash would simply mismatch,
 * but failing early gives an actionable error instead of "content hash mismatch").
 * Publishers must re-emit and re-sign with a current toolchain.
 */
export const BUNDLE_SCHEMA_VERSION = 2 as const;

export const SCANNER_PATTERN_TYPES = [
  'INJECTION',
  'EXFILTRATION',
  'SHELL_COMMAND',
  'CODE_SECURITY',
  'SENSITIVE_FILE',
] as const;

export const BundleSkillSchema = z.object({
  description: z.string().nullable().optional(),
  isVerified: z.boolean().optional(),
  name: z.string().min(1),
  origin: z.string().nullable().optional(),
  // Same length cap as the admin API (`POST /admin/skills`): a bundle must not
  // be a way to smuggle in a promptText the API would refuse.
  promptText: z.string().max(MAX_SKILL_PROMPT_TEXT_LENGTH),
});

/** A skill attachment on an exported Agent, referenced by skill name. */
export const BundleAgentSkillSchema = z.object({
  skill: z.string().min(1),
  sortOrder: z.number().int().optional(),
});

export const BundleAgentSchema = z.object({
  description: z.string().nullable().optional(),
  inheritsModelFrom: z.string().nullable().optional(),
  isVerified: z.boolean().optional(),
  key: z.string().min(1),
  modelSpec: z.string().nullable().optional(),
  name: z.string().min(1),
  origin: z.string().nullable().optional(),
  skills: z.array(BundleAgentSkillSchema).optional(),
  systemPrompt: z.string().nullable().optional(),
  toolKeys: z.array(z.string()).nullable().optional(),
});

export const BundleScannerPatternSchema = z.object({
  // Safe flag subset only (i,m,s,u,v) — `g`/`y` are rejected to prevent the
  // stateful-lastIndex bug in cached RegExps, mirroring the scanner-pattern API.
  flags: z
    .string()
    .regex(/^[imsuv]*$/, 'flags may only contain i, m, s, u, v')
    .optional(),
  label: z.string().min(1).max(200),
  origin: z.string().nullable().optional(),
  // Same length cap as the admin API (`POST /admin/scanner-patterns`): a bundle
  // must not be a way to smuggle in a pattern the API would refuse.
  pattern: z.string().min(1).max(MAX_PATTERN_SOURCE_LENGTH),
  type: z.enum(SCANNER_PATTERN_TYPES),
});

export const BundleTemplateSchema = z.object({
  description: z.string().optional(),
  inputSchema: z.unknown().nullable().optional(),
  name: z.string().min(1),
  origin: z.string().nullable().optional(),
  /**
   * The active version's WorkflowSpec, exported verbatim. NOTE: a spec may embed
   * deployment-local references — e.g. an `mcp` node's `connectionRef` (a local
   * Connection id) — which won't resolve on another deployment; the `dependencies`
   * manifest flags the required connection types so the installer can re-wire them.
   */
  spec: z.unknown(),
});

export const BundleEntitiesSchema = z.object({
  agents: z.array(BundleAgentSchema).default([]),
  scannerPatterns: z.array(BundleScannerPatternSchema).default([]),
  skills: z.array(BundleSkillSchema).default([]),
  templates: z.array(BundleTemplateSchema).default([]),
});

/** A connector/connection type the bundle's content needs present in the target. */
export const BundleDependencySchema = z.object({ connectionType: z.string().min(1) });

export const BundleMetadataSchema = z.object({
  /**
   * sha256 over the canonicalized manifest minus `contentHash`/`signature`/`signedBy`
   * — integrity check on install. Covers `name` and `version`, so the bundle's
   * identity is bound to its content (see the schema-version history above).
   */
  contentHash: z.string(),
  createdAt: z.string(),
  description: z.string().optional(),
  name: z.string().min(1),
  /** Detached base64 signature over `contentHash`; absent = unsigned. */
  signature: z.string().optional(),
  /** Label/id of the key that signed it (informational; verified against trusted keys). */
  signedBy: z.string().optional(),
  /** Free-form provenance, e.g. the origin tag or source deployment. */
  source: z.string().optional(),
  version: z.string().min(1),
});

export const BundleManifestSchema = z.object({
  bundleSchemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
  dependencies: z.array(BundleDependencySchema).default([]),
  entities: BundleEntitiesSchema,
  metadata: BundleMetadataSchema,
});

export type BundleSkill = z.infer<typeof BundleSkillSchema>;
export type BundleAgent = z.infer<typeof BundleAgentSchema>;
export type BundleScannerPattern = z.infer<typeof BundleScannerPatternSchema>;
export type BundleTemplate = z.infer<typeof BundleTemplateSchema>;
export type BundleEntities = z.infer<typeof BundleEntitiesSchema>;
export type BundleDependency = z.infer<typeof BundleDependencySchema>;
export type BundleMetadata = z.infer<typeof BundleMetadataSchema>;
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** Thrown when a manifest declares a bundle schema version this build cannot trust. */
export class BundleSchemaVersionError extends Error {}

/** Guard against unbounded recursion on a hostile/cyclic in-memory object. */
const MAX_STRINGIFY_DEPTH = 100;

/**
 * Deterministic JSON: object keys sorted recursively so the hash is stable.
 *
 * Three properties this must keep, because the hash is a trust boundary:
 * - `undefined`-valued keys are dropped (matches a JSON round-trip).
 * - `toJSON()` is honoured, so a `Date` canonicalizes to its ISO string rather
 *   than to `{}` — two different instants must never collide.
 * - Cycles throw instead of recursing forever (a cyclic manifest can only come
 *   from in-memory construction; a parsed one is always a tree).
 */
function stableStringify(value: unknown, seen: Set<object> = new Set(), depth = 0): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (depth > MAX_STRINGIFY_DEPTH) {
    throw new Error('cannot canonicalize: object nested too deeply');
  }
  if (seen.has(value)) {
    throw new Error('cannot canonicalize: circular reference');
  }
  // `toJSON` first — Date/Decimal-like objects must serialize to their value,
  // not to `{}` (every Date would otherwise hash identically).
  const withToJson = value as { toJSON?: (key?: string) => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return stableStringify(withToJson.toJSON(), seen, depth + 1);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v, seen, depth + 1)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    // Skip `undefined`-valued keys so the hash matches a JSON round-trip (JSON
    // and Zod `.optional()` reparse both DROP undefined keys — emitting them
    // would make an in-memory manifest hash differently from its posted form).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen, depth + 1)}`
    );
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Everything the content hash covers: the whole manifest except the three
 * metadata fields that cannot be inside their own input.
 */
export interface ContentHashInput {
  bundleSchemaVersion: number;
  dependencies: BundleDependency[];
  entities: BundleEntities;
  metadata: Omit<BundleMetadata, 'contentHash' | 'signature' | 'signedBy'> &
    Partial<Pick<BundleMetadata, 'contentHash' | 'signature' | 'signedBy'>>;
}

/**
 * sha256 over the canonicalized manifest, excluding only `metadata.contentHash`
 * (self-referential) and `metadata.signature` / `metadata.signedBy` (applied
 * *over* the hash). Stable across key ordering, so the same manifest always
 * hashes identically regardless of export iteration order.
 *
 * Identity (`name`, `version`, `createdAt`, `source`, `description`) is inside the
 * hash — a signature over the hash therefore binds content to identity, and a
 * relabelled or version-bumped copy of a signed bundle fails the integrity gate
 * before the signature is even considered. Taking the whole manifest rather than
 * an explicit field list means a metadata field added later is signed by default.
 */
export function computeContentHash(input: ContentHashInput): string {
  const { contentHash: _hash, signature: _sig, signedBy: _by, ...signedMetadata } = input.metadata;
  return createHash('sha256')
    .update(
      stableStringify({
        bundleSchemaVersion: input.bundleSchemaVersion,
        dependencies: input.dependencies,
        entities: input.entities,
        metadata: signedMetadata,
      })
    )
    .digest('hex');
}

/**
 * Parse + validate a raw object into a BundleManifest (throws on malformed input).
 * A recognisably-older schema version gets a dedicated, actionable error rather
 * than a generic Zod literal mismatch — see the schema-version history above.
 */
export function parseBundle(input: unknown): BundleManifest {
  const declared = (input as { bundleSchemaVersion?: unknown } | null)?.bundleSchemaVersion;
  if (typeof declared === 'number' && declared !== BUNDLE_SCHEMA_VERSION) {
    throw new BundleSchemaVersionError(
      `unsupported bundleSchemaVersion ${declared} (this deployment requires ${BUNDLE_SCHEMA_VERSION}). ` +
        'Schema v1 signed only entities+dependencies, leaving metadata.name/version unsigned; ' +
        'such bundles are not accepted. Re-export and re-sign the bundle with a current toolchain.'
    );
  }
  return BundleManifestSchema.parse(input);
}

/**
 * Re-derive the content hash and compare it to the manifest's declared
 * `metadata.contentHash`. The single integrity gate shared by `installBundle`
 * (server) and the SDK's `validateBundle` (authoring) so they can't drift.
 */
export function verifyContentHash(manifest: BundleManifest): {
  ok: boolean;
  expected: string;
} {
  const expected = computeContentHash(manifest);
  return { expected, ok: expected === manifest.metadata.contentHash };
}

/**
 * Check every scanner pattern the bundle carries for compile errors, unsafe
 * flags, and over-long bodies — the same syntax-and-size gate the admin API
 * applies at `POST /admin/scanner-patterns`, shared here so install cannot be a
 * back door around it. Bundle install is reachable with an UNVERIFIED bundle, so
 * this must run regardless of trust state.
 *
 * It makes NO claim about execution cost. A bundle can carry a pattern that
 * backtracks catastrophically; what stops that from wedging a process is the
 * wall-clock budget every scanner runs patterns under (`lib/regexExec.ts`), not
 * this function. Bundle validation is pure and synchronous by contract (the SDK
 * depends on it), and the empirical probe the admin API layers on top needs a
 * worker thread, so it does not run here.
 *
 * Returns one message per offending pattern; empty means all are acceptable.
 */
export function validateBundleScannerPatterns(manifest: BundleManifest): string[] {
  const errors: string[] = [];
  for (const p of manifest.entities.scannerPatterns) {
    const issue = checkRegexSafety(p.pattern, p.flags ?? '');
    if (issue) {
      errors.push(`scanner pattern '${p.label}' [${issue.code}]: ${issue.message}`);
    }
  }
  return errors;
}

/** A deployment-trusted signing key (the trust anchor for VERIFIED bundles). */
export interface TrustedKey {
  id: string;
  publicKeyPem: string;
}

/**
 * Produce a detached base64 signature over a bundle's `contentHash`.
 * ed25519 (algorithm `null` per Node's API for Ed25519). Used by signing tooling
 * and tests; the platform only ever *verifies*.
 *
 * Since v2 the hash covers the manifest's identity as well as its content, so
 * this signature binds `name`/`version` too.
 */
export function signContentHash(privateKeyPem: string, contentHash: string): string {
  return cryptoSign(
    null,
    Buffer.from(contentHash, 'utf8'),
    createPrivateKey(privateKeyPem)
  ).toString('base64');
}

/**
 * Verify a bundle's detached signature against the deployment's trusted keys.
 * Returns `{ verified: true, signedBy }` for the first trusted key whose public
 * half validates the signature over `contentHash`; otherwise `{ verified: false }`.
 * Unsigned bundles and bad keys never throw — they're simply not verified.
 *
 * The declared `contentHash` is re-derived first: a signature is only ever
 * meaningful for a manifest whose hash actually matches its own content and
 * identity, so a relabelled bundle carrying an authentic (name-free) signature
 * can never come back VERIFIED, even if a caller skips the integrity gate.
 */
export function verifyBundleSignature(
  manifest: BundleManifest,
  trustedKeys: TrustedKey[]
): { verified: boolean; signedBy: string | null } {
  const sig = manifest.metadata.signature;
  if (!sig || !verifyContentHash(manifest).ok) {
    return { signedBy: null, verified: false };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(sig, 'base64');
  } catch {
    return { signedBy: null, verified: false };
  }
  const data = Buffer.from(manifest.metadata.contentHash, 'utf8');
  for (const key of trustedKeys) {
    try {
      if (cryptoVerify(null, data, createPublicKey(key.publicKeyPem), signature)) {
        return { signedBy: key.id, verified: true };
      }
    } catch {
      // ignore malformed trusted key; try the next
    }
  }
  return { signedBy: null, verified: false };
}
