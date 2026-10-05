import { isIP } from 'node:net';

/**
 * Shared SSRF guard for any gateway/worker code path that fetches an
 * operator-supplied URL (provider-credential `apiBase` probes, `mcp`
 * Connection URLs, bundle install-from-URL, issue-tracker / knowledge-base /
 * Figma connector base URLs, worker-side MCP server refs). Consolidates what
 * used to be several independently-maintained host blocklists into one
 * definition so a fix here fixes every call site.
 *
 * This module reads the URL's host TEXT: it is the early, cheap refusal for
 * save-time validation and fast errors, and it is the single source of the
 * address classification (loopback, link-local, metadata, private, reserved).
 * It cannot see what a NAME resolves to — a public hostname pointing at
 * `10.x` (`10.1.1.17.nip.io`, a DNS-rebinding name) passes it. That half lives
 * in `guardedDispatcher.ts`, which resolves the name at connection time,
 * classifies every resolved address with `checkProbeUrl` below, and pins the
 * connection to the checked set. A call site that sends a request needs both.
 */

export type SafeProbeUrlResult =
  | { ok: true; url: URL }
  /** `private: true` marks a refusal for a private/internal address, the only kind an opt-in may waive. */
  | { ok: false; reason: string; private?: true };

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

/**
 * Addresses no connector may reach and no opt-in waives: multicast and
 * reserved IPv4 (224.0.0.0/3), the IETF protocol block (192.0.0.0/24, which
 * holds OCI's legacy metadata address 192.0.0.192), benchmarking
 * (198.18.0.0/15), the documentation ranges (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24), the retired 6to4 relay anycast (192.88.99.0/24), and for
 * IPv6 the discard prefix (100::/64), documentation (2001:db8::/32) and Teredo
 * (2001::/32, which embeds an IPv4 address, so the whole block is refused).
 * `effective` is a bare host with any embedded IPv4 already unwrapped; a
 * hostname that merely begins with digits is not an address and is not matched.
 */
export function isReservedAddress(effective: string): boolean {
  const family = isIP(effective);
  if (family === 4) {
    const [a, b, c] = effective.split('.').map(Number);
    return (
      a >= 224 ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 88 && c === 99)
    );
  }
  if (family === 6) {
    return (
      /^ff[0-9a-f]{2}:/.test(effective) ||
      /^100:(:|0:0:0:)/.test(effective) ||
      /^2001:(db8:|:|0:)/.test(effective)
    );
  }
  return false;
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

  // The bare single-label metadata name is never a legitimate target and is
  // never waivable (no `private` flag).
  if (host === 'metadata') {
    return { ok: false, reason: `host '${host}' is a metadata endpoint` };
  }

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
    return { ok: false, private: true, reason: `host '${host}' is internal` };
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
      return { ok: false, private: true, reason: `host '${host}' is on a private network` };
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
    return { ok: false, private: true, reason: `host '${host}' is on a private network` };
  }
  if (isReservedAddress(effective)) {
    // No `private` flag: an opt-in never waives a reserved range.
    return { ok: false, reason: `host '${host}' is a reserved address` };
  }
  return { ok: true, url };
}

type NeverAllowedKind = 'link-local' | 'loopback' | 'unspecified';

/**
 * Addresses no opt-in may reach: cloud metadata endpoints (link-local
 * 169.254.0.0/16 — AWS/Azure/GCP/Oracle — and IPv6 link-local fe80::/10, plus AWS's IPv6 `fd00:ec2::254`,
 * GCP's IPv6 `fd20:ce::254`, OCI's legacy 192.0.0.192, Alibaba's 100.100.100.200 and the GCP metadata names) and loopback /
 * unspecified addresses, which are the platform's own services. A private
 * network opt-in is for a self-hosted server on an internal address, never for
 * these.
 */
function neverAllowedKind(url: URL): { effective: string; kind: NeverAllowedKind } | null {
  const raw = url.hostname.toLowerCase();
  const bare = (raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw).replace(
    /\.+$/,
    ''
  );
  const effective = extractEmbeddedIpv4(bare) ?? bare;
  if (
    effective === 'metadata' ||
    effective === 'metadata.google.internal' ||
    effective === '100.100.100.200' ||
    effective.startsWith('fd00:ec2:') ||
    effective.startsWith('fd20:ce:') ||
    effective === '192.0.0.192' ||
    /^169\.254\./.test(effective) ||
    /^fe[89ab][0-9a-f]:/.test(effective)
  ) {
    return { effective, kind: 'link-local' };
  }
  if (effective === '::' || /^0\./.test(effective)) {
    return { effective, kind: 'unspecified' };
  }
  if (
    effective === 'localhost' ||
    effective.endsWith('.localhost') ||
    effective === '::1' ||
    /^127\./.test(effective)
  ) {
    return { effective, kind: 'loopback' };
  }
  return null;
}

/**
 * {@link isSafeProbeUrl}, with a per-host operator opt-in for private
 * addresses (the shape of the connectors' `allowPrivateNetwork`). With
 * `allowPrivate`, a refusal for a private/internal address is waived — but
 * never for the addresses {@link neverAllowedKind} names, and never for any
 * other refusal (a bad URL, a non-http scheme). The caller decides which exact
 * host `allowPrivate` applies to.
 */
export function checkProbeUrl(apiBase: string, opts: { allowPrivate?: boolean } = {}) {
  const safety = isSafeProbeUrl(apiBase);
  if (safety.ok || !safety.private) {
    return safety;
  }
  const url = new URL(apiBase);
  const never = neverAllowedKind(url);
  if (never) {
    // Say so rather than "on a private network", which invites the opt-in that cannot help.
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    const kind = {
      'link-local': 'a link-local or cloud metadata address',
      loopback: 'a loopback address',
      unspecified: 'an unspecified address',
    }[never.kind];
    return { ...safety, reason: `host '${host}' is ${kind} and is never allowed` };
  }
  return opts.allowPrivate ? ({ ok: true, url } as const) : safety;
}

/**
 * The guard a connector runs on its operator-supplied base URL: strict first,
 * then the connector's `allowPrivateNetwork` opt-in, which waives only the
 * private-address refusal. `waivedReason` is set when the opt-in was what let
 * the URL through, so the caller can log it. The connector registry and the
 * admin Jira field detection use this. The worker's Jira connection check
 * (a deliberately narrower, same-origin opt-in) and the save-time check call
 * `checkProbeUrl` directly.
 */
export function checkConnectorBaseUrl(
  baseUrl: string,
  allowPrivate: boolean
): { ok: true; waivedReason: string | null } | { ok: false; reason: string } {
  const strict = checkProbeUrl(baseUrl);
  if (strict.ok) {
    return { ok: true, waivedReason: null };
  }
  const safety = checkProbeUrl(baseUrl, { allowPrivate });
  return safety.ok
    ? { ok: true, waivedReason: strict.reason }
    : { ok: false, reason: safety.reason };
}
