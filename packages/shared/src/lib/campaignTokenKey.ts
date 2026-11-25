import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, deriveSubkeyForVersion } from './crypto.js';

/**
 * The campaign token: what the worker presents when it asks the gateway to start one attempt of
 * one campaign target (`POST /campaigns/:id/targets/:targetId/attempts`). The worker mints a fresh
 * one for EVERY gateway call; no token is ever placed in workflow input, carried state, an
 * activity input or result, or Temporal history.
 *
 * It mirrors the orchestration token (`orchestrationTokenKey.ts`): `camp_` +
 * `base64url(JSON payload)` + `.` + `base64url(HMAC-SHA256(key, payloadB64))`, keyed by an HKDF
 * subkey of `CONFIG_ENCRYPTION_KEY` under its own info string, so a token of one kind never
 * verifies as the other. The payload stamps the key version it was signed under (`v`), so a token
 * minted just before a rotation still verifies while the previous key is loaded.
 *
 * The claims name one campaign (`cid`), one target (`tid`) and one call (`call`). They carry no
 * user or principal id: the gateway derives the acting identity (the launcher) from the campaign
 * row on every request, so a token can never assert an identity of its own. A route accepts a
 * token only when its claims match the route's own ids and call ({@link campaignTokenMatches}).
 */

export const CAMPAIGN_TOKEN_PREFIX = 'camp_';
export const CAMPAIGN_TOKEN_KEY_INFO = 'auto-swe/campaign-token/v1';
export const CAMPAIGN_TOKEN_TTL_SECONDS = 120;
/** No token is honoured whose lifetime exceeds this, however it is signed. */
export const CAMPAIGN_TOKEN_MAX_TTL_SECONDS = 5 * 60;
/** The calls a token can be scoped to. */
export const CAMPAIGN_TOKEN_CALLS = ['startAttempt'] as const;
export type CampaignTokenCall = (typeof CAMPAIGN_TOKEN_CALLS)[number];

/** Bounds the JSON parsed before the signature is checked. */
const MAX_PAYLOAD_B64 = 1024;
/** base64url of a 32-byte HMAC-SHA256: 43 characters, no padding. */
const MAC_B64_LENGTH = 43;
const MAC_B64_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CampaignTokenPayload {
  /** Key version (`CONFIG_ENCRYPTION_KEY_VERSION`) the token was signed under. */
  v: number;
  /** The campaign the token is for. */
  cid: string;
  /** The target the token is for. */
  tid: string;
  /** The one call the token authorizes. */
  call: CampaignTokenCall;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Random id: two tokens minted in the same second differ. */
  jti: string;
}

export type CampaignTokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'invalid_claims';

export interface CampaignTokenScope {
  campaignId: string;
  targetId: string;
  call: CampaignTokenCall;
}

function mac(key: Buffer, payloadB64: string): Buffer {
  return createHmac('sha256', key).update(payloadB64).digest();
}

