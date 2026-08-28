import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Thin wrapper around the shared AES-256-GCM helpers for connection-scoped
 * API tokens. Worker-side connector code can call `decryptConnectionApiToken`
 * with a `Connection` row's ciphertext fields to recover the plaintext.
 */

export interface EncryptedConnectionToken {
  apiKeyCiphertext: Uint8Array<ArrayBuffer>;
  apiKeyNonce: Uint8Array<ArrayBuffer>;
  apiKeyAuthTag: Uint8Array<ArrayBuffer>;
  apiKeyVersion: number;
}

export function encryptConnectionApiToken(plaintext: string): EncryptedConnectionToken {
  const encrypted = encryptSecret(plaintext);
  return {
    apiKeyAuthTag: encrypted.authTag,
    apiKeyCiphertext: encrypted.ciphertext,
    apiKeyNonce: encrypted.nonce,
    apiKeyVersion: encrypted.keyVersion,
  };
}

export function decryptConnectionApiToken(record: {
  apiKeyCiphertext: Uint8Array | Buffer;
  apiKeyNonce: Uint8Array | Buffer;
  apiKeyAuthTag: Uint8Array | Buffer;
  apiKeyVersion: number;
}): string {
  return decryptSecret({
    authTag: record.apiKeyAuthTag,
    ciphertext: record.apiKeyCiphertext,
    keyVersion: record.apiKeyVersion,
    nonce: record.apiKeyNonce,
  });
}
