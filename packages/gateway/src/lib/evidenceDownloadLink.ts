import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, deriveSubkeyForVersion } from '@auto-swe/shared/lib/crypto';

export const EVIDENCE_LINK_TTL_SECONDS = 300;
const KEY_INFO = 'auto-swe/run-evidence-link/v1';
const MAX_PAYLOAD_B64 = 2048;

export interface EvidenceLinkClaims {
  v: 1;
  kv: number;
  sub: string;
  rid: string;
  eid: string;
  exp: number;
  n: string;
}

export type EvidenceLinkFailure = 'malformed' | 'bad_signature' | 'expired';

function hmac(key: Buffer, payloadB64: string): Buffer {
  return createHmac('sha256', key).update(payloadB64).digest();
}

export function signEvidenceLink(
  input: { sub: string; rid: string; eid: string },
  now: number = Date.now()
): { token: string; expiresAt: Date } {
  const { key, version } = deriveSubkey(KEY_INFO);
  const exp = Math.floor(now / 1000) + EVIDENCE_LINK_TTL_SECONDS;
  const claims: EvidenceLinkClaims = {
    eid: input.eid,
    exp,
    kv: version,
    n: randomBytes(12).toString('base64url'),
    rid: input.rid,
    sub: input.sub,
    v: 1,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    expiresAt: new Date(exp * 1000),
    token: `${payloadB64}.${hmac(key, payloadB64).toString('base64url')}`,
  };
}

export function verifyEvidenceLink(
  token: string,
  now: number = Date.now()
):
  | { ok: true; claims: EvidenceLinkClaims }
  | { ok: false; reason: 'expired'; claims: EvidenceLinkClaims }
  | { ok: false; reason: Exclude<EvidenceLinkFailure, 'expired'> } {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot > MAX_PAYLOAD_B64) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = token.slice(0, dot);
  let claims: Partial<EvidenceLinkClaims>;
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
    typeof claims.rid !== 'string' ||
    typeof claims.eid !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.n !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.floor(now / 1000) >= claims.exp) {
    return { claims: claims as EvidenceLinkClaims, ok: false, reason: 'expired' };
  }
  return { claims: claims as EvidenceLinkClaims, ok: true };
}
