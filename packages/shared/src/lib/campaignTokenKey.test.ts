import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CAMPAIGN_TOKEN_KEY_INFO,
  CAMPAIGN_TOKEN_MAX_TTL_SECONDS,
  CAMPAIGN_TOKEN_PREFIX,
  CAMPAIGN_TOKEN_TTL_SECONDS,
  campaignTokenMatches,
  mintCampaignToken,
  verifyCampaignToken,
} from './campaignTokenKey.js';
import { _resetKeyCacheForTests } from './crypto.js';
import { mintOrchestrationToken, verifyOrchestrationToken } from './orchestrationTokenKey.js';

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

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const CID = '0b1c2d3e-0000-4000-8000-000000000001';
const TID = '0b1c2d3e-0000-4000-8000-000000000002';
const SCOPE = { call: 'startAttempt', campaignId: CID, targetId: TID } as const;

/** Sign an arbitrary payload exactly as the minter would, to reach claim checks a mint refuses. */
function forge(payload: Record<string, unknown>, masterB64: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterB64, 'base64'),
      Buffer.alloc(0),
      CAMPAIGN_TOKEN_KEY_INFO,
      32
    )
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(payloadB64).digest().toString('base64url');
  return `${CAMPAIGN_TOKEN_PREFIX}${payloadB64}.${sig}`;
}

describe('campaign token', () => {
  const master = newKey();
  beforeEach(() => setKey(master));
  afterAll(() => {
    restore('CONFIG_ENCRYPTION_KEY', saved.key);
    restore('CONFIG_ENCRYPTION_KEY_PREVIOUS', saved.previous);
    restore('CONFIG_ENCRYPTION_KEY_VERSION', saved.version);
    _resetKeyCacheForTests();
  });

  it('round-trips the scope', () => {
    const token = mintCampaignToken(SCOPE, CAMPAIGN_TOKEN_TTL_SECONDS, NOW);
    expect(token.startsWith(CAMPAIGN_TOKEN_PREFIX)).toBe(true);
    expect(verifyCampaignToken(token, NOW)).toEqual({ ok: true, ...SCOPE });
  });

  it('mints a distinct token each time', () => {
    expect(mintCampaignToken(SCOPE, 120, NOW)).not.toBe(mintCampaignToken(SCOPE, 120, NOW));
  });

  it('carries no user identity', () => {
    const token = mintCampaignToken(SCOPE, 120, NOW);
    const payload = JSON.parse(
      Buffer.from(
        token.slice(CAMPAIGN_TOKEN_PREFIX.length).split('.')[0] as string,
        'base64url'
      ).toString()
    );
    expect(Object.keys(payload).sort()).toEqual(['call', 'cid', 'exp', 'iat', 'jti', 'tid', 'v']);
  });

  it('expires', () => {
    const token = mintCampaignToken(SCOPE, 60, NOW);
    expect(verifyCampaignToken(token, NOW + 59_000).ok).toBe(true);
    expect(verifyCampaignToken(token, NOW + 60_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses malformed input', () => {
    for (const bad of [
      '',
      'camp_',
      'camp_abc',
      'camp_a.b.c',
      'orch_x.y',
      `${CAMPAIGN_TOKEN_PREFIX}${'a'.repeat(2000)}.${'b'.repeat(43)}`,
      `${CAMPAIGN_TOKEN_PREFIX}!!!.${'b'.repeat(43)}`,
    ]) {
      const r = verifyCampaignToken(bad, NOW);
      expect(r.ok).toBe(false);
    }
  });

  it('refuses a tampered payload or signature', () => {
    const token = mintCampaignToken(SCOPE, 120, NOW);
    const [payload, sig] = token.slice(CAMPAIGN_TOKEN_PREFIX.length).split('.') as [string, string];
    const other = JSON.parse(Buffer.from(payload, 'base64url').toString());
    other.tid = '0b1c2d3e-0000-4000-8000-0000000000ff';
    const swapped = `${CAMPAIGN_TOKEN_PREFIX}${Buffer.from(JSON.stringify(other)).toString('base64url')}.${sig}`;
    expect(verifyCampaignToken(swapped, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyCampaignToken(`${token}A`, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      verifyCampaignToken(`${token.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, NOW).ok
    ).toBe(false);
  });

  it('refuses a token signed under another key', () => {
    const token = mintCampaignToken(SCOPE, 120, NOW);
    setKey(newKey());
    expect(verifyCampaignToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is not interchangeable with the orchestration token', () => {
    const orch = mintOrchestrationToken({ orchestrationId: CID }, 120, NOW);
    expect(verifyCampaignToken(orch, NOW).ok).toBe(false);
    const camp = mintCampaignToken(SCOPE, 120, NOW);
    expect(verifyOrchestrationToken(camp, NOW).ok).toBe(false);
    // Same key, same body, other prefix: the info string alone keeps them apart.
    const asOrch = `orch_${camp.slice(CAMPAIGN_TOKEN_PREFIX.length)}`;
    expect(verifyOrchestrationToken(asOrch, NOW).ok).toBe(false);
  });

  it('verifies across a key rotation', () => {
    const token = mintCampaignToken(SCOPE, 120, NOW);
    const next = newKey();
    setKey(next, { previous: master, version: '2' });
    expect(verifyCampaignToken(token, NOW)).toEqual({ ok: true, ...SCOPE });
    setKey(next, { version: '2' });
    expect(verifyCampaignToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  describe('claim checks on a correctly signed token', () => {
    const iat = Math.floor(NOW / 1000);
    const good = { call: 'startAttempt', cid: CID, exp: iat + 60, iat, jti: 'x', tid: TID, v: 1 };
    const verify = (over: Record<string, unknown>) =>
      verifyCampaignToken(forge({ ...good, ...over }, master), NOW);

    it('accepts the baseline', () => {
      expect(verify({}).ok).toBe(true);
    });

    it('refuses a bad ids, an unknown call and non-integer times', () => {
      for (const over of [
        { cid: 'nope' },
        { tid: 5 },
        { call: 'cancel' },
        { call: undefined },
        { jti: 7 },
        { exp: 1.5 },
        { iat: 'x' },
      ]) {
        expect(verify(over)).toEqual({ ok: false, reason: 'invalid_claims' });
      }
    });

    it('refuses an overlong lifetime and a clock far ahead', () => {
      expect(verify({ exp: iat + CAMPAIGN_TOKEN_MAX_TTL_SECONDS + 1 })).toEqual({
        ok: false,
        reason: 'invalid_claims',
      });
      expect(verify({ exp: iat + 100, iat: iat + 120 })).toEqual({
        ok: false,
        reason: 'invalid_claims',
      });
      expect(verify({ exp: iat })).toEqual({ ok: false, reason: 'invalid_claims' });
    });
  });

  describe('campaignTokenMatches', () => {
    it('requires the same campaign, target and call', () => {
      expect(campaignTokenMatches(SCOPE, SCOPE)).toBe(true);
      expect(campaignTokenMatches(SCOPE, { ...SCOPE, campaignId: TID })).toBe(false);
      expect(campaignTokenMatches(SCOPE, { ...SCOPE, targetId: CID })).toBe(false);
      expect(campaignTokenMatches({ ...SCOPE, call: 'other' }, SCOPE)).toBe(false);
    });

    it('ignores id case', () => {
      expect(campaignTokenMatches(SCOPE, { ...SCOPE, campaignId: CID.toUpperCase() })).toBe(true);
    });
  });
});
