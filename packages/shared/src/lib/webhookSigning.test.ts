import { describe, expect, it } from 'vitest';
import {
  computeWebhookSignature,
  generateWebhookSigningSecret,
  signWebhookBody,
  WEBHOOK_SIGNATURE_TEST_VECTOR as VECTOR,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_TOLERANCE_SEC,
} from './webhookSigning.js';

const NOW = VECTOR.timestamp;

describe('the known-answer vector', () => {
  // Computed independently (Python's hmac module), so this pins the scheme
  // itself — `${t}.` + raw UTF-8 body bytes, secret as UTF-8 — not merely
  // this implementation's agreement with itself.
  it('is the vector the docs and the SDK publish', () => {
    // Literal on purpose: editing the exported vector must fail here too.
    expect(VECTOR).toEqual({
      body: '{"ticketId":"JIRA-1","description":"café ✓"}',
      emptyBodySignature: 'b94a1cf9fa1feb57bff40dd42449cfb081d86cbfd635ea09a4cf84eff4d8bd84',
      header: 't=1760400000,v1=7019491da35d47ce8687140e7d4fb0a7c5258b31f6a62b6216aef795582874b0',
      secret: 'whsec_test_vector_secret',
      signature: '7019491da35d47ce8687140e7d4fb0a7c5258b31f6a62b6216aef795582874b0',
      timestamp: 1760400000,
    });
  });

  it('signs the vector body to the published digest', () => {
    expect(computeWebhookSignature(VECTOR.secret, VECTOR.body, VECTOR.timestamp)).toBe(
      VECTOR.signature
    );
    expect(signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp)).toBe(VECTOR.header);
  });

  it('signs the same bytes passed as a string or as a buffer identically', () => {
    const bytes = new TextEncoder().encode(VECTOR.body);
    expect(computeWebhookSignature(VECTOR.secret, bytes, VECTOR.timestamp)).toBe(VECTOR.signature);
  });

  it('signs an empty body over the timestamp alone', () => {
    expect(computeWebhookSignature(VECTOR.secret, '', VECTOR.timestamp)).toBe(
      VECTOR.emptyBodySignature
    );
  });

  it('verifies the published header', () => {
    expect(
      verifyWebhookSignature({
        header: VECTOR.header,
        nowSec: NOW,
        rawBody: VECTOR.body,
        secrets: [VECTOR.secret],
      })
    ).toEqual({
      matchedDigest: VECTOR.signature,
      ok: true,
      secretIndex: 0,
      timestamp: VECTOR.timestamp,
    });
  });
});

