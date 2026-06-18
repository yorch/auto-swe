import type { TrustedKey } from '@auto-swe/shared/bundle';

/**
 * Deployment trust anchors for bundle signatures (P4/WS3).
 *
 * Sourced from the `BUNDLE_TRUSTED_KEYS` env var (JSON `[{ id, publicKeyPem }]`)
 * — deliberately env, not DB: a trust anchor must not be mutable by anyone with
 * DB write access (that would let them mark a malicious bundle VERIFIED). Same
 * rationale as `CONFIG_ENCRYPTION_KEY`. Absent/malformed → no trusted keys, so
 * every bundle installs as UNVERIFIED (still allowed; just flagged community).
 */
export function resolveBundleTrustedKeys(): TrustedKey[] {
  const raw = process.env.BUNDLE_TRUSTED_KEYS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (k): k is TrustedKey => !!k && typeof k.id === 'string' && typeof k.publicKeyPem === 'string'
    );
  } catch {
    return [];
  }
}
