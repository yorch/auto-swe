import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SCHEMA_VERSION,
  type BundleEntities,
  type BundleManifest,
  BundleSchemaVersionError,
  computeContentHash,
  parseBundle,
  signContentHash,
  validateBundleScannerPatterns,
  verifyBundleSignature,
  verifyContentHash,
} from './index.js';

const emptyEntities: BundleEntities = {
  agents: [],
  scannerPatterns: [],
  skills: [],
  templates: [],
};

const metadata = (over: Record<string, unknown> = {}) => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  name: 'acme-starter',
  version: '1.0.0',
  ...over,
});

/** A hash-consistent manifest, the way `defineBundle`/`exportBundle` build one. */
function manifest(over: { entities?: BundleEntities; metadata?: Record<string, unknown> } = {}) {
  const entities = over.entities ?? emptyEntities;
  const dependencies: { connectionType: string }[] = [];
  const meta = metadata(over.metadata);
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      ...meta,
      contentHash: computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies,
        entities,
        metadata: meta,
      }),
    },
  } as BundleManifest;
}

describe('computeContentHash', () => {
  it('is stable regardless of object key insertion order', () => {
    const a = computeContentHash({
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [{ connectionType: 'mcp' }],
      entities: {
        ...emptyEntities,
        agents: [{ key: 'reviewer', name: 'Reviewer', toolKeys: ['bash', 'mcp'] }],
      } as unknown as BundleEntities,
      metadata: metadata(),
    });
    // Same content, keys built in a different order.
    const b = computeContentHash({
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [{ connectionType: 'mcp' }],
      entities: {
        agents: [{ key: 'reviewer', name: 'Reviewer', toolKeys: ['bash', 'mcp'] }],
        scannerPatterns: [],
        skills: [],
        templates: [],
      } as unknown as BundleEntities,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', name: 'acme-starter', version: '1.0.0' },
    });
    expect(a).toBe(b);
  });

  it('changes when content changes', () => {
    expect(manifest().metadata.contentHash).not.toBe(
      manifest({ entities: { ...emptyEntities, skills: [{ name: 's', promptText: 'p' }] } })
        .metadata.contentHash
    );
  });

  it('changes when the bundle NAME changes (identity is signed)', () => {
    expect(manifest().metadata.contentHash).not.toBe(
      manifest({ metadata: { name: 'other-bundle' } }).metadata.contentHash
    );
  });

  it('changes when the bundle VERSION changes (blocks replay under a bumped version)', () => {
    expect(manifest().metadata.contentHash).not.toBe(
      manifest({ metadata: { version: '9.9.9' } }).metadata.contentHash
    );
  });

  it('changes when createdAt or source changes', () => {
    const base = manifest().metadata.contentHash;
    expect(
      manifest({ metadata: { createdAt: '2026-06-01T00:00:00.000Z' } }).metadata.contentHash
    ).not.toBe(base);
    expect(manifest({ metadata: { source: 'vendor' } }).metadata.contentHash).not.toBe(base);
  });

  it('ignores the signature fields, so signing does not invalidate the hash', () => {
    const m = manifest();
    const signed = {
      ...m,
      metadata: { ...m.metadata, signature: 'AAAA', signedBy: 'vendor' },
    } as BundleManifest;
    expect(verifyContentHash(signed).ok).toBe(true);
  });

  it('ignores undefined-valued keys (matches a JSON round-trip)', () => {
    const withUndef = computeContentHash({
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities: {
        ...emptyEntities,
        skills: [{ description: undefined, name: 's', promptText: 'p' }],
      } as unknown as BundleEntities,
      metadata: metadata({ description: undefined }),
    });
    const without = computeContentHash({
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: [],
      entities: { ...emptyEntities, skills: [{ name: 's', promptText: 'p' }] },
      metadata: metadata(),
    });
    expect(withUndef).toBe(without);
  });

  it('survives a JSON round-trip of the manifest', () => {
    const m = manifest({ metadata: { description: 'd', source: 'vendor' } });
    expect(verifyContentHash(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });
});

describe('stableStringify hardening (via computeContentHash)', () => {
  it('throws on a circular manifest instead of recursing forever', () => {
    const entities = { ...emptyEntities } as unknown as Record<string, unknown>;
    entities.self = entities;
    expect(() =>
      computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies: [],
        entities: entities as unknown as BundleEntities,
        metadata: metadata(),
      })
    ).toThrow(/circular reference/);
  });

  it('serializes Date/toJSON values by value, not as {}', () => {
    const hashWith = (d: Date) =>
      computeContentHash({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        dependencies: [],
        entities: {
          ...emptyEntities,
          templates: [{ name: 't', spec: { at: d } }],
        } as unknown as BundleEntities,
        metadata: metadata(),
      });
    expect(hashWith(new Date('2020-01-01'))).not.toBe(hashWith(new Date('2021-01-01')));
  });
});

