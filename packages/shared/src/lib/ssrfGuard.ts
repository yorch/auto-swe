/**
 * Shared SSRF guard for any gateway/worker code path that fetches an
 * operator-supplied URL (provider-credential `apiBase` probes, `mcp`
 * Connection URLs, bundle install-from-URL, issue-tracker / knowledge-base /
 * Figma connector base URLs, worker-side MCP server refs). Consolidates what
 * used to be several independently-maintained host blocklists
 * (`credentialService.ts`'s `isSafeProbeUrl` and `bundleFetch.ts`'s
 * `isBlockedHost`) into one definition so a fix here fixes every call site.
 *
 * We resolve at hostname-text level only (no DNS lookup) — the goal is
 * blocking the obvious accidents (loopback, RFC1918, link-local, cloud
 * metadata, IPv6-mapped IPv4), not stopping a determined attacker who can
 * register a public hostname pointing at internal IPs (DNS rebinding). For
 * that we'd need per-environment outbound-network policy at the OS/container
 * level.
 */

export type SafeProbeUrlResult = { ok: true; url: URL } | { ok: false; reason: string };

/// Detects IPv4-mapped IPv6 addresses and returns the embedded IPv4 in
/// dotted-quad. Accepts both human-friendly (`::ffff:127.0.0.1`) and the
/// Node-normalised hex form (`::ffff:7f00:1`). Returns null for anything
/// else so the caller can fall through to its normal IPv6 checks.
function extractIpv4FromMapped(host: string): string | null {
  const m1 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (m1) {
    return m1[1];
  }
  const m2 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (m2) {
    const hi = Number.parseInt(m2[1], 16);
    const lo = Number.parseInt(m2[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/// Rejects URLs that would let the gateway (or worker) be used as an SSRF
/// proxy: anything that isn't http(s), anything resolving to a loopback /
/// link-local / RFC1918 host — including the short-form IPv4 notations
/// (`127.1`, `10.1`, `0.0.0.1`) that a bare-octet regex would otherwise miss.
/// Exported so unit tests can exercise the guard directly. Internal API — not
/// stable.
export function isSafeProbeUrl(apiBase: string): SafeProbeUrlResult {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `protocol '${url.protocol}' not allowed` };
  }
  const rawHost = url.hostname.toLowerCase();
  // Node's URL parser keeps surrounding brackets on IPv6 hostnames
  // (e.g. `http://[::1]/` → hostname='[::1]'). Strip them so the string
  // / regex checks below match the bare address — otherwise `host === '::1'`
  // never triggers and an SSRF probe slips through to IPv6 loopback.
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  // Loopback / link-local / unspecified / IPv6 ::1 — text-level checks.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: `host '${host}' is internal` };
  }

  // Short-form IPv4 (`127.1`, `10.1`, `0.0.1`): browsers and Node's own
  // `net.isIP`-adjacent parsers accept 1-4 dotted decimal groups and expand
  // the missing octets to zero, so `127.1` resolves exactly like
  // `127.0.0.1`. The RFC1918/loopback regex below only matches the canonical
  // 4-octet form, so without this check a short-form literal would slip
  // through as an "invalid" (non-IPv4-looking) hostname string.
  const shortFormMatch = /^\d+(\.\d+){0,3}$/.exec(host);
  if (shortFormMatch) {
    const firstOctet = host.split('.', 1)[0];
    if (firstOctet === '0' || firstOctet === '10' || firstOctet === '127') {
      return { ok: false, reason: `host '${host}' is on a private network` };
    }
  }

  // IPv4-mapped IPv6: Node renders '::ffff:127.0.0.1' canonically as
  // '::ffff:7f00:1'. Pull the embedded IPv4 in either form so it gets
  // routed through the same private-network checks as a bare IPv4.
  const ipv4FromMapped = extractIpv4FromMapped(host);
  const effective = ipv4FromMapped ?? host;

  // RFC 1918 IPv4 + link-local + AWS metadata + IPv6 ULA + IPv6 link-local.
  if (
    /^127\./.test(effective) ||
    /^10\./.test(effective) ||
    /^192\.168\./.test(effective) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(effective) ||
    /^169\.254\./.test(effective) ||
    /^fc[0-9a-f]{2}:/.test(effective) ||
    /^fe[89ab][0-9a-f]:/.test(effective)
  ) {
    return { ok: false, reason: `host '${host}' is on a private network` };
  }
  return { ok: true, url };
}