/** Mint a token for one call on one target. Pure of I/O; reads only the loaded encryption key. */
export function mintCampaignToken(
  input: CampaignTokenScope,
  ttlSeconds: number = CAMPAIGN_TOKEN_TTL_SECONDS,
  now: number = Date.now()
): string {
  const { key, version } = deriveSubkey(CAMPAIGN_TOKEN_KEY_INFO);
  const iat = Math.floor(now / 1000);
  const payload: CampaignTokenPayload = {
    call: input.call,
    cid: input.campaignId,
    exp: iat + Math.floor(ttlSeconds),
    iat,
    jti: randomBytes(12).toString('base64url'),
    tid: input.targetId,
    v: version,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${CAMPAIGN_TOKEN_PREFIX}${payloadB64}.${mac(key, payloadB64).toString('base64url')}`;
}

/**
 * The scope a token was minted for, or why it is refused. In order: format (prefix, one dot,
 * bounded size, JSON), the key version it names (a version this process holds no key for is
 * `bad_signature`), the HMAC in constant time, then claim shape, `iat`/`exp` sanity (a lifetime
 * past {@link CAMPAIGN_TOKEN_MAX_TTL_SECONDS}, an `iat` more than a minute ahead of the clock or an
 * `exp` more than that maximum ahead is `invalid_claims` even when correctly signed), and expiry.
 * No database read: this is not authorization.
 */
export function verifyCampaignToken(
  token: string,
  now: number = Date.now()
): ({ ok: true } & CampaignTokenScope) | { ok: false; reason: CampaignTokenFailure } {
  if (!token.startsWith(CAMPAIGN_TOKEN_PREFIX)) {
    return { ok: false, reason: 'malformed' };
  }
  const body = token.slice(CAMPAIGN_TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot !== body.lastIndexOf('.') || dot > MAX_PAYLOAD_B64) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = body.slice(0, dot);
  let claims: Partial<CampaignTokenPayload>;
  try {
    const payloadBytes = Buffer.from(payloadB64, 'base64url');
    // Only the canonical spelling: Node's decoder skips characters and ignores stray trailing bits.
    if (payloadBytes.toString('base64url') !== payloadB64) {
      return { ok: false, reason: 'malformed' };
    }
    claims = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims !== 'object' || claims === null || !Number.isInteger(claims.v)) {
    return { ok: false, reason: 'malformed' };
  }
  let key: Buffer | null;
  try {
    key = deriveSubkeyForVersion(CAMPAIGN_TOKEN_KEY_INFO, claims.v as number);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!key) {
    return { ok: false, reason: 'bad_signature' };
  }
  // The MAC must be the exact canonical base64url of the 32 bytes: no appended characters, no
  // padding, no extra bits in the last character.
  const macPart = body.slice(dot + 1);
  const expectedB64 = Buffer.from(mac(key, payloadB64).toString('base64url'), 'utf8');
  const givenB64 = Buffer.from(macPart, 'utf8');
  if (
    macPart.length !== MAC_B64_LENGTH ||
    !MAC_B64_RE.test(macPart) ||
    givenB64.length !== expectedB64.length ||
    !timingSafeEqual(givenB64, expectedB64)
  ) {
    return { ok: false, reason: 'bad_signature' };
  }
  const { call, cid, exp, iat, jti, tid } = claims;
  if (
    typeof cid !== 'string' ||
    !UUID_RE.test(cid) ||
    typeof tid !== 'string' ||
    !UUID_RE.test(tid) ||
    typeof call !== 'string' ||
    !(CAMPAIGN_TOKEN_CALLS as readonly string[]).includes(call) ||
    typeof jti !== 'string' ||
    !Number.isInteger(exp) ||
    !Number.isInteger(iat)
  ) {
    return { ok: false, reason: 'invalid_claims' };
  }
  const nowSeconds = Math.floor(now / 1000);
  const e = exp as number;
  const i = iat as number;
  if (
    e <= i ||
    e - i > CAMPAIGN_TOKEN_MAX_TTL_SECONDS ||
    e > nowSeconds + CAMPAIGN_TOKEN_MAX_TTL_SECONDS ||
    i > nowSeconds + 60
  ) {
    return { ok: false, reason: 'invalid_claims' };
  }
  if (nowSeconds >= e) {
    return { ok: false, reason: 'expired' };
  }
  return { call: call as CampaignTokenCall, campaignId: cid, ok: true, targetId: tid };
}

/**
 * Whether a verified token is for exactly this campaign, target and call. A route runs this after
 * {@link verifyCampaignToken} with the ids from its own path, so a token minted for one target
 * cannot start another.
 */
export function campaignTokenMatches(
  verified: { campaignId: string; targetId: string; call: string },
  expected: CampaignTokenScope
): boolean {
  return (
    verified.campaignId.toLowerCase() === expected.campaignId.toLowerCase() &&
    verified.targetId.toLowerCase() === expected.targetId.toLowerCase() &&
    verified.call === expected.call
  );
}
