import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  computeContentHash,
  parseBundle,
} from './index.js';

const emptyEntities: BundleEntities = {
  agents: [],
  scannerPatterns: [],
  skills: [],
  templates: [],
};

describe('computeContentHash', () => {
  it('is stable regardless of object key insertion order', () => {
    const a = {
      dependencies: [{ connectionType: 'mcp' }],
      entities: {
        ...emptyEntities,
        agents: [{ key: 'reviewer', name: 'Reviewer', toolKeys: ['bash', 'mcp'] }],
      } as unknown as BundleEntities,
    };
    // Same content, keys built in a different order.
    const b = {
      dependencies: [{ connectionType: 'mcp' }],
      entities: {
        agents: [{ key: 'reviewer', name: 'Reviewer', toolKeys: ['bash', 'mcp'] }],
        scannerPatterns: [],
        skills: [],
        templates: [],
      } as unknown as BundleEntities,
    };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('changes when content changes', () => {
    const base = computeContentHash({ dependencies: [], entities: emptyEntities });
    const changed = computeContentHash({
      dependencies: [],
      entities: { ...emptyEntities, skills: [{ name: 's', promptText: 'p' }] },
    });
    expect(base).not.toBe(changed);
  });
});

describe('parseBundle', () => {
  const valid = () => {
    const entities = emptyEntities;
    const dependencies: { connectionType: string }[] = [];
    return {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies,
      entities,
      metadata: {
        contentHash: computeContentHash({ dependencies, entities }),
        createdAt: new Date().toISOString(),
        name: 'test',
        version: '1.0.0',
      },
    };
  };

  it('accepts a well-formed manifest and defaults entity arrays', () => {
    const parsed = parseBundle({
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      entities: { skills: [{ name: 's', promptText: 'p' }] },
      metadata: { contentHash: 'x', createdAt: 'now', name: 'n', version: '1' },
    });
    expect(parsed.entities.agents).toEqual([]);
    expect(parsed.entities.skills).toHaveLength(1);
    expect(parsed.dependencies).toEqual([]);
  });

  it('rejects a wrong schema version', () => {
    expect(() => parseBundle({ ...valid(), bundleSchemaVersion: 999 })).toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => parseBundle(null)).toThrow();
  });
});
