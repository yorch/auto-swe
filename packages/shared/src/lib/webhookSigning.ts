import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one signing scheme for HTTP calls into and out of the platform.
 *
 * A signed request carries
 *
 *     X-AutoSwe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *
 * where `rawBody` is the exact bytes on the wire — never a re-serialisation of
 * parsed JSON, which reorders keys and re-escapes text — and `secret` is the
 * shared secret's UTF-8 bytes. The timestamp is inside the MAC, so a captured
 * request cannot be replayed with a fresh `t`, and a receiver refuses a `t`
 * more than `toleranceSec` away from its own clock in either direction.
 *
 * A header may carry several `v1=` entries. A sender rotating its secret signs
 * with both the new and the old one for the overlap, and a receiver that holds
 * either accepts; symmetrically a receiver may hold two secrets (current and
 * previous) and accept a signature from either. Unknown keys (`v0=`, `v2=`) are
 * ignored, so a later scheme can be added alongside `v1` without breaking an
 * older receiver.
 *
 * Pure apart from the secret generator: no I/O, no clock — the caller passes
 * `nowSec`. `@auto-swe/sdk` re-exports the sign/verify half for senders and
 * receivers outside the platform; both are pinned to the same known-answer
 * vector in their tests.
 */

/** The header name, as documented. HTTP header names are case-insensitive. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-AutoSwe-Signature';

/** How far `t` may be from the receiver's clock, either way, by default. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

/** Prefix of a generated secret, so one is recognisable in a config file or a leak scan. */
export const WEBHOOK_SIGNING_SECRET_PREFIX = 'whsec_';

/**
 * Bounds on what the parser will look at. A real header is under 200 bytes;
 * these only stop a hostile one from costing more than a few HMACs.
 */
const MAX_HEADER_LENGTH = 2048;
const MAX_SIGNATURES = 8;
/**
 * Canonical decimal only: no sign, no leading zeros, at most twelve digits (the year 33658). The MAC
 * is over the number's canonical text, so exactly one spelling of each timestamp exists.
 */
const TIMESTAMP_RE = /^(0|[1-9][0-9]{0,11})$/;
/** The largest timestamp the parser accepts; signing refuses anything a receiver would. */
const MAX_TIMESTAMP = 999_999_999_999;
const V1_RE = /^[0-9a-f]{64}$/;

export type WebhookBody = string | Uint8Array;

/**
 * Why a signature was refused:
 * - `missing`   — no header, or an empty one;
 * - `malformed` — a header that does not parse: no or several `t`, a `t` that is
 *                 not a non-negative integer, no `v1`, a `v1` that is not 64 hex digits;
 * - `stale`     — `t` is further than the tolerance from now, in the past or the future;
 * - `mismatch`  — well-formed and timely, but no `v1` matches any secret held.
 */
export type WebhookSignatureFailure = 'missing' | 'malformed' | 'stale' | 'mismatch';

export type WebhookSignatureResult =
  | {
      ok: true;
      /** The signed timestamp. */
      timestamp: number;
      /** Which of `secrets` matched — 0 is the first (by convention, current). */
      secretIndex: number;
      /** The `v1` digest that matched, lowercase hex. */
      matchedDigest: string;
    }
  | { ok: false; reason: WebhookSignatureFailure };

export interface VerifyWebhookSignatureInput {
  /** The header as received. An array (a repeated header) is read as one list. */
  header: string | readonly string[] | null | undefined;
  rawBody: WebhookBody;
  /** Secrets to accept, current first. Empty strings are ignored. */
  secrets: readonly string[];
  /** The receiver's clock, in whole unix seconds. */
  nowSec: number;
  toleranceSec?: number;
}

function bodyBytes(rawBody: WebhookBody): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
}

