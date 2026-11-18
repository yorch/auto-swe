import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests } from './crypto.js';
import {
  mintOrchestrationToken,
  ORCHESTRATION_TOKEN_KEY_INFO,
  ORCHESTRATION_TOKEN_MAX_TTL_SECONDS,
  ORCHESTRATION_TOKEN_PREFIX,
  ORCHESTRATION_TOKEN_TTL_SECONDS,
  verifyOrchestrationToken,
} from './orchestrationTokenKey.js';

const saved = {
  key: process.env.CONFIG_ENCRYPTION_KEY,
  previous: process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS,
  version: process.env.CONFIG_ENCRYPTION_KEY_VERSION,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
function setKey(value: string, rotation?: { version: string; previous?: string }) {
  process.env.CONFIG_ENCRYPTION_KEY = value;
  restore('CONFIG_ENCRYPTION_KEY_VERSION', rotation?.version);
  restore('CONFIG_ENCRYPTION_KEY_PREVIOUS', rotation?.previous);
  _resetKeyCacheForTests();
}
const newKey = () => randomBytes(32).toString('base64');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const OID_A = '0b1c2d3e-0000-4000-8000-000000000001';
const OID_B = '0b1c2d3e-0000-4000-8000-000000000002';

/** Sign an arbitrary payload exactly as the minter would, to reach claim checks a mint refuses. */
function forge(payload: Record<string, unknown>, masterB64: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterB64, 'base64'),
      Buffer.alloc(0),
      ORCHESTRATION_TOKEN_KEY_INFO,
      32
    )
  );
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${ORCHESTRATION_TOKEN_PREFIX}${b64}.${createHmac('sha256', key).update(b64).digest('base64url')}`;
}
function payloadOf(token: string): Record<string, unknown> {
  const body = token.slice(ORCHESTRATION_TOKEN_PREFIX.length);
  return JSON.parse(Buffer.from(body.split('.')[0] as string, 'base64url').toString('utf8'));
}

let master: string;
beforeEach(() => {
  master = newKey();
  setKey(master);
});
afterAll(() => {
  restore('CONFIG_ENCRYPTION_KEY', saved.key);
  restore('CONFIG_ENCRYPTION_KEY_PREVIOUS', saved.previous);
  restore('CONFIG_ENCRYPTION_KEY_VERSION', saved.version);
  _resetKeyCacheForTests();
});

describe('orchestration token', () => {
  it('round-trips and names only the orchestration', () => {
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    expect(token.startsWith('orch_')).toBe(true);
    expect(verifyOrchestrationToken(token, NOW)).toEqual({ ok: true, orchestrationId: OID_A });
    const claims = payloadOf(token);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'jti', 'oid', 'v']);
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + ORCHESTRATION_TOKEN_TTL_SECONDS);
    expect(ORCHESTRATION_TOKEN_TTL_SECONDS).toBe(120);
  });

  it('gives every token its own id', () => {
    const a = payloadOf(mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW));
    const b = payloadOf(mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW));
    expect(a.jti).not.toBe(b.jti);
  });

  it('refuses a tampered payload and a tampered signature', () => {
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    const [head, sig] = token.slice(5).split('.') as [string, string];
    const claims = { ...payloadOf(token), oid: OID_B };
    const swapped = `orch_${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyOrchestrationToken(swapped, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    const flipped = `orch_${head}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyOrchestrationToken(flipped, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts only the canonical base64url of the 32-byte MAC', () => {
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    const [head, sig] = token.slice(5).split('.') as [string, string];
    expect(sig).toHaveLength(43);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // The last character carries 4 data bits and 2 padding bits: flip a padding bit and the
    // lenient decoder still reads the same 32 bytes.
    const last = alphabet.indexOf(sig.slice(-1));
    const extraBits = `${sig.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(extraBits, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    for (const variant of [
      extraBits,
      `${sig}=`,
      `${sig}==`,
      `${sig}x`,
      `${sig}!!!`,
      `${sig}\n`,
      `${sig.slice(0, 10)}!${sig.slice(10)}`,
      sig.slice(0, -1),
      '',
    ]) {
      expect(
        verifyOrchestrationToken(`orch_${head}.${variant}`, NOW),
        JSON.stringify(variant)
      ).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
    expect(verifyOrchestrationToken(token, NOW).ok).toBe(true);
  });

  it('accepts only the canonical base64url of the payload, even when correctly signed', () => {
    const claims = {
      ...payloadOf(mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW)),
    };
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(master, 'base64'),
        Buffer.alloc(0),
        ORCHESTRATION_TOKEN_KEY_INFO,
        32
      )
    );
    const sign = (b64: string) =>
      `${ORCHESTRATION_TOKEN_PREFIX}${b64}.${createHmac('sha256', key).update(b64).digest('base64url')}`;
    const canonical = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(verifyOrchestrationToken(sign(canonical), NOW).ok).toBe(true);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variants = [
      `${canonical}=`,
      `${canonical}==`,
      `${canonical.slice(0, 5)}!${canonical.slice(5)}`,
    ];
    // Extra bits in the final character, when the length leaves some.
    if (canonical.length % 4 !== 0) {
      variants.push(
        `${canonical.slice(0, -1)}${alphabet[alphabet.indexOf(canonical.slice(-1)) ^ 1]}`
      );
    }
    for (const variant of variants) {
      expect(verifyOrchestrationToken(sign(variant), NOW), variant).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses malformed input', () => {
    for (const bad of [
      '',
      'orch_',
      'orch_abc',
      'orch_a.b.c',
      'orch_.sig',
      'jwt.x.y',
      'orch_!!.!!',
    ]) {
      const r = verifyOrchestrationToken(bad, NOW);
      expect(r.ok).toBe(false);
    }
    const oversized = `orch_${'a'.repeat(5000)}.sig`;
    expect(verifyOrchestrationToken(oversized, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a token signed under a different key', () => {
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    setKey(newKey());
    expect(verifyOrchestrationToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses an expired token and honours the clock edge', () => {
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, 120, NOW);
    expect(verifyOrchestrationToken(token, NOW + 119_000).ok).toBe(true);
    expect(verifyOrchestrationToken(token, NOW + 120_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a correctly signed token whose lifetime is too long', () => {
    const iat = Math.floor(NOW / 1000);
    const long = forge(
      {
        exp: iat + ORCHESTRATION_TOKEN_MAX_TTL_SECONDS + 1,
        iat,
        jti: 'x',
        oid: OID_A,
        v: 1,
      },
      master
    );
    expect(verifyOrchestrationToken(long, NOW)).toEqual({ ok: false, reason: 'invalid_claims' });
    // The minter itself will sign one, and admission still refuses it.
    const minted = mintOrchestrationToken({ orchestrationId: OID_A }, 3600, NOW);
    expect(verifyOrchestrationToken(minted, NOW)).toEqual({ ok: false, reason: 'invalid_claims' });
    const max = mintOrchestrationToken({ orchestrationId: OID_A }, 300, NOW);
    expect(verifyOrchestrationToken(max, NOW).ok).toBe(true);
  });

  it('refuses an exp far in the future for a recent iat, and a future iat', () => {
    const iat = Math.floor(NOW / 1000);
    const future = forge(
      { exp: iat + 3600 + 100, iat: iat + 3600, jti: 'x', oid: OID_A, v: 1 },
      master
    );
    expect(verifyOrchestrationToken(future, NOW)).toEqual({ ok: false, reason: 'invalid_claims' });
  });

  it('refuses signed payloads with the wrong claim shape', () => {
    const iat = Math.floor(NOW / 1000);
    const base = { exp: iat + 60, iat, jti: 'x', oid: OID_A, v: 1 };
    for (const bad of [
      { ...base, oid: 'not-a-uuid' },
      { ...base, oid: 7 },
      { ...base, jti: undefined },
      { ...base, exp: 'soon' },
      { ...base, exp: iat },
    ]) {
      expect(verifyOrchestrationToken(forge(bad, master), NOW)).toEqual({
        ok: false,
        reason: 'invalid_claims',
      });
    }
  });

  it('refuses a version this process holds no key for', () => {
    const iat = Math.floor(NOW / 1000);
    const wrongVersion = forge({ exp: iat + 60, iat, jti: 'x', oid: OID_A, v: 7 }, master);
    expect(verifyOrchestrationToken(wrongVersion, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const noVersion = forge({ exp: iat + 60, iat, jti: 'x', oid: OID_A }, master);
    expect(verifyOrchestrationToken(noVersion, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('keeps verifying a token across a key rotation while the previous key is loaded', () => {
    const old = master;
    const token = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    expect(payloadOf(token).v).toBe(1);
    // Rotate: new current key at version 2, the old one kept as the previous key.
    setKey(newKey(), { previous: old, version: '2' });
    expect(verifyOrchestrationToken(token, NOW)).toEqual({ ok: true, orchestrationId: OID_A });
    const fresh = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    expect(payloadOf(fresh).v).toBe(2);
    expect(verifyOrchestrationToken(fresh, NOW).ok).toBe(true);
    // Once the previous key is dropped, the old token stops verifying.
    const current = process.env.CONFIG_ENCRYPTION_KEY as string;
    setKey(current, { version: '2' });
    expect(verifyOrchestrationToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is not the transcript-download or any other subkey purpose', () => {
    const iat = Math.floor(NOW / 1000);
    const key = Buffer.from(
      hkdfSync('sha256', Buffer.from(master, 'base64'), Buffer.alloc(0), 'other-purpose', 32)
    );
    const b64 = Buffer.from(
      JSON.stringify({ exp: iat + 60, iat, jti: 'x', oid: OID_A, v: 1 })
    ).toString('base64url');
    const token = `orch_${b64}.${createHmac('sha256', key).update(b64).digest('base64url')}`;
    expect(verifyOrchestrationToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('reports the orchestration it names, so a caller can refuse a replay against another', () => {
    const forA = mintOrchestrationToken({ orchestrationId: OID_A }, undefined, NOW);
    const verified = verifyOrchestrationToken(forA, NOW);
    expect(verified).toEqual({ ok: true, orchestrationId: OID_A });
    expect(verified.ok && verified.orchestrationId === OID_B).toBe(false);
  });
});
