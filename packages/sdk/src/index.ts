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
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      contentHash: computeContentHash({ dependencies, entities }),
      createdAt: new Date().toISOString(),
      ...(input.description ? { description: input.description } : {}),
      name: input.name,
      ...(input.source ? { source: input.source } : {}),
      version: input.version,
    },
  };
}

/**
 * Attach a detached ed25519 signature over the bundle's content hash, so an
 * installing deployment that trusts the matching public key marks it VERIFIED.
 */
export function signBundle(
  manifest: BundleManifest,
  privateKeyPem: string,
  signedBy?: string
): BundleManifest {
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
  return { bundle, ok: true };
}