describe('parseBundle', () => {
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

  it('rejects a v1 bundle with an actionable re-sign error, never silently', () => {
    const legacy = { ...manifest(), bundleSchemaVersion: 1 };
    expect(() => parseBundle(legacy)).toThrow(BundleSchemaVersionError);
    expect(() => parseBundle(legacy)).toThrow(/unsupported bundleSchemaVersion 1/);
    expect(() => parseBundle(legacy)).toThrow(/re-sign/i);
  });

  it('rejects a future schema version', () => {
    expect(() => parseBundle({ ...manifest(), bundleSchemaVersion: 999 })).toThrow(
      BundleSchemaVersionError
    );
  });

  it('rejects a non-object', () => {
    expect(() => parseBundle(null)).toThrow();
  });

  it('rejects a scanner pattern with an unsafe flag (g/y)', () => {
    // The flags regex fails at parse time, before any hash check.
    expect(() =>
      parseBundle({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        entities: {
          scannerPatterns: [{ flags: 'gi', label: 'p', pattern: 'x', type: 'INJECTION' }],
        },
        metadata: { contentHash: 'x', createdAt: 'now', name: 'n', version: '1' },
      })
    ).toThrow();
  });

  it('rejects an over-long scanner pattern body', () => {
    expect(() =>
      parseBundle({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        entities: {
          scannerPatterns: [{ label: 'p', pattern: 'a'.repeat(2001), type: 'INJECTION' }],
        },
        metadata: { contentHash: 'x', createdAt: 'now', name: 'n', version: '1' },
      })
    ).toThrow();
  });
});

describe('validateBundleScannerPatterns', () => {
  const withPattern = (pattern: string) =>
    manifest({
      entities: {
        ...emptyEntities,
        scannerPatterns: [{ flags: 'i', label: 'evil', pattern, type: 'INJECTION' }],
      },
    });

  it('rejects a catastrophic-backtracking pattern', () => {
    const errors = validateBundleScannerPatterns(withPattern('(a+)+$'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/scanner pattern 'evil' \[REDOS_RISK\]/);
  });

  it('accepts an ordinary pattern', () => {
    expect(validateBundleScannerPatterns(withPattern('ignore\\s+previous'))).toEqual([]);
  });
});

describe('verifyBundleSignature — signature binds identity', () => {
  const keys = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      trusted: [
        {
          id: 'vendor',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        },
      ],
    };
  };

  const sign = (m: BundleManifest, privateKeyPem: string): BundleManifest => ({
    ...m,
    metadata: {
      ...m.metadata,
      signature: signContentHash(privateKeyPem, m.metadata.contentHash),
      signedBy: 'vendor',
    },
  });

  it('verifies an honestly signed bundle', () => {
    const { privateKeyPem, trusted } = keys();
    const signed = sign(manifest(), privateKeyPem);
    expect(verifyBundleSignature(signed, trusted)).toEqual({ signedBy: 'vendor', verified: true });
  });

  it('fails when the bundle is RELABELLED to another name', () => {
    const { privateKeyPem, trusted } = keys();
    const signed = sign(manifest(), privateKeyPem);
    const relabelled: BundleManifest = {
      ...signed,
      metadata: { ...signed.metadata, name: 'victim-bundle' },
    };
    // The declared hash no longer describes the manifest…
    expect(verifyContentHash(relabelled).ok).toBe(false);
    // …and the signature does not carry over.
    expect(verifyBundleSignature(relabelled, trusted).verified).toBe(false);
  });

  it('fails when the bundle is RELABELLED and its hash recomputed to match', () => {
    const { privateKeyPem, trusted } = keys();
    const signed = sign(manifest(), privateKeyPem);
    const meta = { ...signed.metadata, name: 'victim-bundle' };
    const forged: BundleManifest = {
      ...signed,
      metadata: {
        ...meta,
        contentHash: computeContentHash({ ...signed, metadata: meta }),
      },
    };
    // Hash is internally consistent, but it is a different hash — the old
    // signature cannot cover it.
    expect(verifyContentHash(forged).ok).toBe(true);
    expect(verifyBundleSignature(forged, trusted).verified).toBe(false);
  });

  it('fails when an old release is replayed under a bumped version', () => {
    const { privateKeyPem, trusted } = keys();
    const signed = sign(manifest({ metadata: { version: '1.0.0' } }), privateKeyPem);
    const meta = { ...signed.metadata, version: '2.0.0' };
    const bumped: BundleManifest = {
      ...signed,
      metadata: { ...meta, contentHash: computeContentHash({ ...signed, metadata: meta }) },
    };
    expect(verifyBundleSignature(bumped, trusted).verified).toBe(false);
  });

  it('fails for an untrusted key and for an unsigned bundle', () => {
    const { privateKeyPem } = keys();
    const other = keys();
    expect(verifyBundleSignature(sign(manifest(), privateKeyPem), other.trusted).verified).toBe(
      false
    );
    expect(verifyBundleSignature(manifest(), other.trusted)).toEqual({
      signedBy: null,
      verified: false,
    });
  });
});
