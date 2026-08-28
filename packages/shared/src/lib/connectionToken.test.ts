import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptConnectionApiToken, encryptConnectionApiToken } from './connectionToken.js';
import { _resetKeyCacheForTests } from './crypto.js';

describe('connectionToken', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    _resetKeyCacheForTests();
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    }
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    _resetKeyCacheForTests();
  });

  it('round-trips an API token', () => {
    const token = 'secret-api-token-123';
    const encrypted = encryptConnectionApiToken(token);
    expect(encrypted.apiKeyCiphertext.length).toBeGreaterThan(0);
    expect(encrypted.apiKeyNonce.length).toBeGreaterThan(0);
    expect(encrypted.apiKeyAuthTag.length).toBeGreaterThan(0);
    expect(encrypted.apiKeyVersion).toBe(1);

    expect(decryptConnectionApiToken(encrypted)).toBe(token);
  });
});
