import { describe, expect, it } from 'vitest';
import {
  AUTO_SWE_SIGNATURE_HEADER,
  AUTO_SWE_SIGNATURE_TEST_VECTOR,
  signAutoSweRequest,
  verifyAutoSweSignature,
} from './index.js';

/**
 * The SDK's half of the signing scheme. Pinned to the literal digest the
 * shared module's test pins (computed with an independent HMAC), so a change
 * to either side — or to the vector itself — fails both suites.
 */
const DIGEST = '7019491da35d47ce8687140e7d4fb0a7c5258b31f6a62b6216aef795582874b0';

describe('@auto-swe/sdk webhook signatures', () => {
  it('publishes the header name and the known-answer vector', () => {
    expect(AUTO_SWE_SIGNATURE_HEADER).toBe('X-AutoSwe-Signature');
    expect(AUTO_SWE_SIGNATURE_TEST_VECTOR.signature).toBe(DIGEST);
    expect(AUTO_SWE_SIGNATURE_TEST_VECTOR.header).toBe(`t=1760400000,v1=${DIGEST}`);
  });

  it('signs the vector to the pinned digest', () => {
    const v = AUTO_SWE_SIGNATURE_TEST_VECTOR;
    expect(signAutoSweRequest(v.secret, v.body, v.timestamp)).toBe(`t=${v.timestamp},v1=${DIGEST}`);
  });

  it('verifies a signed request and refuses a tampered one', () => {
    const v = AUTO_SWE_SIGNATURE_TEST_VECTOR;
    const ok = verifyAutoSweSignature({
      header: `t=${v.timestamp},v1=${DIGEST}`,
      nowSec: v.timestamp + 10,
      rawBody: v.body,
      secrets: [v.secret],
    });
    expect(ok).toEqual({ ok: true, secretIndex: 0, timestamp: v.timestamp });
    const tampered = verifyAutoSweSignature({
      header: v.header,
      nowSec: v.timestamp,
      rawBody: `${v.body} `,
      secrets: [v.secret],
    });
    expect(tampered).toEqual({ ok: false, reason: 'mismatch' });
  });
});
