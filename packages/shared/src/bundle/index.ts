import { createHash } from 'node:crypto';
import { z } from 'zod';

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
 */
export const BUNDLE_SCHEMA_VERSION = 1 as const;

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
  promptText: z.string(),
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
  flags: z.string().optional(),
  label: z.string().min(1),
  origin: z.string().nullable().optional(),
  pattern: z.string(),
  type: z.enum(SCANNER_PATTERN_TYPES),
});

export const BundleTemplateSchema = z.object({
  description: z.string().optional(),
  inputSchema: z.unknown().nullable().optional(),
  name: z.string().min(1),
  origin: z.string().nullable().optional(),
  /** The active version's WorkflowSpec (validated structurally by the engine on install/run). */
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
  /** sha256 over the canonicalized { entities, dependencies } — integrity check on install. */
  contentHash: z.string(),
  createdAt: z.string(),
  description: z.string().optional(),
  name: z.string().min(1),
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
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(',')}}`;
}

/**
 * sha256 over the canonicalized content (entities + dependencies only — NOT the
 * metadata, which carries the hash itself). Stable across key ordering, so the
 * same content always hashes identically regardless of export iteration order.
 */
export function computeContentHash(payload: {
  entities: BundleEntities;
  dependencies: BundleDependency[];
}): string {
  return createHash('sha256')
    .update(stableStringify({ dependencies: payload.dependencies, entities: payload.entities }))
    .digest('hex');
}

/** Parse + validate a raw object into a BundleManifest (throws on malformed input). */
export function parseBundle(input: unknown): BundleManifest {
  return BundleManifestSchema.parse(input);
}
