import crypto from 'node:crypto';

/**
 * Verify GitHub webhook HMAC signature.
 * Returns true if the signature is valid.
 *
 * Handles malformed signatures gracefully — returns false instead of throwing
 * when buffer lengths differ (which would cause timingSafeEqual to throw).
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  // timingSafeEqual throws if buffers have different lengths.
  // A length mismatch means the signature is invalid.
  if (sigBuf.length !== expBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expBuf);
}
