/**
 * @auto-swe/sdk — authoring SDK for the distribution layer (P4/WS5).
 *
 * Typed helpers to define library entities and assemble a signed, versioned
 * {@link BundleManifest} programmatically, plus a local validation harness — the
 * third authoring surface alongside the dashboard and the API. Pure functions
 * over `@auto-swe/shared/bundle`; no I/O, so they run anywhere (CI, scripts).
 */
import {
  BUNDLE_SCHEMA_VERSION,
  type BundleAgent,
  type BundleDependency,
  type BundleEntities,
  type BundleManifest,
  type BundleScannerPattern,
  type BundleSkill,
  type BundleTemplate,
  computeContentHash,
  parseBundle,
  signContentHash,
  validateBundleScannerPatterns,
  verifyContentHash,
} from '@auto-swe/shared/bundle';
import type { ContainerStepNode } from '@auto-swe/shared/workflow';

// ── Entity helpers — identity functions that pin the type for editor help. ──
export const defineAgent = (a: BundleAgent): BundleAgent => a;
export const defineSkill = (s: BundleSkill): BundleSkill => s;
export const defineScannerPattern = (p: BundleScannerPattern): BundleScannerPattern => p;
export const defineTemplate = (t: BundleTemplate): BundleTemplate => t;

/** Build a `containerStep` workflow node (coded capability) for embedding in a template spec. */
export const defineContainerStep = (node: Omit<ContainerStepNode, 'type'>): ContainerStepNode => ({
  ...node,
  type: 'containerStep',
});

export interface DefineBundleInput {
  name: string;
  version: string;
  description?: string;
  source?: string;
  agents?: BundleAgent[];
  skills?: BundleSkill[];
  scannerPatterns?: BundleScannerPattern[];
  templates?: BundleTemplate[];
  dependencies?: BundleDependency[];
}

/**
 * Assemble a {@link BundleManifest} from entities, computing the content hash.
 * The result validates against `BundleManifestSchema` and installs as-is.
 */
export function defineBundle(input: DefineBundleInput): BundleManifest {
  const entities: BundleEntities = {
    agents: input.agents ?? [],
    scannerPatterns: input.scannerPatterns ?? [],
    skills: input.skills ?? [],
    templates: input.templates ?? [],
  };
  const dependencies = input.dependencies ?? [];
  // Metadata is assembled first because the content hash covers it: since bundle
  // schema v2 the hash (and therefore the signature over it) binds the bundle's
  // identity — `name`/`version` — to its content, so a signed bundle cannot be
  // relabelled or version-bumped and still verify.
  const metadata = {
    createdAt: new Date().toISOString(),
    ...(input.description ? { description: input.description } : {}),
    name: input.name,
    ...(input.source ? { source: input.source } : {}),
    version: input.version,
  };
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      ...metadata,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies,
        entities,
        metadata,
      }),
    },
  };
}

/**
 * Attach a detached ed25519 signature over the bundle's content hash, so an
 * installing deployment that trusts the matching public key marks it VERIFIED.
 *
 * The declared hash is re-derived first: signing a manifest whose `contentHash`
 * does not match its own content and identity would produce a signature that can
 * never verify, and — worse — would be the exact shape of a relabelling attempt.
 * Better to fail loudly at authoring time.
 */
export function signBundle(
  manifest: BundleManifest,
  privateKeyPem: string,
  signedBy?: string
): BundleManifest {
  const { ok, expected } = verifyContentHash(manifest);
  if (!ok) {
    throw new Error(
      `refusing to sign: content hash mismatch (declared ${manifest.metadata.contentHash}, computed ${expected}). ` +
        'Re-assemble the manifest with defineBundle() after any edit to its entities or metadata.'
    );
  }
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      signature: signContentHash(privateKeyPem, manifest.metadata.contentHash),
      ...(signedBy ? { signedBy } : {}),
    },
  };
}

export type ValidateBundleResult =
  | { ok: true; bundle: BundleManifest }
  | { ok: false; errors: string[] };

/**
 * Local test harness: validate a manifest against the schema AND re-check its
 * content hash — the same gates `installBundle` applies, so authors catch
 * problems before shipping.
 */
export function validateBundle(manifest: unknown): ValidateBundleResult {
  let bundle: BundleManifest;
  try {
    bundle = parseBundle(manifest);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)], ok: false };
  }
  const { ok, expected } = verifyContentHash(bundle);
  if (!ok) {
    return {
      errors: [
        `content hash mismatch (declared ${bundle.metadata.contentHash}, computed ${expected})`,
      ],
      ok: false,
    };
  }
  // Same scanner-pattern gate the server applies at install (shared code, so an
  // author never ships a bundle that install would reject).
  const patternErrors = validateBundleScannerPatterns(bundle);
  if (patternErrors.length > 0) {
    return { errors: patternErrors, ok: false };
  }
  return { bundle, ok: true };
}
