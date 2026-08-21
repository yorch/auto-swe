import { generateKeyPairSync } from 'node:crypto';
import {
  BUNDLE_SCHEMA_VERSION,
  computeContentHash,
  verifyBundleSignature,
} from '@auto-swe/shared/bundle';
import { describe, expect, it } from 'vitest';
import {
  defineBundle,
  defineContainerStep,
  defineScannerPattern,
  defineSkill,
  signBundle,
  validateBundle,
} from './index.js';

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    trusted: [
      {
        id: 'first-party',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
    ],
  };
};

describe('defineBundle', () => {
  it('assembles a schema-valid manifest with a matching content hash', () => {
    const bundle = defineBundle({
      name: 'swe-starter',
      skills: [defineSkill({ name: 'careful-review', promptText: 'review carefully' })],
      source: 'swe-starter',
      version: '1.0.0',
    });
    const res = validateBundle(bundle);
    expect(res.ok).toBe(true);
    expect(bundle.entities.skills).toHaveLength(1);
    expect(bundle.entities.agents).toEqual([]);
  });
});

describe('signBundle', () => {
  it('produces a signature that verifies against the matching public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bundle = signBundle(
      defineBundle({ name: 'b', version: '1' }),
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      'first-party'
    );
    const v = verifyBundleSignature(bundle, [
      {
        id: 'first-party',
        publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
    ]);
    expect(v.verified).toBe(true);
    expect(v.signedBy).toBe('first-party');
    expect(bundle.metadata.signedBy).toBe('first-party');
  });
});

describe('signBundle — the signature covers bundle identity', () => {
  it('verifies an honestly signed bundle', () => {
    const { privateKeyPem, trusted } = keyPair();
    const signed = signBundle(
      defineBundle({ name: 'vendor-pack', source: 'vendor', version: '1.0.0' }),
      privateKeyPem,
      'first-party'
    );
    expect(verifyBundleSignature(signed, trusted).verified).toBe(true);
  });

  it('does NOT verify once the bundle is relabelled to another name', () => {
    const { privateKeyPem, trusted } = keyPair();
    const signed = signBundle(
      defineBundle({ name: 'vendor-pack', version: '1.0.0' }),
      privateKeyPem,
      'first-party'
    );
    const relabelled = {
      ...signed,
      metadata: { ...signed.metadata, name: 'victim-pack' },
    };
    expect(validateBundle(relabelled).ok).toBe(false);
    expect(verifyBundleSignature(relabelled, trusted).verified).toBe(false);

    // …and re-hashing after the edit only invalidates the signature.
    const rehashed = {
      ...relabelled,
      metadata: {
        ...relabelled.metadata,
        contentHash: computeContentHash({
          ...relabelled,
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        }),
      },
    };
    expect(validateBundle(rehashed).ok).toBe(true);
    expect(verifyBundleSignature(rehashed, trusted).verified).toBe(false);
  });

  it('does NOT verify when an old release is replayed under a bumped version', () => {
    const { privateKeyPem, trusted } = keyPair();
    const signed = signBundle(
      defineBundle({ name: 'vendor-pack', version: '1.0.0' }),
      privateKeyPem,
      'first-party'
    );
    const bumped = {
      ...signed,
      metadata: { ...signed.metadata, version: '2.0.0' },
    };
    expect(verifyBundleSignature(bumped, trusted).verified).toBe(false);
  });

  it('refuses to sign a manifest whose declared hash does not match', () => {
    const { privateKeyPem } = keyPair();
    const bundle = defineBundle({ name: 'b', version: '1' });
    bundle.metadata.name = 'relabelled-before-signing';
    expect(() => signBundle(bundle, privateKeyPem)).toThrow(/refusing to sign/);
  });
});

describe('validateBundle', () => {
  it('rejects a tampered content hash', () => {
    const bundle = defineBundle({ name: 'b', version: '1' });
    bundle.metadata.contentHash = 'tampered';
    const res = validateBundle(bundle);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]).toMatch(/content hash mismatch/);
    }
  });

  it('rejects a malformed manifest', () => {
    expect(validateBundle({ not: 'a bundle' }).ok).toBe(false);
  });

  it('rejects an uncompilable scanner pattern (same gate the server applies)', () => {
    const res = validateBundle(
      defineBundle({
        name: 'b',
        scannerPatterns: [
          defineScannerPattern({
            flags: 'i',
            label: 'evil',
            pattern: '(unclosed',
            type: 'INJECTION',
          }),
        ],
        version: '1',
      })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]).toMatch(/INVALID_REGEX/);
    }
  });

  it('makes no execution-cost claim — a catastrophic pattern validates', () => {
    // Deliberate: the SDK is pure and I/O-free, and the only sound check for
    // catastrophic backtracking is to execute the pattern under a bound. That
    // happens in the worker thread every scanner runs patterns in, and (as an
    // early error) in the admin API's probe — not here.
    const res = validateBundle(
      defineBundle({
        name: 'b',
        scannerPatterns: [
          defineScannerPattern({ flags: 'i', label: 'evil', pattern: '(a+)+$', type: 'INJECTION' }),
        ],
        version: '1',
      })
    );
    expect(res.ok).toBe(true);
  });

  it('accepts an ordinary scanner pattern', () => {
    const res = validateBundle(
      defineBundle({
        name: 'b',
        scannerPatterns: [
          defineScannerPattern({ label: 'ok', pattern: 'ignore\\s+previous', type: 'INJECTION' }),
        ],
        version: '1',
      })
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a bundle emitted under the old (v1) trust format', () => {
    const legacy = { ...defineBundle({ name: 'b', version: '1' }), bundleSchemaVersion: 1 };
    const res = validateBundle(legacy);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]).toMatch(/unsupported bundleSchemaVersion 1/);
    }
  });
});

describe('defineContainerStep', () => {
  it('stamps the containerStep type', () => {
    const node = defineContainerStep({ command: 'node run.js', image: 'ghcr.io/acme/cap:1' });
    expect(node.type).toBe('containerStep');
    expect(node.image).toBe('ghcr.io/acme/cap:1');
  });
});
