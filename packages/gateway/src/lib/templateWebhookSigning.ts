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
 * Whether policy forces signing for templates in this team or organization
 * (`workflow.templateWebhookRequireSignature`). A global template has neither,
 * so only the GLOBAL value applies to it.
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
  | { ok: true; verified: boolean }
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
 * Decide a call's signature. Signing is required when the template asks for it
 * or policy forces it; then an unsigned or badly signed call is refused, and a
 * template with no secret refuses every call. When it is not required, a call
 * that carries a signature is still checked against a configured secret, so a
 * sender that signs is protected from a forged body even before the template
 * enforces it. A signature on a template with no secret is ignored.
 */
export function checkTemplateSignature(args: {
  template: TemplateSigningColumns;
  required: boolean;
  header: string | string[] | undefined;
  rawBody: string | Buffer;
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
  return { ok: true, verified: true };
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
