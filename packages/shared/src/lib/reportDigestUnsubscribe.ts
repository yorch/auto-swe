import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveSubkey, deriveSubkeyForVersion } from './crypto.js';

const KEY_INFO = 'auto-swe/report-digest-unsubscribe/v1';

interface ParsedToken {
  keyVersion: number;
  signature: Buffer;
  subscriptionId: string;
}

function parseToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0] ?? '')
  ) {
    return null;
  }
  const keyVersion = Number(parts[1]);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    return null;
  }
  const signature = Buffer.from(parts[2] ?? '', 'base64url');
  if (signature.length !== 32) {
    return null;
  }
  return { keyVersion, signature, subscriptionId: parts[0] as string };
}

function signatureFor(key: Buffer, subscriptionId: string, email: string): Buffer {
  return createHmac('sha256', key)
    .update(`${subscriptionId}\n${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

export function createReportDigestUnsubscribeToken(subscriptionId: string, email: string): string {
  const { key, version } = deriveSubkey(KEY_INFO);
  const signature = signatureFor(key, subscriptionId, email).toString('base64url');
  return `${subscriptionId}.${version}.${signature}`;
}

export function verifyReportDigestUnsubscribeToken(
  token: string,
  subscriptionId: string,
  email: string
): boolean {
  const parsed = parseToken(token);
  if (!parsed || parsed.subscriptionId !== subscriptionId) {
    return false;
  }
  const key = deriveSubkeyForVersion(KEY_INFO, parsed.keyVersion);
  if (!key) {
    return false;
  }
  const expected = signatureFor(key, subscriptionId, email);
  return timingSafeEqual(parsed.signature, expected);
}

export function reportDigestUnsubscribeSubscriptionId(token: string): string | null {
  return parseToken(token)?.subscriptionId ?? null;
}
