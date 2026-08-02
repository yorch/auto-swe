import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/// Envelope-encryption helpers for secret material stored in
/// `provider_credentials.api_key_ciphertext`. AES-256-GCM with a per-record
/// random 12-byte nonce and a separately-stored 16-byte auth tag. The master
/// key is read from `CONFIG_ENCRYPTION_KEY` (base64-encoded 32 bytes) on first
/// use and cached for the process lifetime.

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEFAULT_KEY_VERSION = 1;

/**
 * Rotation model.
 *
 * `CONFIG_ENCRYPTION_KEY` is the **write** key: everything encrypted from now
 * on uses it, stamped with `CONFIG_ENCRYPTION_KEY_VERSION` (default 1).
 * `CONFIG_ENCRYPTION_KEY_PREVIOUS` is an optional **read-only** key for the
 * version immediately below, so a deployment can start writing under the new
 * key while rows encrypted under the old one still decrypt.
 *
 * That covers one rotation in flight, which is the only state a rotation
 * actually passes through: set both, restart, re-encrypt every row
 * (`rotateEncryptionKey`), then drop the previous key. A general
 * version→key map would let arbitrarily many old keys linger, which is the
 * opposite of what rotating is for.
 */
/**
 * Version and keys are cached together: they must agree, and deriving the
 * version from the environment on every call while caching the map from the
 * first would be two sources of truth for one fact.
 */
let cached: { version: number; keys: Map<number, Buffer> } | undefined;

function decodeKey(raw: string, envName: string): Buffer {
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${envName} must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        'Expected base64-encoded 32 random bytes.'
    );
  }
  return decoded;
}

/** The version new ciphertext is stamped with. */
export function currentKeyVersion(): number {
  const raw = process.env.CONFIG_ENCRYPTION_KEY_VERSION?.trim();
  if (!raw) {
    return DEFAULT_KEY_VERSION;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY_VERSION must be a positive integer (got ${JSON.stringify(raw)}).`
    );
  }
  return parsed;
}

function loadKeys(): { version: number; keys: Map<number, Buffer> } {
  if (cached) {
    return cached;
  }
  const raw = process.env.CONFIG_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is required to encrypt/decrypt provider credentials. ' +
        'Generate one with `openssl rand -base64 32` ' +
        "or `node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"`."
    );
  }
  const version = currentKeyVersion();
  const keys = new Map<number, Buffer>([[version, decodeKey(raw, 'CONFIG_ENCRYPTION_KEY')]]);

  const previous = process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previous) {
    if (version === DEFAULT_KEY_VERSION) {
      throw new Error(
        'CONFIG_ENCRYPTION_KEY_PREVIOUS is set but CONFIG_ENCRYPTION_KEY_VERSION is 1, ' +
          'so there is no earlier version for it to decrypt. Bump the version when you ' +
          'introduce a new key.'
      );
    }
    keys.set(version - 1, decodeKey(previous, 'CONFIG_ENCRYPTION_KEY_PREVIOUS'));
  }

  cached = { keys, version };
  return cached;
}

export interface EncryptedSecret {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
  lastFour: string;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  if (plaintext.length === 0) {
    throw new Error('Cannot encrypt empty secret');
  }
  const { keys, version } = loadKeys();
  const key = keys.get(version) as Buffer;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    authTag: toArrayBufferUint8(authTag),
    ciphertext: toArrayBufferUint8(ciphertext),
    keyVersion: version,
    lastFour: plaintext.slice(-4),
    nonce: toArrayBufferUint8(nonce),
  };
}

/// Node's `Buffer.from`/`randomBytes` return a `Uint8Array<ArrayBufferLike>`,
/// but Prisma's generated types expect `Uint8Array<ArrayBuffer>` (without
/// `SharedArrayBuffer` in the union). Copy into a fresh ArrayBuffer to
/// narrow the type without a runtime allocation hit beyond the copy itself.
function toArrayBufferUint8(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(src.byteLength);
  const out = new Uint8Array(buf);
  out.set(src);
  return out;
}

export function decryptSecret(record: {
  ciphertext: Buffer | Uint8Array;
  nonce: Buffer | Uint8Array;
  authTag: Buffer | Uint8Array;
  keyVersion: number;
}): string {
  const { keys } = loadKeys();
  const key = keys.get(record.keyVersion);
  if (!key) {
    throw new Error(
      `No CONFIG_ENCRYPTION_KEY available for version ${record.keyVersion} ` +
        `(this process holds ${[...keys.keys()].sort().join(', ')}). ` +
        'During a rotation, set CONFIG_ENCRYPTION_KEY_PREVIOUS to the old key until ' +
        '`rotateEncryptionKey` has re-encrypted every row.'
    );
  }
  const nonce = Buffer.from(record.nonce);
  const authTag = Buffer.from(record.authTag);
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce length ${nonce.length}, expected ${NONCE_BYTES}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`Invalid auth tag length ${authTag.length}, expected ${AUTH_TAG_BYTES}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext)),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/// Test-only escape hatch. Resets the cached key so a test can swap
/// CONFIG_ENCRYPTION_KEY between cases.
export function _resetKeyCacheForTests(): void {
  cached = undefined;
}
