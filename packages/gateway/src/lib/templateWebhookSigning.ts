import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { resolveSetting } from '@auto-swe/shared/config';
import { decryptSecret, type EncryptedSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  generateWebhookSigningSecret,
  verifyWebhookSignature,
  type WebhookSignatureFailure,
} from '@auto-swe/shared/lib/webhookSigning';

/**
 * Signing for a template's public webhook (`POST /api/v1/webhooks/:token`,
 * docs/automations.md §5). The token in the URL names the template; a signing
 * secret proves the body came from someone holding the secret, and that it is
 * recent. Both live on the `WorkflowTemplate` row, the secret sealed with the
 * same AES-GCM envelope as every other stored credential.
 */

/** How long the secret a rotation replaced is still accepted. */
export const SIGNING_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** The signing columns of a template row, as the routes read them. */
export interface TemplateSigningColumns {
  webhookSigningSecretCiphertext: Uint8Array | null;
  webhookSigningSecretNonce: Uint8Array | null;
  webhookSigningSecretAuthTag: Uint8Array | null;
  webhookSigningSecretKeyVersion: number | null;
  webhookSigningSecretLastFour: string | null;
  webhookPreviousSigningSecretCiphertext: Uint8Array | null;
  webhookPreviousSigningSecretNonce: Uint8Array | null;
  webhookPreviousSigningSecretAuthTag: Uint8Array | null;
  webhookPreviousSigningSecretKeyVersion: number | null;
  webhookPreviousSigningSecretExpiresAt: Date | null;
  webhookRequireSignature: boolean;
}

/** What may be shown about a template's signing — never the secret. */
export interface WebhookSigningState {
  configured: boolean;
  lastFour: string | null;
  /** When the previous secret stops being accepted; null when there is none, or it lapsed. */
  previousExpiresAt: Date | null;
  requireSignature: boolean;
}

export function webhookSigningState(
  tpl: Partial<TemplateSigningColumns>,
  now: Date = new Date()
): WebhookSigningState {
  const expires = tpl.webhookPreviousSigningSecretExpiresAt ?? null;
  return {
    configured: tpl.webhookSigningSecretCiphertext != null,
    lastFour: tpl.webhookSigningSecretLastFour ?? null,
    previousExpiresAt:
      tpl.webhookPreviousSigningSecretCiphertext != null && expires && expires > now
        ? expires
        : null,
    requireSignature: tpl.webhookRequireSignature === true,
  };
}

/** The secrets a call may be signed with: the current one, then an unexpired previous one. */
export function templateWebhookSecrets(tpl: TemplateSigningColumns, now: Date): string[] {
  const secrets: string[] = [];
  if (
    tpl.webhookSigningSecretCiphertext &&
    tpl.webhookSigningSecretNonce &&
    tpl.webhookSigningSecretAuthTag &&
    tpl.webhookSigningSecretKeyVersion != null
  ) {
    secrets.push(
      decryptSecret({
        authTag: tpl.webhookSigningSecretAuthTag,
        ciphertext: tpl.webhookSigningSecretCiphertext,
        keyVersion: tpl.webhookSigningSecretKeyVersion,
        nonce: tpl.webhookSigningSecretNonce,
      })
    );
  }
  const expires = tpl.webhookPreviousSigningSecretExpiresAt;
  if (
    tpl.webhookPreviousSigningSecretCiphertext &&
    tpl.webhookPreviousSigningSecretNonce &&
    tpl.webhookPreviousSigningSecretAuthTag &&
    tpl.webhookPreviousSigningSecretKeyVersion != null &&
    expires &&
    expires > now
  ) {
    secrets.push(
      decryptSecret({
        authTag: tpl.webhookPreviousSigningSecretAuthTag,
        ciphertext: tpl.webhookPreviousSigningSecretCiphertext,
        keyVersion: tpl.webhookPreviousSigningSecretKeyVersion,
        nonce: tpl.webhookPreviousSigningSecretNonce,
      })
    );
  }
  return secrets;
}

/**
 * Whether policy requires signing for this template (`workflow.templateWebhookRequireSignature`),
 * resolved like any setting for the template's team: most specific scope wins, so a TEAM false
 * overrides an ORGANIZATION or GLOBAL true. A global template has neither, so only the GLOBAL
 * value applies to it.
 */
export async function signatureRequiredByPolicy(scope: {
  teamId: string | null;
  orgId: string | null | undefined;
}): Promise<boolean> {
  const value = await resolveSetting('workflow.templateWebhookRequireSignature', {
    ...(scope.orgId ? { orgId: scope.orgId } : {}),
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
  });
  return value === true;
}

export type TemplateSignatureCheck =
  | {
      ok: true;
      verified: false;
    }
  | {
      ok: true;
      verified: true;
      /**
       * The run's idempotency key for a verified call: the signed timestamp and a hash of the
       * signed bytes. A replay of the same signed call within the tolerance maps to the same run,
       * whatever `Idempotency-Key` (an unsigned header) it carries, and whichever `v1` entry or
       * secret it verified with.
       */
      idempotencyKey: string;
    }
  | {
      ok: false;
      status: 401 | 409;
      code: 'SIGNATURE_INVALID' | 'WEBHOOK_SIGNING_NOT_CONFIGURED';
      message: string;
      /** For the decision ledger. */
      reason: string;
    };

const FAILURE_TEXT: Record<WebhookSignatureFailure, string> = {
  malformed: 'the X-AutoSwe-Signature header is malformed',
  mismatch: 'the signature does not match the body',
  missing: 'the call is not signed (no X-AutoSwe-Signature header)',
  stale: 'the signature timestamp is outside the 5-minute tolerance',
};

