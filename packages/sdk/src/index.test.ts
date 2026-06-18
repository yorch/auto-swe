import { generateKeyPairSync } from 'node:crypto';
import { verifyBundleSignature } from '@auto-swe/shared/bundle';
import { describe, expect, it } from 'vitest';
import {
  defineBundle,
  defineContainerStep,
  defineSkill,
  signBundle,
  validateBundle,
} from './index.js';

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
});

describe('defineContainerStep', () => {
  it('stamps the containerStep type', () => {
    const node = defineContainerStep({ command: 'node run.js', image: 'ghcr.io/acme/cap:1' });
    expect(node.type).toBe('containerStep');
    expect(node.image).toBe('ghcr.io/acme/cap:1');
  });
});
