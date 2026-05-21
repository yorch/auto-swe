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
const CURRENT_KEY_VERSION = 1;

let cachedKey: Buffer | undefined;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CONFIG_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is required to encrypt/decrypt provider credentials. ' +
        'Generate one with: `node -e "console.log(crypto.randomBytes(32).toString(\\"base64\\"))"`.'
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        'Expected base64-encoded 32 random bytes.'
    );
  }
  cachedKey = decoded;
  return decoded;
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
  const key = loadKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    authTag: toArrayBufferUint8(authTag),
    ciphertext: toArrayBufferUint8(ciphertext),
    keyVersion: CURRENT_KEY_VERSION,
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
  if (record.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(
      `Unknown CONFIG_ENCRYPTION_KEY version ${record.keyVersion} ` +
        `(this process knows version ${CURRENT_KEY_VERSION}). ` +
        'Key rotation is not yet implemented — see PLAN.md.'
    );
  }
  const key = loadKey();
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
  cachedKey = undefined;
}
