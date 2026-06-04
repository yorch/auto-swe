import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Ensure CONFIG_ENCRYPTION_KEY is set before modelConfig.ts is imported —
// the module loads crypto lazily but tests are noisy when it isn't set.
process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { isSafeProbeUrl } from './modelConfig.js';

/// SSRF guards on the `POST /credentials/:id/test` probe endpoint. The
/// resolver narrows the URL to its hostname, strips IPv6 brackets, and
/// reroutes IPv4-mapped IPv6 through the IPv4 path before checking against
/// the private-network blocklist.
describe('isSafeProbeUrl', () => {
  function assertBlocked(apiBase: string, reasonMatch: RegExp) {
    const r = isSafeProbeUrl(apiBase);
    expect(r.ok, `expected '${apiBase}' to be blocked`).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(reasonMatch);
    }
  }

  function assertAllowed(apiBase: string) {
    const r = isSafeProbeUrl(apiBase);
    expect(r.ok, `expected '${apiBase}' to be allowed`).toBe(true);
  }

  it('blocks IPv4 loopback / RFC1918 / link-local / AWS metadata', () => {
    assertBlocked('http://127.0.0.1/v1', /private network/);
    assertBlocked('http://10.0.0.1/v1', /private network/);
    assertBlocked('http://10.255.255.255/v1', /private network/);
    assertBlocked('http://192.168.1.1/v1', /private network/);
    assertBlocked('http://172.16.0.1/v1', /private network/);
    assertBlocked('http://172.31.0.1/v1', /private network/);
    assertBlocked('http://169.254.169.254/v1', /private network/); // AWS metadata
    assertBlocked('http://localhost/v1', /internal/);
    assertBlocked('http://0.0.0.0/v1', /internal/);
  });

  it('blocks .local and .internal hostnames', () => {
    assertBlocked('http://api.local/v1', /internal/);
    assertBlocked('http://svc.internal/v1', /internal/);
  });

  it('blocks IPv6 loopback in bracketed form (the original CVE)', () => {
    assertBlocked('http://[::1]/v1', /internal/);
    assertBlocked('http://[::1]:8080/v1', /internal/);
    assertBlocked('http://[::]/v1', /internal/);
  });

  it('blocks IPv6 ULA (fc00::/7) and link-local (fe80::/10)', () => {
    assertBlocked('http://[fc00::1]/v1', /private network/);
    assertBlocked('http://[fcde::abcd]/v1', /private network/);
    assertBlocked('http://[fe80::1]/v1', /private network/);
    assertBlocked('http://[feb0::1]/v1', /private network/);
  });

  it('blocks IPv4-mapped IPv6 hitting RFC1918 / loopback', () => {
    // Human-friendly form, before Node normalization.
    assertBlocked('http://[::ffff:127.0.0.1]/v1', /private network/);
    // Node-normalised hex form (this is what URL.hostname returns).
    assertBlocked('http://[::ffff:7f00:1]/v1', /private network/);
    assertBlocked('http://[::ffff:10.0.0.1]/v1', /private network/);
    assertBlocked('http://[::ffff:0a00:1]/v1', /private network/);
    assertBlocked('http://[::ffff:192.168.1.1]/v1', /private network/);
    assertBlocked('http://[::ffff:c0a8:101]/v1', /private network/);
    assertBlocked('http://[::ffff:169.254.169.254]/v1', /private network/); // AWS metadata via v6
  });

  it('rejects non-http(s) schemes', () => {
    assertBlocked('file:///etc/passwd', /protocol/);
    assertBlocked('gopher://api.example.com/foo', /protocol/);
    assertBlocked('javascript:alert(1)', /protocol/);
  });

  it('rejects malformed URLs', () => {
    assertBlocked('not a url', /invalid URL/);
    assertBlocked('://missing-scheme', /invalid URL/);
  });

  it('allows public hosts', () => {
    assertAllowed('https://api.anthropic.com/v1');
    assertAllowed('https://api.openai.com/v1');
    assertAllowed('https://opencode.ai/zen/go/v1');
    assertAllowed('http://api.example.com:8080/v1');
    // Public IPv4 (Google DNS) — not in any private range.
    assertAllowed('https://8.8.8.8/v1');
    // Public IPv6 (Cloudflare DNS).
    assertAllowed('https://[2606:4700:4700::1111]/v1');
  });
});
