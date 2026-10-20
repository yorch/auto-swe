import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DOWNLOAD_LINK_TTL_SECONDS,
  signDownloadLink,
  verifyDownloadLink,
} from './transcriptDownloadLink.js';

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
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const INPUT = { fmt: 'raw' as const, pii: false, sub: 'u-1', tid: 't-1' };

function resetKey(value: string, rotation?: { version: string; previous?: string }) {
  process.env.CONFIG_ENCRYPTION_KEY = value;
  restore('CONFIG_ENCRYPTION_KEY_VERSION', rotation?.version);
  restore('CONFIG_ENCRYPTION_KEY_PREVIOUS', rotation?.previous);
  _resetKeyCacheForTests();
}

beforeEach(() => resetKey(randomBytes(32).toString('base64')));

afterAll(() => {
  restore('CONFIG_ENCRYPTION_KEY', saved.key);
  restore('CONFIG_ENCRYPTION_KEY_PREVIOUS', saved.previous);
  restore('CONFIG_ENCRYPTION_KEY_VERSION', saved.version);
  _resetKeyCacheForTests();
});

describe('transcript download links', () => {
  it('round-trips claims and expires after the TTL', () => {
    const { expiresAt, token } = signDownloadLink(INPUT, NOW);
    expect(expiresAt.getTime()).toBe(NOW + DOWNLOAD_LINK_TTL_SECONDS * 1000);
    const ok = verifyDownloadLink(token, NOW + 1000);
    expect(ok).toMatchObject({ claims: { ...INPUT, kv: 1, v: 1 }, ok: true });
    expect(verifyDownloadLink(token, NOW + DOWNLOAD_LINK_TTL_SECONDS * 1000)).toMatchObject({
      claims: { sub: 'u-1', tid: 't-1' },
      ok: false,
      reason: 'expired',
    });
  });

  it('issues a different token each time (nonce)', () => {
    expect(signDownloadLink(INPUT, NOW).token).not.toBe(signDownloadLink(INPUT, NOW).token);
  });

  it('refuses a token whose payload was edited', () => {
    const { token } = signDownloadLink(INPUT, NOW);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...INPUT, exp: NOW / 1000 + 60, kv: 1, n: 'x', pii: true, v: 1 })
    ).toString('base64url');
    expect(verifyDownloadLink(`${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token signed under another key', () => {
    const { token } = signDownloadLink(INPUT, NOW);
    resetKey(randomBytes(32).toString('base64'));
    expect(verifyDownloadLink(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('verifies a link signed under the previous key while it is loaded, not after', () => {
    const oldKey = process.env.CONFIG_ENCRYPTION_KEY as string;
    const { token } = signDownloadLink(INPUT, NOW);
    const newKey = randomBytes(32).toString('base64');

    resetKey(newKey, { previous: oldKey, version: '2' });
    expect(verifyDownloadLink(token, NOW)).toMatchObject({ claims: { kv: 1 }, ok: true });
    // New links are signed under the new version.
    expect(verifyDownloadLink(signDownloadLink(INPUT, NOW).token, NOW)).toMatchObject({
      claims: { kv: 2 },
      ok: true,
    });

    resetKey(newKey, { version: '2' });
    expect(verifyDownloadLink(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a link whose key version was edited to one this process holds', () => {
    const oldKey = process.env.CONFIG_ENCRYPTION_KEY as string;
    resetKey(randomBytes(32).toString('base64'), { previous: oldKey, version: '2' });
    const { token } = signDownloadLink(INPUT, NOW);
    const [payload, sig] = token.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const edited = Buffer.from(JSON.stringify({ ...claims, kv: 1 })).toString('base64url');
    expect(verifyDownloadLink(`${edited}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses malformed tokens', () => {
    for (const token of ['', 'abc', 'a.b.c', '.sig']) {
      expect(verifyDownloadLink(token, NOW).ok).toBe(false);
    }
  });
});
