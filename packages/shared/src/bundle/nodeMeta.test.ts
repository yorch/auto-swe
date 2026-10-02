import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  computeContentHash,
  parseBundle,
  verifyContentHash,
} from './index.js';

// A template spec exactly as authored before `group`/`title` existed.
const legacySpec = {
  description: 'legacy',
  entry: 'impl',
  name: 'legacy-flow',
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
    impl: { next: 'done', step: 'executeImplementation', type: 'step' },
  },
  schemaVersion: 1,
};

const entitiesWith = (spec: unknown) =>
  ({
    agents: [],
    scannerPatterns: [],
    skills: [],
    templates: [{ name: 'legacy-flow', origin: 'bundle:x', spec }],
  }) as unknown as BundleEntities;

const metadata = { createdAt: '2026-01-01T00:00:00.000Z', name: 'acme-starter', version: '1.0.0' };

const manifestFor = (spec: unknown) => {
  const entities = entitiesWith(spec);
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies: [],
    entities,
    metadata: {
      ...metadata,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies: [],
        entities,
        metadata,
      }),
    },
  };
};

// Pinned from the hash computed before the optional fields were added to the node
// schemas. If this literal has to change, a signed bundle somewhere stopped verifying.
const PINNED = '2183a7c338a792f7df90ffe0e1fbeae387e7140ffc4cf92d67dc30e59719f39d';

describe('bundle content hash over a spec without group/title', () => {
  it('is byte-for-byte the hash it was before the schema learned the fields', () => {
    expect(manifestFor(legacySpec).metadata.contentHash).toBe(PINNED);
  });

  it('parses and verifies, and the parse hands the spec back untouched', () => {
    const parsed = parseBundle(JSON.parse(JSON.stringify(manifestFor(legacySpec))));
    expect(verifyContentHash(parsed).ok).toBe(true);
    expect(parsed.entities.templates[0]?.spec).toEqual(legacySpec);
  });

  it('hashes differently once a node gains a group (the fields are content)', () => {
    const grouped = {
      ...legacySpec,
      nodes: { ...legacySpec.nodes, impl: { ...legacySpec.nodes.impl, group: 'build' } },
    };
    expect(manifestFor(grouped).metadata.contentHash).not.toBe(PINNED);
    expect(verifyContentHash(parseBundle(manifestFor(grouped))).ok).toBe(true);
  });
});
