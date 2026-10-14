import { createHmac } from 'node:crypto';
import { signWebhookBody } from '@auto-swe/shared/lib/webhookSigning';
import { describe, expect, it } from 'vitest';
import {
  type EndpointVerificationConfig,
  endpointSecrets,
  newSecretColumns,
  readEventDocument,
  rotatedSecretColumns,
  verifyEndpointCall,
} from './eventEndpoints.js';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString('base64');

const NOW = new Date('2026-10-14T12:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from('{"type":"alert.fired","msg":"café ✓"}', 'utf8');

function endpoint(
  scheme: string,
  over: Partial<EndpointVerificationConfig> = {},
  secret = 'whsec_current_secret_value'
): EndpointVerificationConfig & { secretLastFour: string } {
  const sealed = newSecretColumns(secret).data;
  return {
    ...sealed,
    previousSecretAuthTag: null,
    previousSecretCiphertext: null,
    previousSecretExpiresAt: null,
    previousSecretKeyVersion: null,
    previousSecretNonce: null,
    scheme,
    signatureEncoding: scheme === 'hmac-sha256' ? 'hex' : null,
    signatureHeader: scheme === 'autoswe-v1' ? null : 'X-Signature',
    signaturePrefix: null,
    ...over,
  };
}

const verify = (
  e: EndpointVerificationConfig,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer = BODY,
  now: Date = NOW
) => verifyEndpointCall({ endpoint: e, headers, now, rawBody: body });

const hmac = (secret: string, body: Buffer, enc: 'hex' | 'base64' = 'hex') =>
  createHmac('sha256', secret).update(body).digest(enc);

describe('autoswe-v1', () => {
  const e = endpoint('autoswe-v1');
  it('accepts a timely signature over the exact bytes', () => {
    const header = signWebhookBody('whsec_current_secret_value', BODY, NOW_SEC);
    expect(verify(e, { 'x-autoswe-signature': header })).toEqual({ ok: true });
  });
  it('refuses a tampered body, a stale timestamp and a missing header', () => {
    const header = signWebhookBody('whsec_current_secret_value', BODY, NOW_SEC);
    const tampered = Buffer.from(BODY.toString().replace('fired', 'fixed'));
    expect(verify(e, { 'x-autoswe-signature': header }, tampered)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    const stale = signWebhookBody('whsec_current_secret_value', BODY, NOW_SEC - 301);
    expect(verify(e, { 'x-autoswe-signature': stale })).toEqual({ ok: false, reason: 'stale' });
    expect(verify(e, {})).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('hmac-sha256', () => {
  it('accepts hex and base64 digests after a prefix, compared without case', () => {
    const hex = endpoint('hmac-sha256', { signaturePrefix: 'sha256=' });
    expect(
      verify(hex, { 'x-signature': `SHA256=${hmac('whsec_current_secret_value', BODY)}` })
    ).toEqual({ ok: true });
    const b64 = endpoint('hmac-sha256', { signatureEncoding: 'base64' });
    expect(
      verify(b64, { 'x-signature': hmac('whsec_current_secret_value', BODY, 'base64') })
    ).toEqual({ ok: true });
    const url = hmac('whsec_current_secret_value', BODY, 'base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verify(b64, { 'x-signature': url })).toEqual({ ok: true });
  });

  it('refuses a tampered body, a wrong secret, a missing prefix, garbage and a repeated header', () => {
    const e = endpoint('hmac-sha256', { signaturePrefix: 'sha256=' });
    const good = `sha256=${hmac('whsec_current_secret_value', BODY)}`;
    expect(verify(e, { 'x-signature': good }, Buffer.from(`${BODY} `))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify(e, { 'x-signature': `sha256=${hmac('other-secret-value!', BODY)}` })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify(e, { 'x-signature': hmac('whsec_current_secret_value', BODY) })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verify(e, { 'x-signature': 'sha256=zz' })).toEqual({ ok: false, reason: 'malformed' });
    // Node joins a header sent twice into one value with ", ", which is not a digest.
    expect(verify(e, { 'x-signature': `${good}, ${good}` })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verify(e, {})).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('shared-secret-header', () => {
  const e = endpoint('shared-secret-header', {
    signatureHeader: 'Authorization',
    signaturePrefix: 'Bearer ',
  });
  it('accepts the secret after its prefix and nothing else', () => {
    expect(verify(e, { authorization: 'Bearer whsec_current_secret_value' })).toEqual({ ok: true });
    expect(verify(e, { authorization: 'Bearer whsec_current_secret_valuE' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify(e, { authorization: 'Bearer whsec' })).toEqual({ ok: false, reason: 'mismatch' });
    // A header sent twice, as Node joins it.
    expect(
      verify(e, {
        authorization: 'Bearer whsec_current_secret_value, Bearer whsec_current_secret_value',
      })
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify(e, { authorization: 'whsec_current_secret_value' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('rotation', () => {
  it('accepts the previous secret until it expires, then only the new one', () => {
    const before = endpoint('hmac-sha256');
    const rotated = rotatedSecretColumns(before, NOW, 'a-brand-new-secret-value');
    const after: EndpointVerificationConfig = { ...before, ...rotated.data };
    expect(rotated.previousExpiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(rotated.generated).toBe(false);
    expect(endpointSecrets(after, NOW)).toEqual([
      'a-brand-new-secret-value',
      'whsec_current_secret_value',
    ]);
    const old = { 'x-signature': hmac('whsec_current_secret_value', BODY) };
    const fresh = { 'x-signature': hmac('a-brand-new-secret-value', BODY) };
    expect(verify(after, old)).toEqual({ ok: true });
    expect(verify(after, fresh)).toEqual({ ok: true });
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(verify(after, old, BODY, later)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verify(after, fresh, BODY, later)).toEqual({ ok: true });
  });

  it('generates a secret when none is given', () => {
    const made = newSecretColumns();
    expect(made.generated).toBe(true);
    expect(made.secret).toMatch(/^whsec_/);
  });
});

describe('readEventDocument', () => {
  const json = (body: string, headers: Record<string, string> = {}, format = 'json') =>
    readEventDocument({
      format,
      headers: { 'content-type': 'application/json', ...headers },
      rawBody: Buffer.from(body),
    });

  it('parses a JSON body and refuses anything else', () => {
    expect(json('{"a":1}')).toEqual({ document: { a: 1 }, ok: true });
    expect(json('not json')).toMatchObject({ code: 'INVALID_EVENT', ok: false });
  });

  it('reads structured CloudEvents only: binary mode and batches are refused', () => {
    const structured = JSON.stringify({ id: '1', source: 's', specversion: '1.0', type: 't' });
    expect(
      json(
        structured,
        { 'content-type': 'application/cloudevents+json; charset=utf-8' },
        'cloudevents'
      )
    ).toMatchObject({ document: { id: '1', type: 't' }, ok: true });
    expect(
      json('{"id":"1"}', { 'content-type': 'application/cloudevents+json' }, 'cloudevents')
    ).toMatchObject({ code: 'INVALID_EVENT' });
    expect(
      json(
        '{"x":1}',
        { 'ce-id': '9', 'ce-source': 's', 'ce-specversion': '1.0', 'ce-type': 't' },
        'cloudevents'
      )
    ).toMatchObject({ code: 'UNSUPPORTED_EVENT', ok: false });
    // ce-* headers are refused even beside a structured body: they are not signed.
    expect(
      json(
        structured,
        { 'ce-id': '9', 'content-type': 'application/cloudevents+json' },
        'cloudevents'
      )
    ).toMatchObject({ code: 'UNSUPPORTED_EVENT' });
    expect(json('{"x":1}', {}, 'cloudevents')).toMatchObject({ code: 'UNSUPPORTED_EVENT' });
    expect(
      json('[]', { 'content-type': 'application/cloudevents-batch+json' }, 'cloudevents')
    ).toMatchObject({ code: 'UNSUPPORTED_EVENT' });
  });
});
