import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, deriveSubkeyForVersion } from '@auto-swe/shared/lib/crypto';

/**
 * Short-lived signed links for a transcript's content stream, so a browser can
 * download it natively (a plain navigation, no Authorization header, nothing
 * buffered in page memory). Docs: docs/transcripts.md.
 *
 * A token is `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(key, payloadB64))`,
 * keyed by an HKDF subkey of `CONFIG_ENCRYPTION_KEY`. The payload stamps the
 * key version it was signed under (`kv`), so a link issued just before a
 * rotation still verifies while the previous key is loaded. It names the user
 * it was issued to, the transcript, and the exact format and PII-scrub choice,
 * and lives {@link DOWNLOAD_LINK_TTL_SECONDS}. It proves only that the gateway
 * issued it: the content route still loads the user and re-runs authorization
 * when it is used. It is not single-use.
 */

export const DOWNLOAD_LINK_TTL_SECONDS = 60;
const KEY_INFO = 'auto-swe/transcript-download-link/v1';
/** Bounds the JSON parsed before the signature is checked. */
const MAX_PAYLOAD_B64 = 2048;

export interface DownloadLinkClaims {
  v: 1;
  /** Version of the `CONFIG_ENCRYPTION_KEY` the link was signed under. */
  kv: number;
  /** User id the link was issued to. */
  sub: string;
  /** Transcript id. */
  tid: string;
  fmt: 'raw' | 'normalized';
  pii: boolean;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Random nonce: two links issued in the same second differ. */
  n: string;
}

export type DownloadLinkFailure = 'malformed' | 'bad_signature' | 'expired';

function hmac(key: Buffer, payloadB64: string): Buffer {
  return createHmac('sha256', key).update(payloadB64).digest();
}

export function signDownloadLink(
  input: { sub: string; tid: string; fmt: 'raw' | 'normalized'; pii: boolean },
  now: number = Date.now()
): { token: string; expiresAt: Date } {
  const { key, version } = deriveSubkey(KEY_INFO);
  const exp = Math.floor(now / 1000) + DOWNLOAD_LINK_TTL_SECONDS;
  const claims: DownloadLinkClaims = {
    exp,
    fmt: input.fmt,
    kv: version,
    n: randomBytes(12).toString('base64url'),
    pii: input.pii,
    sub: input.sub,
    tid: input.tid,
    v: 1,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    expiresAt: new Date(exp * 1000),
    token: `${payloadB64}.${hmac(key, payloadB64).toString('base64url')}`,
  };
}

/**
 * The claims of a token this gateway signed and that has not expired, or why
 * not. The payload is parsed only far enough to read its key version; the
 * signature (constant-time) is checked with that version's key before any
 * claim is trusted. A version this process holds no key for is `bad_signature`.
 * An expired link's (verified) claims are returned with the refusal.
 */
export function verifyDownloadLink(
  token: string,
  now: number = Date.now()
):
  | { ok: true; claims: DownloadLinkClaims }
  | { ok: false; reason: 'expired'; claims: DownloadLinkClaims }
  | { ok: false; reason: Exclude<DownloadLinkFailure, 'expired'> } {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot > MAX_PAYLOAD_B64) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = token.slice(0, dot);
  let claims: Partial<DownloadLinkClaims>;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims?.kv !== 'number' || !Number.isInteger(claims.kv)) {
    return { ok: false, reason: 'malformed' };
  }
  const key = deriveSubkeyForVersion(KEY_INFO, claims.kv);
  if (!key) {
    return { ok: false, reason: 'bad_signature' };
  }
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = hmac(key, payloadB64);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (
    claims.v !== 1 ||
    typeof claims.sub !== 'string' ||
    typeof claims.tid !== 'string' ||
    (claims.fmt !== 'raw' && claims.fmt !== 'normalized') ||
    typeof claims.pii !== 'boolean' ||
    typeof claims.exp !== 'number' ||
    typeof claims.n !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.floor(now / 1000) >= claims.exp) {
    // The signature held, so the claims are genuine: the caller may record who
    // presented the stale link.
    return { claims: claims as DownloadLinkClaims, ok: false, reason: 'expired' };
  }
  return { claims: claims as DownloadLinkClaims, ok: true };
}
