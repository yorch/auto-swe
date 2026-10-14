import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  type EventEndpointFormat,
  type EventEndpointScheme,
  isCloudEventEnvelope,
  type SignatureEncoding,
} from '@auto-swe/shared/automation';
import { decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  generateWebhookSigningSecret,
  verifyWebhookSignature,
  type WebhookSignatureFailure,
} from '@auto-swe/shared/lib/webhookSigning';

/**
 * Event endpoints (docs/inbound-events.md): their secrets, how a call to one is verified, and
 * how its body is read. The receiver verifies before it reads anything else, and a refusal says
 * only that it was refused — never which check failed or why.
 */

/** How long the secret a rotation replaced is still accepted. */
export const ENDPOINT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** The header a platform-sent call carries (completion callbacks). Never an event. */
export const DELIVERY_LOOP_HEADER = 'x-autoswe-delivery';

/** The secret columns of an endpoint row. */
export interface EndpointSecretColumns {
  secretCiphertext: Uint8Array;
  secretNonce: Uint8Array;
  secretAuthTag: Uint8Array;
  secretKeyVersion: number;
  previousSecretCiphertext: Uint8Array | null;
  previousSecretNonce: Uint8Array | null;
  previousSecretAuthTag: Uint8Array | null;
  previousSecretKeyVersion: number | null;
  previousSecretExpiresAt: Date | null;
}

/** How a call to an endpoint is verified. */
export interface EndpointVerificationConfig extends EndpointSecretColumns {
  scheme: string;
  signatureHeader: string | null;
  signaturePrefix: string | null;
  signatureEncoding: string | null;
}

/** The secrets a call may be signed with: the current one, then an unexpired previous one. */
export function endpointSecrets(row: EndpointSecretColumns, now: Date): string[] {
  const secrets = [
    decryptSecret({
      authTag: row.secretAuthTag,
      ciphertext: row.secretCiphertext,
      keyVersion: row.secretKeyVersion,
      nonce: row.secretNonce,
    }),
  ];
  if (
    row.previousSecretCiphertext &&
    row.previousSecretNonce &&
    row.previousSecretAuthTag &&
    row.previousSecretKeyVersion !== null &&
    row.previousSecretExpiresAt &&
    row.previousSecretExpiresAt > now
  ) {
    secrets.push(
      decryptSecret({
        authTag: row.previousSecretAuthTag,
        ciphertext: row.previousSecretCiphertext,
        keyVersion: row.previousSecretKeyVersion,
        nonce: row.previousSecretNonce,
      })
    );
  }
  return secrets;
}

/** Column values for a new endpoint's secret: the caller's, or a generated one. */
export function newSecretColumns(given?: string): {
  secret: string;
  generated: boolean;
  data: SecretData;
} {
  const secret = given ?? generateWebhookSigningSecret();
  const sealed = encryptSecret(secret);
  return {
    data: {
      secretAuthTag: sealed.authTag,
      secretCiphertext: sealed.ciphertext,
      secretKeyVersion: sealed.keyVersion,
      secretLastFour: sealed.lastFour,
      secretNonce: sealed.nonce,
    },
    generated: given === undefined,
    secret,
  };
}

interface SecretData {
  secretAuthTag: Uint8Array<ArrayBuffer>;
  secretCiphertext: Uint8Array<ArrayBuffer>;
  secretKeyVersion: number;
  secretLastFour: string;
  secretNonce: Uint8Array<ArrayBuffer>;
}

/** Column values for a rotation: a new current secret, the replaced one kept for the overlap. */
export function rotatedSecretColumns(
  existing: EndpointSecretColumns & { secretLastFour: string },
  now: Date,
  given?: string
) {
  const next = newSecretColumns(given);
  const previousExpiresAt = new Date(now.getTime() + ENDPOINT_ROTATION_OVERLAP_MS);
  return {
    data: {
      ...next.data,
      previousSecretAuthTag: Uint8Array.from(existing.secretAuthTag),
      previousSecretCiphertext: Uint8Array.from(existing.secretCiphertext),
      previousSecretExpiresAt: previousExpiresAt,
      previousSecretKeyVersion: existing.secretKeyVersion,
      previousSecretLastFour: existing.secretLastFour,
      previousSecretNonce: Uint8Array.from(existing.secretNonce),
    },
    generated: next.generated,
    previousExpiresAt,
    secret: next.secret,
  };
}

/** Why a call was refused, for the gateway's own log only. */
export type EndpointVerificationFailure = WebhookSignatureFailure;

export type EndpointVerification =
  | { ok: true }
  | { ok: false; reason: EndpointVerificationFailure };

