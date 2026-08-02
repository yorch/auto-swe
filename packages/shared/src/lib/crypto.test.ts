import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from './crypto.js';

describe('crypto', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    // Rotation env must not leak between cases — a stale version or previous
    // key would make an unrelated case pass (or fail) for the wrong reason.
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
    _resetKeyCacheForTests();
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    }
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
    _resetKeyCacheForTests();
  });

  it('round-trips a plaintext secret', () => {
    const sealed = encryptSecret('sk-abcdef1234567890');
    expect(sealed.lastFour).toBe('7890');
    expect(decryptSecret(sealed)).toBe('sk-abcdef1234567890');
  });

  it('produces a fresh nonce per call', () => {
    const a = encryptSecret('same-plaintext');
    const b = encryptSecret('same-plaintext');
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('rejects empty plaintext', () => {
    expect(() => encryptSecret('')).toThrow(/empty secret/);
  });

  it('rejects a tampered ciphertext', () => {
    const sealed = encryptSecret('sk-keepme');
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() => decryptSecret({ ...sealed, ciphertext: tampered })).toThrow();
  });

  it('rejects a key version it holds no key for', () => {
    const sealed = encryptSecret('sk-keepme');
    expect(() => decryptSecret({ ...sealed, keyVersion: 99 })).toThrow(
      /No CONFIG_ENCRYPTION_KEY available for version 99/
    );
  });

  it('points at CONFIG_ENCRYPTION_KEY_PREVIOUS when a version is missing', () => {
    const sealed = encryptSecret('sk-keepme');
    // The recovery step matters more than the diagnosis: a rotation half-done
    // is exactly when this fires.
    expect(() => decryptSecret({ ...sealed, keyVersion: 99 })).toThrow(
      /CONFIG_ENCRYPTION_KEY_PREVIOUS/
    );
  });

  it('decrypts a previous-version secret while the new key is current', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64');
    const newKey = Buffer.alloc(32, 9).toString('base64');

    // Seal under v1 with the old key...
    process.env.CONFIG_ENCRYPTION_KEY = oldKey;
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
    _resetKeyCacheForTests();
    const sealed = encryptSecret('sk-rotate-me');
    expect(sealed.keyVersion).toBe(1);

    // ...then move to v2, keeping the old key readable.
    process.env.CONFIG_ENCRYPTION_KEY = newKey;
    process.env.CONFIG_ENCRYPTION_KEY_VERSION = '2';
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = oldKey;
    _resetKeyCacheForTests();

    expect(decryptSecret(sealed)).toBe('sk-rotate-me');
    // New writes are stamped with the new version.
    expect(encryptSecret('fresh').keyVersion).toBe(2);
  });

  it('refuses a previous key with no earlier version to decrypt', () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(32, 3).toString('base64');
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    _resetKeyCacheForTests();

    // Version 1 with a "previous" key is a misconfiguration, not a rotation.
    expect(() => encryptSecret('x')).toThrow(/no earlier version/);
  });

  it('rejects a non-integer key version', () => {
    process.env.CONFIG_ENCRYPTION_KEY_VERSION = 'two';
    _resetKeyCacheForTests();
    expect(() => encryptSecret('x')).toThrow(/positive integer/);
  });

  it('fails fast when CONFIG_ENCRYPTION_KEY is missing', () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    _resetKeyCacheForTests();
    expect(() => encryptSecret('x')).toThrow(/CONFIG_ENCRYPTION_KEY is required/);
  });

  it('fails fast when CONFIG_ENCRYPTION_KEY is the wrong length', () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    _resetKeyCacheForTests();
    expect(() => encryptSecret('x')).toThrow(/must decode to 32 bytes/);
  });
});
