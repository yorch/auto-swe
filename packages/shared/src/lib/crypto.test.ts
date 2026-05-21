import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from './crypto.js';

describe('crypto', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = previousKey;
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

  it('rejects an unknown key version', () => {
    const sealed = encryptSecret('sk-keepme');
    expect(() => decryptSecret({ ...sealed, keyVersion: 99 })).toThrow(
      /Unknown CONFIG_ENCRYPTION_KEY version/
    );
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
