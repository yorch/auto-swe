import crypto from 'node:crypto';

/**
 * Verify GitHub webhook HMAC signature.
 * Returns true if the signature is valid.
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
