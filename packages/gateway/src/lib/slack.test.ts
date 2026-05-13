import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SLACK_TIMESTAMP_MAX_AGE, verifySlackSignature } from './slack.js';

const SECRET = 'test-secret';

function sign(body: string, timestamp: string, secret = SECRET): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const now = 1_700_000_000;
  const ts = String(now);
  const body = 'payload=foo&bar=baz';

  it('accepts a fresh, well-signed request', () => {
    expect(verifySlackSignature(body, ts, sign(body, ts), SECRET, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySlackSignature(`${body}&extra=1`, ts, sign(body, ts), SECRET, now)).toBe(false);
  });

  it('rejects a wrong signing secret', () => {
    expect(verifySlackSignature(body, ts, sign(body, ts, 'other'), SECRET, now)).toBe(false);
  });

  it('rejects a stale timestamp (> 5min)', () => {
    const old = now - (SLACK_TIMESTAMP_MAX_AGE + 1);
    const oldTs = String(old);
    expect(verifySlackSignature(body, oldTs, sign(body, oldTs), SECRET, now)).toBe(false);
  });

  it('rejects a malformed timestamp', () => {
    expect(verifySlackSignature(body, 'not-a-number', sign(body, ts), SECRET, now)).toBe(false);
  });

  it('rejects when signatures have different lengths', () => {
    expect(verifySlackSignature(body, ts, 'v0=short', SECRET, now)).toBe(false);
  });
});