describe('verifyWebhookSignature — refusals', () => {
  const verify = (
    header: string | string[] | undefined,
    over: Partial<{ body: string; now: number; secrets: string[] }> = {}
  ) =>
    verifyWebhookSignature({
      header,
      nowSec: over.now ?? NOW,
      rawBody: over.body ?? VECTOR.body,
      secrets: over.secrets ?? [VECTOR.secret],
    });

  it('missing: no header, an empty one, or whitespace', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(verify('')).toEqual({ ok: false, reason: 'missing' });
    expect(verify('   ')).toEqual({ ok: false, reason: 'missing' });
    expect(verify([])).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['no timestamp', `v1=${VECTOR.signature}`],
    ['no signature', `t=${NOW}`],
    ['two timestamps', `t=${NOW},t=${NOW},v1=${VECTOR.signature}`],
    ['a negative timestamp', `t=-1,v1=${VECTOR.signature}`],
    ['a fractional timestamp', `t=${NOW}.5,v1=${VECTOR.signature}`],
    ['an exponent timestamp', `t=1.7604e9,v1=${VECTOR.signature}`],
    ['a hex timestamp', `t=0x68ed3e00,v1=${VECTOR.signature}`],
    ['a 13-digit timestamp', `t=1760400000000,v1=${VECTOR.signature}`],
    ['a leading-zero timestamp', `t=0${NOW},v1=${VECTOR.signature}`],
    ['a plus-signed timestamp', `t=+${NOW},v1=${VECTOR.signature}`],
    ['an empty timestamp', `t=,v1=${VECTOR.signature}`],
    ['a short digest', `t=${NOW},v1=${VECTOR.signature.slice(0, 63)}`],
    ['a long digest', `t=${NOW},v1=${VECTOR.signature}0`],
    ['a non-hex digest', `t=${NOW},v1=${'z'.repeat(64)}`],
    ['a base64 digest', `t=${NOW},v1=${Buffer.from(VECTOR.signature, 'hex').toString('base64')}`],
    ['an entry without =', `t=${NOW},v1=${VECTOR.signature},junk`],
    ['an entry with an empty key', `t=${NOW},=x,v1=${VECTOR.signature}`],
    ['nine signatures', `t=${NOW}${`,v1=${VECTOR.signature}`.repeat(9)}`],
    ['an oversized header', `t=${NOW},v1=${VECTOR.signature},x=${'a'.repeat(4096)}`],
  ])('malformed: %s', (_label, header) => {
    expect(verify(header)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('stale: tolerance edges, in the past and the future', () => {
    const tol = WEBHOOK_SIGNATURE_TOLERANCE_SEC;
    expect(verify(VECTOR.header, { now: NOW + tol }).ok).toBe(true);
    expect(verify(VECTOR.header, { now: NOW - tol }).ok).toBe(true);
    expect(verify(VECTOR.header, { now: NOW + tol + 1 })).toEqual({ ok: false, reason: 'stale' });
    expect(verify(VECTOR.header, { now: NOW - tol - 1 })).toEqual({ ok: false, reason: 'stale' });
  });

  it('stale: a far-future timestamp is refused even with a correct digest', () => {
    const future = NOW + 10 * 365 * 24 * 3600;
    const header = signWebhookBody(VECTOR.secret, VECTOR.body, future);
    expect(verify(header)).toEqual({ ok: false, reason: 'stale' });
  });

  it('honours a custom tolerance', () => {
    const result = verifyWebhookSignature({
      header: VECTOR.header,
      nowSec: NOW + 61,
      rawBody: VECTOR.body,
      secrets: [VECTOR.secret],
      toleranceSec: 60,
    });
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('stale: a non-finite clock refuses rather than accepts', () => {
    expect(verify(VECTOR.header, { now: Number.NaN })).toEqual({ ok: false, reason: 'stale' });
  });

  it('mismatch: a tampered body', () => {
    expect(verify(VECTOR.header, { body: VECTOR.body.replace('JIRA-1', 'JIRA-2') })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('mismatch: the same JSON re-serialised is a different body', () => {
    const reserialised = JSON.stringify(JSON.parse(VECTOR.body), null, 1);
    expect(verify(VECTOR.header, { body: reserialised })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('mismatch: a timestamp moved without re-signing', () => {
    const moved = VECTOR.header.replace(`t=${NOW}`, `t=${NOW + 1}`);
    expect(verify(moved)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('mismatch: the wrong secret, or none held', () => {
    expect(verify(VECTOR.header, { secrets: ['whsec_other'] })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verify(VECTOR.header, { secrets: [] })).toEqual({ ok: false, reason: 'mismatch' });
    // An empty secret is ignored, not used as an HMAC key.
    expect(verify(VECTOR.header, { secrets: [''] })).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('verifyWebhookSignature — accepted forms', () => {
  it('accepts upper-case hex and surrounding whitespace', () => {
    const header = ` t=${NOW} , v1=${VECTOR.signature.toUpperCase()} `;
    expect(
      verifyWebhookSignature({
        header,
        nowSec: NOW,
        rawBody: VECTOR.body,
        secrets: [VECTOR.secret],
      }).ok
    ).toBe(true);
  });

  it('ignores unknown scheme entries alongside v1', () => {
    const header = `t=${NOW},v0=abc,v2=${'f'.repeat(128)},v1=${VECTOR.signature}`;
    expect(
      verifyWebhookSignature({
        header,
        nowSec: NOW,
        rawBody: VECTOR.body,
        secrets: [VECTOR.secret],
      }).ok
    ).toBe(true);
  });

  it('reads a repeated header as one list', () => {
    expect(
      verifyWebhookSignature({
        header: [`t=${NOW}`, `v1=${VECTOR.signature}`],
        nowSec: NOW,
        rawBody: VECTOR.body,
        secrets: [VECTOR.secret],
      }).ok
    ).toBe(true);
  });
});

describe('rotation', () => {
  const oldSecret = 'whsec_old';
  const newSecret = 'whsec_new';
  const body = '{"a":1}';

  it('a sender mid-rotation signs with both, and a receiver holding either accepts', () => {
    const header = signWebhookBody([newSecret, oldSecret], body, NOW);
    expect(header.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    for (const held of [[oldSecret], [newSecret]]) {
      expect(verifyWebhookSignature({ header, nowSec: NOW, rawBody: body, secrets: held }).ok).toBe(
        true
      );
    }
  });

  it('a receiver holding current and previous accepts either and says which matched', () => {
    const viaOld = signWebhookBody(oldSecret, body, NOW);
    const viaNew = signWebhookBody(newSecret, body, NOW);
    const held = [newSecret, oldSecret];
    expect(
      verifyWebhookSignature({ header: viaNew, nowSec: NOW, rawBody: body, secrets: held })
    ).toMatchObject({
      ok: true,
      secretIndex: 0,
    });
    expect(
      verifyWebhookSignature({ header: viaOld, nowSec: NOW, rawBody: body, secrets: held })
    ).toMatchObject({
      ok: true,
      secretIndex: 1,
    });
  });

  it('once the previous secret is dropped, its signatures stop verifying', () => {
    const viaOld = signWebhookBody(oldSecret, body, NOW);
    expect(
      verifyWebhookSignature({ header: viaOld, nowSec: NOW, rawBody: body, secrets: [newSecret] })
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('sign — input checks', () => {
  it('floors a fractional clock to whole seconds', () => {
    expect(signWebhookBody(VECTOR.secret, VECTOR.body, NOW + 0.9)).toBe(VECTOR.header);
  });

  it('refuses an empty secret, an empty secret list, or a negative time', () => {
    expect(() => signWebhookBody('', 'x', NOW)).toThrow(/empty/);
    expect(() => signWebhookBody([], 'x', NOW)).toThrow(/at least one/);
    expect(() => signWebhookBody('s', 'x', -1)).toThrow(/non-negative/);
  });

  it.each([-5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1_000_000_000_000])(
    'refuses to sign at t=%s, which no receiver would accept',
    (t) => {
      expect(() => signWebhookBody('s', 'x', t)).toThrow();
    }
  );

  it('signs the largest timestamp a receiver accepts', () => {
    const header = signWebhookBody('s', 'x', 999_999_999_999);
    expect(
      verifyWebhookSignature({ header, nowSec: 999_999_999_999, rawBody: 'x', secrets: ['s'] }).ok
    ).toBe(true);
  });
});

describe('generateWebhookSigningSecret', () => {
  it('is prefixed, 256 bits of base64url, and different every time', () => {
    const a = generateWebhookSigningSecret();
    const b = generateWebhookSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});
