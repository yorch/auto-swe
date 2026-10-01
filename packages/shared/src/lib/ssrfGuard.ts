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

function hexPairToIpv4(hiHex: string, loHex: string): string | null {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    return null;
  }
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * IPv6 forms that carry an IPv4 address the network stack (or a NAT64 / 6to4
 * gateway) will deliver to: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated
 * (`::ffff:0:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), the NAT64 well-known
 * prefix (`64:ff9b::a.b.c.d`, RFC 6052) and 6to4 (`2002:AABB:CCDD::`).
 * Each prefix accepts both the dotted tail and the Node-normalised hex tail.
 */
const EMBEDDED_IPV4_PREFIXES: readonly RegExp[] = [/^::ffff:/, /^::ffff:0:/, /^::/, /^64:ff9b::/];

/// Returns the IPv4 address embedded in an IPv6 literal (see
/// EMBEDDED_IPV4_PREFIXES), in dotted-quad, or null when there is none so the
/// caller falls through to its normal IPv6 checks.
function extractEmbeddedIpv4(host: string): string | null {
  for (const prefix of EMBEDDED_IPV4_PREFIXES) {
    const m = prefix.exec(host);
    if (!m) {
      continue;
    }
    const tail = host.slice(m[0].length);
    const dotted = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(tail);
    if (dotted) {
      return dotted[1];
    }
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      return hexPairToIpv4(hex[1], hex[2]);
    }
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/.exec(host);
  if (sixToFour) {
    return hexPairToIpv4(sixToFour[1], sixToFour[2]);
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
  const bracketless =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  // A fully-qualified name may end in a dot (`localhost.`,
  // `metadata.google.internal.`) and resolves exactly like the bare name, so
  // strip it before any suffix comparison.
  const host = bracketless.replace(/\.+$/, '');

  // Loopback / link-local / unspecified / IPv6 ::1 — text-level checks.
  if (
    host === '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host === 'local' ||
    host.endsWith('.local') ||
    host === 'internal' ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: `host '${host}' is internal` };
  }

  // Abbreviated / alternate-base IPv4 (`127.1`, `0177.0.0.1`, `0x7f000001`,
  // `2130706433`). For http(s) — "special" schemes — the WHATWG URL parser
  // already normalises all of these into canonical dotted-quad before we read
  // `url.hostname`, so the range checks below catch them on their own. This
  // branch is therefore belt-and-braces against a parser that ever stops
  // normalising; it also uniquely covers 0.0.0.0/8 ("this network", which
  // several stacks route to localhost) which no regex below matches.
  const shortFormMatch = /^\d+(\.\d+){0,3}$/.exec(host);
  if (shortFormMatch) {
    const firstOctet = host.split('.', 1)[0];
    if (firstOctet === '0' || firstOctet === '10' || firstOctet === '127') {
      return { ok: false, reason: `host '${host}' is on a private network` };
    }
  }

  // IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4):
  // Node renders '::ffff:127.0.0.1' canonically as '::ffff:7f00:1'. Pull the
  // embedded IPv4 in either form so it gets routed through the same
  // private-network checks as a bare IPv4.
  const embeddedIpv4 = extractEmbeddedIpv4(host);
  const effective = embeddedIpv4 ?? host;

  // RFC 1918 IPv4 + link-local + AWS metadata + IPv6 ULA + IPv6 link-local.
  if (
    /^127\./.test(effective) ||
    /^10\./.test(effective) ||
    /^192\.168\./.test(effective) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(effective) ||
    /^169\.254\./.test(effective) ||
    // 0.0.0.0/8 "this network" in any spelling that reached dotted-quad.
    /^0\./.test(effective) ||
    // RFC 6598 carrier-grade NAT, 100.64.0.0/10 — includes Alibaba Cloud's
    // metadata endpoint 100.100.100.200.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(effective) ||
    // NAT64 local-use prefix (RFC 8215), 64:ff9b:1::/48: translated by a
    // site-local gateway, so its target cannot be read from the address.
    /^64:ff9b:1:/.test(effective) ||
    // Deprecated IPv6 site-local, fec0::/10 — still routed internally by some
    // stacks.
    /^fe[c-f][0-9a-f]:/.test(effective) ||
    // IPv6 unique-local is fc00::/7 — BOTH the fc00::/8 and fd00::/8 halves.
    // In practice ULAs are fd00::/8 (RFC 4193 sets the L bit for locally
    // assigned prefixes), so matching only `fc` let the common case through.
    /^f[cd][0-9a-f]{2}:/.test(effective) ||
    /^fe[89ab][0-9a-f]:/.test(effective)
  ) {
    return { ok: false, reason: `host '${host}' is on a private network` };
  }
  return { ok: true, url };
}
