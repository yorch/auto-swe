import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signEvidenceLink, verifyEvidenceLink } from './evidenceDownloadLink.js';

const originalKey = process.env.CONFIG_ENCRYPTION_KEY;
const INPUT = {
  eid: 'evidence-1',
  rid: 'run-1',
  sub: 'user-1',
};

describe('evidence download links', () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = originalKey;
    }
    _resetKeyCacheForTests();
  });

  it('signs short-lived links bound to one user, run, and evidence item', () => {
    const now = 1_800_000_000_000;
    const { expiresAt, token } = signEvidenceLink(INPUT, now);
    expect(expiresAt.getTime()).toBe(now + 300_000);
    expect(verifyEvidenceLink(token, now)).toMatchObject({ claims: INPUT, ok: true });
    expect(verifyEvidenceLink(token, now + 300_000)).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects modified tokens and malformed payloads', () => {
    const { token } = signEvidenceLink(INPUT);
    expect(verifyEvidenceLink(`${token.slice(0, -1)}x`).ok).toBe(false);
    expect(verifyEvidenceLink('not-a-token')).toEqual({ ok: false, reason: 'malformed' });
  });
});
