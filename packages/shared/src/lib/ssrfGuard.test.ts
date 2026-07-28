import { describe, expect, it } from 'vitest';
import { isSafeProbeUrl } from './ssrfGuard.js';

/** Convenience: assert a URL is refused, optionally checking the reason text. */
function expectBlocked(url: string, reasonMatch?: RegExp) {
  const res = isSafeProbeUrl(url);
  expect(res.ok, `expected ${url} to be blocked`).toBe(false);
  if (!res.ok && reasonMatch) {
    expect(res.reason).toMatch(reasonMatch);
  }
}

function expectAllowed(url: string) {
  const res = isSafeProbeUrl(url);
  expect(res.ok, `expected ${url} to be allowed`).toBe(true);
}

describe('isSafeProbeUrl', () => {
  describe('scheme', () => {
    it('allows http and https', () => {
      expectAllowed('http://example.com/');
      expectAllowed('https://example.com/api');
    });

    it('rejects non-http(s) schemes', () => {
      expectBlocked('file:///etc/passwd', /not allowed/);
      expectBlocked('ftp://example.com/', /not allowed/);
      expectBlocked('gopher://example.com/', /not allowed/);
    });

    it('rejects an unparseable URL', () => {
      expectBlocked('not a url', /invalid URL/);
    });
  });

  describe('loopback and internal names', () => {
    it('blocks localhost and the unspecified address', () => {
      expectBlocked('http://localhost:8080/', /internal/);
      expectBlocked('http://0.0.0.0/', /internal/);
    });

    it('blocks IPv6 loopback in bracketed and expanded forms', () => {
      expectBlocked('http://[::1]/', /internal/);
      // WHATWG normalises the expanded form back to ::1.
      expectBlocked('http://[0:0:0:0:0:0:0:1]/', /internal/);
      expectBlocked('http://[::]/', /internal/);
    });

    it('blocks .local and .internal suffixes', () => {
      expectBlocked('http://printer.local/', /internal/);
      expectBlocked('http://db.internal/', /internal/);
    });
  });

  describe('private IPv4 ranges', () => {
    it('blocks loopback, RFC1918 and link-local', () => {
      expectBlocked('http://127.0.0.1/', /private network/);
      expectBlocked('http://10.1.2.3/', /private network/);
      expectBlocked('http://192.168.1.5/', /private network/);
      expectBlocked('http://172.16.0.1/', /private network/);
      expectBlocked('http://172.31.255.254/', /private network/);
      expectBlocked('http://169.254.1.1/', /private network/);
    });

    it('blocks the cloud metadata address', () => {
      expectBlocked('http://169.254.169.254/latest/meta-data/', /private network/);
    });

    it('blocks 0.0.0.0/8 ("this network")', () => {
      expectBlocked('http://0.0.0.1/', /private network/);
    });

    it('does not over-block public addresses adjacent to private ranges', () => {
      expectAllowed('http://172.15.0.1/'); // just below the 172.16-31 block
      expectAllowed('http://172.32.0.1/'); // just above it
      expectAllowed('http://11.0.0.1/');
      expectAllowed('http://192.169.0.1/');
      expectAllowed('http://1.2.3.4/');
    });
  });

  describe('abbreviated / alternate-base IPv4', () => {
    // These are normalised to canonical dotted-quad by the WHATWG URL parser
    // before the guard inspects the hostname; the assertions pin that the
    // combination still refuses them however the normalisation is done.
    it('blocks short-form, octal, hex and bare-integer loopback', () => {
      expectBlocked('http://127.1/', /private network/);
      expectBlocked('http://0177.0.0.1/', /private network/);
      expectBlocked('http://0x7f.0.0.1/', /private network/);
      expectBlocked('http://0x7f000001/', /private network/);
      expectBlocked('http://2130706433/', /private network/);
    });

    it('blocks short-form RFC1918', () => {
      expectBlocked('http://10.1/', /private network/);
    });
  });

  describe('IPv6 unique-local (fc00::/7)', () => {
    // Regression: the guard previously matched only /^fc[0-9a-f]{2}:/, which
    // covers fc00::/8 but NOT fd00::/8 — and fd00::/8 is the half actually
    // used in practice (RFC 4193 sets the L bit for locally assigned ULAs),
    // so the common case slipped through.
    it('blocks the fd00::/8 half', () => {
      expectBlocked('http://[fd12:3456::1]/', /private network/);
      expectBlocked('http://[fd00::1]/', /private network/);
      expectBlocked('http://[fdff:ffff::1]/', /private network/);
    });

    it('blocks the fc00::/8 half', () => {
      expectBlocked('http://[fc00::1]/', /private network/);
      expectBlocked('http://[fc12::1]/', /private network/);
    });

    it('does not over-block neighbouring IPv6 prefixes', () => {
      expectAllowed('http://[fb00::1]/'); // just below fc00::/7
      expectAllowed('http://[2001:db8::1]/'); // documentation/global unicast
    });
  });

  describe('IPv6 link-local (fe80::/10)', () => {
    it('blocks the range', () => {
      expectBlocked('http://[fe80::1]/', /private network/);
      expectBlocked('http://[febf::1]/', /private network/);
    });

    it('does not over-block fec0:: (deprecated site-local, outside fe80::/10)', () => {
      expectAllowed('http://[fec0::1]/');
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('blocks a mapped loopback in both spellings', () => {
      // Node renders ::ffff:127.0.0.1 as ::ffff:7f00:1.
      expectBlocked('http://[::ffff:127.0.0.1]/', /private network/);
      expectBlocked('http://[::ffff:7f00:1]/', /private network/);
    });

    it('blocks a mapped RFC1918 address', () => {
      expectBlocked('http://[::ffff:192.168.1.1]/', /private network/);
    });

    it('allows a mapped public address', () => {
      expectAllowed('http://[::ffff:8.8.8.8]/');
    });
  });

  it('returns the parsed URL on success', () => {
    const res = isSafeProbeUrl('https://api.example.com/v1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.url.hostname).toBe('api.example.com');
    }
  });
});
