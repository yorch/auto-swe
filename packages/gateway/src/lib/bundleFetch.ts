import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';

/**
 * Safe fetch for install-from-URL (P4/WS3). The endpoint is admin-only, but a
 * server-side fetch of an admin-supplied URL is still an SSRF vector, so we
 * block private/loopback/link-local/metadata hosts (via the shared
 * `isSafeProbeUrl` guard — the same one used for provider-credential
 * `apiBase` probes and `mcp` Connection URLs) and cap the response size.
 *
 * Redirects are followed manually (capped at `MAX_REDIRECTS` hops) so each hop
 * re-runs the SSRF guard — a transparent `fetch(url)` would let a public URL
 * 302 to an internal address and slip the guard entirely.
 *
 * Note: this blocks IP *literals* and `localhost`; a hostname that resolves to a
 * private IP (DNS rebinding) is not caught here — full protection would resolve
 * the host and re-check the address. Adequate as a first guard for an
 * ADMIN-gated route; tighten if this is ever exposed more broadly.
 */
const DEFAULT_MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

/** Throws if the URL isn't http(s) or targets a private/loopback/link-local/
 *  metadata host. */
export function assertPublicBundleUrl(rawUrl: string): void {
  const safety = isSafeProbeUrl(rawUrl);
  if (!safety.ok) {
    throw new Error(
      `refusing to fetch a bundle from a private/loopback address: ${rawUrl} (${safety.reason})`
    );
  }
}

/**
 * Fetch + JSON-parse a bundle from a URL with an SSRF host guard and a size cap
 * (rejects via Content-Length and the buffered body length). Redirects are
 * followed manually, capped at `MAX_REDIRECTS` hops, with the SSRF guard
 * re-checked against each `Location` before it's followed. Throws on any
 * failure; the caller maps that to a 400.
 */
export async function fetchBundleJson(url: string, maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> {
  let current = url;
  for (let hop = 0; ; hop++) {
    assertPublicBundleUrl(current);
    const res = await fetch(current, { redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`fetch ${url}: exceeded ${MAX_REDIRECTS} redirects`);
      }
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`fetch ${current}: redirect ${res.status} missing Location header`);
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`fetch ${current}: HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new Error(`bundle exceeds the ${maxBytes}-byte limit`);
    }
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new Error(`bundle exceeds the ${maxBytes}-byte limit`);
    }
    return JSON.parse(text);
  }
}