/** The bare `v1` digest: lowercase hex HMAC-SHA256 over `${t}.` followed by the body bytes. */
export function computeWebhookSignature(
  secret: string,
  rawBody: WebhookBody,
  timestampSec: number
): string {
  if (!Number.isSafeInteger(timestampSec) || timestampSec < 0 || timestampSec > MAX_TIMESTAMP) {
    throw new Error(
      'A webhook signature timestamp must be a non-negative integer of seconds, at most 12 digits'
    );
  }
  if (secret.length === 0) {
    throw new Error('A webhook signing secret must not be empty');
  }
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${timestampSec}.`, 'utf8')
    .update(bodyBytes(rawBody))
    .digest('hex');
}

/**
 * The header value for `rawBody` signed at `nowSec`. Pass several secrets to
 * sign with each (a sender mid-rotation); the first secret's entry comes first.
 */
export function signWebhookBody(
  secret: string | readonly string[],
  rawBody: WebhookBody,
  nowSec: number
): string {
  const secrets = typeof secret === 'string' ? [secret] : secret;
  if (secrets.length === 0) {
    throw new Error('signWebhookBody needs at least one secret');
  }
  if (!Number.isFinite(nowSec)) {
    throw new Error('signWebhookBody needs a finite clock in seconds');
  }
  // A fractional clock is floored; the result is still range-checked below, so nothing is
  // signed that a receiver would refuse as malformed.
  const t = Math.floor(nowSec);
  const entries = secrets.map((s) => `v1=${computeWebhookSignature(s, rawBody, t)}`);
  return [`t=${t}`, ...entries].join(',');
}

interface ParsedHeader {
  timestamp: number;
  signatures: Buffer[];
}

function parseHeader(raw: string): ParsedHeader | null {
  if (raw.length > MAX_HEADER_LENGTH) {
    return null;
  }
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item.length === 0) {
      continue;
    }
    const eq = item.indexOf('=');
    if (eq <= 0) {
      return null;
    }
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === 't') {
      // Exactly one: two timestamps would let a sender pick which one is checked.
      if (timestamp !== null || !TIMESTAMP_RE.test(value)) {
        return null;
      }
      timestamp = Number(value);
    } else if (key === 'v1') {
      const hex = value.toLowerCase();
      if (!V1_RE.test(hex) || signatures.length >= MAX_SIGNATURES) {
        return null;
      }
      signatures.push(Buffer.from(hex, 'utf8'));
    }
    // Any other key is a scheme this receiver does not speak; ignore it.
  }
  if (timestamp === null || signatures.length === 0) {
    return null;
  }
  return { signatures, timestamp };
}

/**
 * Check `header` against `rawBody` and the secrets held. Never throws on any
 * input; a refusal names its reason so the caller can log it (the reason is
 * safe to show the sender — it reveals nothing about the secret).
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): WebhookSignatureResult {
  const tolerance = input.toleranceSec ?? WEBHOOK_SIGNATURE_TOLERANCE_SEC;
  const raw =
    typeof input.header === 'string'
      ? input.header
      : Array.isArray(input.header)
        ? input.header.join(',')
        : '';
  if (raw.trim().length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const parsed = parseHeader(raw);
  if (!parsed) {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !Number.isFinite(input.nowSec) ||
    Math.abs(Math.floor(input.nowSec) - parsed.timestamp) > tolerance
  ) {
    return { ok: false, reason: 'stale' };
  }
  const secrets = input.secrets.filter((s) => s.length > 0);
  for (let i = 0; i < secrets.length; i++) {
    const expected = Buffer.from(
      computeWebhookSignature(secrets[i] as string, input.rawBody, parsed.timestamp),
      'utf8'
    );
    for (const candidate of parsed.signatures) {
      // Both are 64 ASCII hex bytes (the parser enforces it), so the lengths match.
      if (timingSafeEqual(expected, candidate)) {
        return {
          matchedDigest: candidate.toString('utf8'),
          ok: true,
          secretIndex: i,
          timestamp: parsed.timestamp,
        };
      }
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/** A fresh signing secret: `whsec_` and 32 random bytes, base64url. */
export function generateWebhookSigningSecret(): string {
  return `${WEBHOOK_SIGNING_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * A known-answer vector for anyone implementing the scheme elsewhere: signing
 * `body` (as UTF-8 bytes) with `secret` at `timestamp` must give `signature`,
 * and the header `header`. Computed with an independent HMAC implementation.
 */
export const WEBHOOK_SIGNATURE_TEST_VECTOR = {
  body: '{"ticketId":"JIRA-1","description":"café ✓"}',
  emptyBodySignature: 'b94a1cf9fa1feb57bff40dd42449cfb081d86cbfd635ea09a4cf84eff4d8bd84',
  header: 't=1760400000,v1=7019491da35d47ce8687140e7d4fb0a7c5258b31f6a62b6216aef795582874b0',
  secret: 'whsec_test_vector_secret',
  signature: '7019491da35d47ce8687140e7d4fb0a7c5258b31f6a62b6216aef795582874b0',
  timestamp: 1760400000,
} as const;