/** One header's value: a repeated header is ambiguous, and refused. */
function singleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null | 'repeated' {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.length === 1 ? (value[0] ?? null) : 'repeated';
  }
  return typeof value === 'string' ? value : null;
}

/** The header's value after the configured prefix (compared without case), or null. */
function afterPrefix(value: string, prefix: string | null): string | null {
  const trimmed = value.trim();
  if (!prefix) {
    return trimmed;
  }
  return trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? trimmed.slice(prefix.length).trim()
    : null;
}

/** A signature's bytes in its encoding, or null when it is not a 32-byte digest. */
function decodeDigest(text: string, encoding: SignatureEncoding): Buffer | null {
  if (encoding === 'hex') {
    return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
  }
  // Standard or URL-safe base64, padded or not.
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === 32 ? bytes : null;
}

/** Constant-time equality of two texts of any length: their digests are compared. */
function sameText(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Whether the call proves it came from someone holding the endpoint's secret:
 * - `autoswe-v1`: `X-AutoSwe-Signature`, the platform's own scheme (timestamped, 300 s);
 * - `hmac-sha256`: an HMAC-SHA256 of the raw body bytes in the configured header, after its
 *   prefix, hex or base64;
 * - `shared-secret-header`: the secret itself in the configured header, after its prefix.
 * Each compares in constant time against the current and an unexpired previous secret.
 */
export function verifyEndpointCall(args: {
  endpoint: EndpointVerificationConfig;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  now: Date;
}): EndpointVerification {
  const { endpoint, headers, rawBody, now } = args;
  const secrets = endpointSecrets(endpoint, now);
  const scheme = endpoint.scheme as EventEndpointScheme;
  if (scheme === 'autoswe-v1') {
    const result = verifyWebhookSignature({
      header: headers['x-autoswe-signature'],
      nowSec: Math.floor(now.getTime() / 1000),
      rawBody,
      secrets,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  if (!endpoint.signatureHeader) {
    return { ok: false, reason: 'missing' };
  }
  const header = singleHeader(headers, endpoint.signatureHeader);
  if (header === null || header.trim() === '') {
    return { ok: false, reason: 'missing' };
  }
  if (header === 'repeated') {
    return { ok: false, reason: 'malformed' };
  }
  const value = afterPrefix(header, endpoint.signaturePrefix);
  if (value === null || value === '') {
    return { ok: false, reason: 'malformed' };
  }
  if (scheme === 'shared-secret-header') {
    // Every secret is compared, so the time taken does not say which one matched.
    let matched = false;
    for (const secret of secrets) {
      matched = sameText(value, secret) || matched;
    }
    return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  if (scheme === 'hmac-sha256') {
    const encoding = (endpoint.signatureEncoding ?? 'hex') as SignatureEncoding;
    const given = decodeDigest(value, encoding);
    if (!given) {
      return { ok: false, reason: 'malformed' };
    }
    let matched = false;
    for (const secret of secrets) {
      const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
      matched = timingSafeEqual(expected, given) || matched;
    }
    return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  return { ok: false, reason: 'malformed' };
}

export type EventDocument =
  | { ok: true; document: unknown }
  | { ok: false; code: 'INVALID_EVENT' | 'UNSUPPORTED_EVENT'; message: string };

function parseJson(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/**
 * The document an endpoint's pointers address, read from a verified body:
 * - `json`: the body, which must be JSON;
 * - `cloudevents`: a structured-mode event (`application/cloudevents+json`), whose attributes are
 *   in the body the signature covers. Binary mode is refused: its attributes travel in `ce-*`
 *   headers, which no scheme signs, so a captured call could be re-sent as another event.
 */
export function readEventDocument(args: {
  format: EventEndpointFormat | string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}): EventDocument {
  const { format, headers, rawBody } = args;
  const contentType = (typeof headers['content-type'] === 'string' ? headers['content-type'] : '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (format === 'cloudevents') {
    const binary = Object.keys(headers).some((h) => h.toLowerCase().startsWith('ce-'));
    if (binary || contentType !== 'application/cloudevents+json') {
      return {
        code: 'UNSUPPORTED_EVENT',
        message:
          'Only structured-mode CloudEvents are accepted: one event as application/cloudevents+json, with no ce-* headers',
        ok: false,
      };
    }
    const parsed = parseJson(rawBody);
    if (!parsed.ok || !isCloudEventEnvelope(parsed.value)) {
      return { code: 'INVALID_EVENT', message: 'The body is not a CloudEvent', ok: false };
    }
    return { document: parsed.value, ok: true };
  }
  const parsed = parseJson(rawBody);
  return parsed.ok
    ? { document: parsed.value, ok: true }
    : { code: 'INVALID_EVENT', message: 'The body is not JSON', ok: false };
}

/** Hex SHA-256. */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
