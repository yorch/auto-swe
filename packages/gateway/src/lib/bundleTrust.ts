import type { TrustedKey } from '@auto-swe/shared/bundle';

/**
 * Deployment trust anchors for bundle signatures (P4/WS3).
 *
 * Sourced from the `BUNDLE_TRUSTED_KEYS` env var (JSON `[{ id, publicKeyPem }]`).
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
  // Malformed config fails safe (no trusted keys), but loudly: otherwise an
  // operator's typo silently marks every signed bundle UNVERIFIED.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[bundles] BUNDLE_TRUSTED_KEYS is not valid JSON; no bundle key is trusted');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[bundles] BUNDLE_TRUSTED_KEYS is not a JSON array; no bundle key is trusted');
    return [];
  }
  const keys = parsed.filter(
    (k): k is TrustedKey => !!k && typeof k.id === 'string' && typeof k.publicKeyPem === 'string'
  );
  if (keys.length !== parsed.length) {
    const skipped = parsed.length - keys.length;
    console.warn(`[bundles] BUNDLE_TRUSTED_KEYS: ignored ${skipped} malformed entries`);
  }
  return keys;
}

/** Whether to allow UNVERIFIED bundles to install. Default is deny. */
export function resolveBundleAllowUnverified(): boolean {
  return process.env.BUNDLE_ALLOW_UNVERIFIED === '1';
}