/**
 * Decide a call's signature. Signing is required when the template asks for it or policy
 * requires it; then an unsigned or badly signed call is refused, and a template with no secret
 * refuses every call. When it is not required, a call that carries a signature is still checked
 * against a configured secret. That is not a protection — a forger simply omits the header — but
 * it surfaces a misconfigured sender (wrong secret, re-serialised body) before the template is
 * switched to require signatures. A signature on a template with no secret is ignored.
 */
export function checkTemplateSignature(args: {
  template: TemplateSigningColumns;
  required: boolean;
  header: string | string[] | undefined;
  rawBody: Buffer;
  now: Date;
}): TemplateSignatureCheck {
  const { template, required, header, rawBody, now } = args;
  const secrets = templateWebhookSecrets(template, now);
  const signed =
    typeof header === 'string'
      ? header.trim().length > 0
      : Array.isArray(header) && header.length > 0;
  if (secrets.length === 0) {
    if (required) {
      return {
        code: 'WEBHOOK_SIGNING_NOT_CONFIGURED',
        message: 'This webhook requires signed calls but has no signing secret configured',
        ok: false,
        reason: 'signing is required but the template has no signing secret',
        status: 409,
      };
    }
    return { ok: true, verified: false };
  }
  if (!required && !signed) {
    return { ok: true, verified: false };
  }
  const result = verifyWebhookSignature({
    header,
    nowSec: Math.floor(now.getTime() / 1000),
    rawBody,
    secrets,
  });
  if (!result.ok) {
    return {
      code: 'SIGNATURE_INVALID',
      message: `Signature refused: ${FAILURE_TEXT[result.reason]}`,
      ok: false,
      reason: FAILURE_TEXT[result.reason],
      status: 401,
    };
  }
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return { idempotencyKey: `sig:${result.timestamp}:${bodyHash}`, ok: true, verified: true };
}

/** Where {@link captureRawBodyBytes} leaves the body. */
export interface RawBodyBytes {
  rawBodyBytes?: Buffer;
}

/**
 * A route `preParsing` hook that keeps the request body's exact bytes on
 * `request.rawBodyBytes` and hands Fastify an identical stream to parse. The gateway's raw-body
 * plugin decodes to a UTF-8 string, which would change a body that is not valid UTF-8 (or drop a
 * BOM) before the MAC is checked; this keeps the bytes as sent. The route's `bodyLimit` is
 * enforced while reading, so the capture cannot be used to buffer more than the route accepts.
 */
export async function captureRawBodyBytes(
  request: { routeOptions: { bodyLimit?: number } } & RawBodyBytes,
  _reply: unknown,
  payload: AsyncIterable<Buffer | string>
): Promise<Readable> {
  const limit = request.routeOptions.bodyLimit ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > limit) {
      throw Object.assign(new Error('Request body is too large'), {
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        statusCode: 413,
      });
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  request.rawBodyBytes = body;
  const stream = Readable.from(body.length > 0 ? [body] : []) as Readable & {
    receivedEncodedLength?: number;
  };
  stream.receivedEncodedLength = body.length;
  return stream;
}

/** Column values for a freshly generated secret, the replaced one kept as previous. */
export function rotatedSigningColumns(
  existing: TemplateSigningColumns,
  now: Date
): { secret: string; data: Record<string, unknown>; previousExpiresAt: Date | null } {
  const secret = generateWebhookSigningSecret();
  const sealed: EncryptedSecret = encryptSecret(secret);
  const hadCurrent = existing.webhookSigningSecretCiphertext != null;
  const previousExpiresAt = hadCurrent
    ? new Date(now.getTime() + SIGNING_ROTATION_OVERLAP_MS)
    : null;
  return {
    data: {
      webhookPreviousSigningSecretAuthTag: hadCurrent ? existing.webhookSigningSecretAuthTag : null,
      webhookPreviousSigningSecretCiphertext: hadCurrent
        ? existing.webhookSigningSecretCiphertext
        : null,
      webhookPreviousSigningSecretExpiresAt: previousExpiresAt,
      webhookPreviousSigningSecretKeyVersion: hadCurrent
        ? existing.webhookSigningSecretKeyVersion
        : null,
      webhookPreviousSigningSecretLastFour: hadCurrent
        ? existing.webhookSigningSecretLastFour
        : null,
      webhookPreviousSigningSecretNonce: hadCurrent ? existing.webhookSigningSecretNonce : null,
      webhookSigningSecretAuthTag: sealed.authTag,
      webhookSigningSecretCiphertext: sealed.ciphertext,
      webhookSigningSecretKeyVersion: sealed.keyVersion,
      webhookSigningSecretLastFour: sealed.lastFour,
      webhookSigningSecretNonce: sealed.nonce,
    },
    previousExpiresAt,
    secret,
  };
}

/** Column values that remove both secrets. */
export const CLEARED_SIGNING_COLUMNS = {
  webhookPreviousSigningSecretAuthTag: null,
  webhookPreviousSigningSecretCiphertext: null,
  webhookPreviousSigningSecretExpiresAt: null,
  webhookPreviousSigningSecretKeyVersion: null,
  webhookPreviousSigningSecretLastFour: null,
  webhookPreviousSigningSecretNonce: null,
  webhookSigningSecretAuthTag: null,
  webhookSigningSecretCiphertext: null,
  webhookSigningSecretKeyVersion: null,
  webhookSigningSecretLastFour: null,
  webhookSigningSecretNonce: null,
} as const;
