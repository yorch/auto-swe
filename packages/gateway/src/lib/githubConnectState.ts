import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, deriveSubkeyForVersion } from '@auto-swe/shared/lib/crypto';
import { z } from 'zod';

const PURPOSE = 'auto-swe/github-org-connect/v1';
export const CONNECT_TTL_MS = 600_000;
const Claims = z.object({
  appId: z.string(),
  exp: z.number().int(),
  host: z.string(),
  kv: z.number().int(),
  nonce: z.string().min(1),
  orgId: z.string().uuid(),
  userId: z.string(),
});

export function signGithubConnectState(
  input: { userId: string; orgId: string; appId: string; host: string },
  now = Date.now()
) {
  const { key, version } = deriveSubkey(PURPOSE);
  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      exp: now + CONNECT_TTL_MS,
      kv: version,
      nonce: randomBytes(24).toString('base64url'),
    })
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

export function verifyGithubConnectState(state: string, now = Date.now()) {
  try {
    if (state.length > 4096) {
      return null;
    }
    const [payload, signature, extra] = state.split('.');
    if (!payload || !signature || extra !== undefined) {
      return null;
    }
    const claims = Claims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const key = deriveSubkeyForVersion(PURPOSE, claims.kv);
    if (!key) {
      return null;
    }
    const expected = createHmac('sha256', key).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      claims.exp <= now
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
