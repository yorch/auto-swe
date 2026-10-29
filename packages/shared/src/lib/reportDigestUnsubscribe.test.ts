import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests } from './crypto.js';
import {
  createReportDigestUnsubscribeToken,
  reportDigestUnsubscribeSubscriptionId,
  verifyReportDigestUnsubscribeToken,
} from './reportDigestUnsubscribe.js';

const subscriptionId = '11111111-2222-4333-8444-555555555555';
const email = 'digest@example.test';
const previousKey = process.env.CONFIG_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
  _resetKeyCacheForTests();
});

afterEach(() => {
  if (previousKey === undefined) {
    delete process.env.CONFIG_ENCRYPTION_KEY;
  } else {
    process.env.CONFIG_ENCRYPTION_KEY = previousKey;
  }
  _resetKeyCacheForTests();
});

describe('report digest unsubscribe tokens', () => {
  it('verifies a recipient token independent of email casing', () => {
    const token = createReportDigestUnsubscribeToken(subscriptionId, email);
    expect(reportDigestUnsubscribeSubscriptionId(token)).toBe(subscriptionId);
    expect(verifyReportDigestUnsubscribeToken(token, subscriptionId, email.toUpperCase())).toBe(
      true
    );
  });

  it('rejects a wrong recipient, wrong subscription, malformed, or tampered token', () => {
    const token = createReportDigestUnsubscribeToken(subscriptionId, email);
    const [id, version, signature] = token.split('.');
    const tampered = `${id}.${version}.${signature?.slice(0, -1)}x`;
    expect(verifyReportDigestUnsubscribeToken(token, subscriptionId, 'other@example.test')).toBe(
      false
    );
    expect(
      verifyReportDigestUnsubscribeToken(token, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email)
    ).toBe(false);
    expect(verifyReportDigestUnsubscribeToken(tampered, subscriptionId, email)).toBe(false);
    expect(reportDigestUnsubscribeSubscriptionId('bad-token')).toBeNull();
  });
});
