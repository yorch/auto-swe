import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSlackChannelIsPrivate,
  SLACK_TIMESTAMP_MAX_AGE,
  verifySlackSignature,
} from './slack.js';

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

describe('fetchSlackChannelIsPrivate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stub `fetch` with a canned `conversations.info` body. */
  function respond(body: unknown): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async () => ({ json: async () => body }) as never);
    globalThis.fetch = spy as never;
    return spy;
  }

  it('returns what Slack says', async () => {
    respond({ channel: { is_private: true }, ok: true });
    expect(await fetchSlackChannelIsPrivate('C1', 'xoxb')).toBe(true);

    respond({ channel: { is_private: false }, ok: true });
    expect(await fetchSlackChannelIsPrivate('C1', 'xoxb')).toBe(false);
  });

  it('asks about the right channel and authenticates with the token', async () => {
    const spy = respond({ channel: { is_private: false }, ok: true });
    await fetchSlackChannelIsPrivate('G/1 2', 'xoxb-secret');
    const [url, init] = spy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('conversations.info');
    // Encoded, so a channel id can never break out of the query string.
    expect(url).toContain(`channel=${encodeURIComponent('G/1 2')}`);
    expect(init.headers.Authorization).toBe('Bearer xoxb-secret');
  });

  it.each([
    ['no token', undefined, { channel: { is_private: true }, ok: true }],
    ['a Slack error (e.g. missing groups:read)', 'xoxb', { error: 'missing_scope', ok: false }],
    ['an ok response with no channel', 'xoxb', { ok: true }],
    [
      'an ok response with a non-boolean flag',
      'xoxb',
      { channel: { is_private: 'yes' }, ok: true },
    ],
  ])('returns null on %s', async (_label, token, body) => {
    // `null`, never `false`: the caller must fall back to its heuristic rather
    // than record a private channel as public, which is permanent.
    respond(body);
    expect(await fetchSlackChannelIsPrivate('C1', token)).toBeNull();
  });

  it('returns null when the request throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    expect(await fetchSlackChannelIsPrivate('C1', 'xoxb')).toBeNull();
  });

  it('does not call Slack at all without a token', async () => {
    const spy = respond({ channel: { is_private: true }, ok: true });
    await fetchSlackChannelIsPrivate('C1', undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});
