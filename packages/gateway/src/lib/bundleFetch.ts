/**
 * Safe fetch for install-from-URL (P4/WS3). The endpoint is admin-only, but a
 * server-side fetch of an admin-supplied URL is still an SSRF vector, so we
 * block private/loopback/link-local/metadata hosts and cap the response size.
 *
 * Note: this blocks IP *literals* and `localhost`; a hostname that resolves to a
 * private IP (DNS rebinding) is not caught here — full protection would resolve
 * the host and re-check the address. Adequate as a first guard for an
 * ADMIN-gated route; tighten if this is ever exposed more broadly.
 */
const DEFAULT_MAX_BYTES = 5_000_000;

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') {
    return true;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) {
      return true; // this-host / loopback / private
    }
    if (a === 169 && b === 254) {
      return true; // link-local (incl. cloud metadata 169.254.169.254)
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true; // private
    }
    if (a === 192 && b === 168) {
      return true; // private
    }
  }
  // IPv6 loopback / link-local / unique-local
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  return false;
}

/** Throws if the URL targets a private/loopback/link-local/metadata host. */
export function assertPublicBundleUrl(rawUrl: string): void {
  const u = new URL(rawUrl);
  if (isBlockedHost(u.hostname)) {
    throw new Error(`refusing to fetch a bundle from a private/loopback address: ${u.hostname}`);
  }
}

/**
 * Fetch + JSON-parse a bundle from a URL with an SSRF host guard and a size cap
 * (rejects via Content-Length and the buffered body length). Throws on any
 * failure; the caller maps that to a 400.
 */
export async function fetchBundleJson(url: string, maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> {
  assertPublicBundleUrl(url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url}: HTTP ${res.status}`);
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
