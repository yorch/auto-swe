import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { signWebhookBody } from '@auto-swe/shared/lib/webhookSigning';
import { describe, expect, it, vi } from 'vitest';
import {
  checkTemplateSignature,
  signatureRequiredByPolicy,
  type TemplateSigningColumns,
  webhookSigningState,
} from './templateWebhookSigning.js';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString('base64');

const resolveSetting = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting }));

const NONE: TemplateSigningColumns = {
  webhookPreviousSigningSecretAuthTag: null,
  webhookPreviousSigningSecretCiphertext: null,
  webhookPreviousSigningSecretExpiresAt: null,
  webhookPreviousSigningSecretKeyVersion: null,
  webhookPreviousSigningSecretNonce: null,
  webhookRequireSignature: false,
  webhookSigningSecretAuthTag: null,
  webhookSigningSecretCiphertext: null,
  webhookSigningSecretKeyVersion: null,
  webhookSigningSecretLastFour: null,
  webhookSigningSecretNonce: null,
};

function withSecret(secret: string): TemplateSigningColumns {
  const s = encryptSecret(secret);
  return {
    ...NONE,
    webhookSigningSecretAuthTag: s.authTag,
    webhookSigningSecretCiphertext: s.ciphertext,
    webhookSigningSecretKeyVersion: s.keyVersion,
    webhookSigningSecretLastFour: s.lastFour,
    webhookSigningSecretNonce: s.nonce,
  };
}

describe('webhookSigningState', () => {
  it('reports an expired previous secret as gone', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    const prev = {
      ...withSecret('whsec_a'),
      webhookPreviousSigningSecretCiphertext: new Uint8Array([1]),
    };
    expect(
      webhookSigningState(
        { ...prev, webhookPreviousSigningSecretExpiresAt: new Date('2026-10-14T11:59:59Z') },
        now
      ).previousExpiresAt
    ).toBeNull();
    expect(
      webhookSigningState(
        { ...prev, webhookPreviousSigningSecretExpiresAt: new Date('2026-10-14T12:00:01Z') },
        now
      ).previousExpiresAt
    ).toEqual(new Date('2026-10-14T12:00:01Z'));
    expect(webhookSigningState({})).toEqual({
      configured: false,
      lastFour: null,
      previousExpiresAt: null,
      requireSignature: false,
    });
  });
});

describe('checkTemplateSignature', () => {
  const now = new Date();
  const t = Math.floor(now.getTime() / 1000);

  it('ignores a signature on a template with no secret when signing is optional', () => {
    expect(
      checkTemplateSignature({
        header: signWebhookBody('whsec_x', '{}', t),
        now,
        rawBody: Buffer.from('{}'),
        required: false,
        template: NONE,
      })
    ).toEqual({ ok: true, verified: false });
  });

  it('treats an empty repeated header as unsigned', () => {
    expect(
      checkTemplateSignature({
        header: [],
        now,
        rawBody: Buffer.from('{}'),
        required: false,
        template: withSecret('whsec_x'),
      })
    ).toEqual({ ok: true, verified: false });
  });

  it('reports a verified call', () => {
    expect(
      checkTemplateSignature({
        header: signWebhookBody('whsec_x', '{}', t),
        now,
        rawBody: Buffer.from('{}'),
        required: true,
        template: withSecret('whsec_x'),
      })
    ).toEqual({
      idempotencyKey: `sig:${t}:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`,
      ok: true,
      verified: true,
    });
  });

  it('keys a verified call by its timestamp and bytes, whichever secret or entry matched', () => {
    const template = {
      ...withSecret('whsec_new'),
      ...(() => {
        const s = encryptSecret('whsec_old');
        return {
          webhookPreviousSigningSecretAuthTag: s.authTag,
          webhookPreviousSigningSecretCiphertext: s.ciphertext,
          webhookPreviousSigningSecretExpiresAt: new Date(now.getTime() + 60_000),
          webhookPreviousSigningSecretKeyVersion: s.keyVersion,
          webhookPreviousSigningSecretNonce: s.nonce,
        };
      })(),
    };
    const body = Buffer.from('{"a":1}');
    const keyOf = (header: string) => {
      const r = checkTemplateSignature({ header, now, rawBody: body, required: true, template });
      return r.ok && r.verified ? r.idempotencyKey : null;
    };
    const both = keyOf(signWebhookBody(['whsec_new', 'whsec_old'], body, t));
    expect(both).not.toBeNull();
    // Stripping one of the entries, or signing with the other secret, lands on the same key.
    expect(keyOf(signWebhookBody('whsec_old', body, t))).toBe(both);
    expect(keyOf(signWebhookBody('whsec_new', body, t))).toBe(both);
    // A different timestamp is a different call.
    expect(keyOf(signWebhookBody('whsec_new', body, t - 1))).not.toBe(both);
  });
});

describe('signatureRequiredByPolicy', () => {
  it('resolves with the team and organization, and GLOBAL only for a global template', async () => {
    await signatureRequiredByPolicy({ orgId: 'org-1', teamId: 'team-1' });
    expect(resolveSetting).toHaveBeenLastCalledWith('workflow.templateWebhookRequireSignature', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
    await signatureRequiredByPolicy({ orgId: null, teamId: null });
    expect(resolveSetting).toHaveBeenLastCalledWith('workflow.templateWebhookRequireSignature', {});
  });
});
