import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicBundleUrl, fetchBundleJson } from './bundleFetch.js';

describe('assertPublicBundleUrl', () => {
  it('blocks loopback, link-local/metadata, and private hosts', () => {
    for (const url of [
      'http://localhost/x.json',
      'http://127.0.0.1/x.json',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x.json',
      'http://172.16.4.4/x.json',
      'http://192.168.1.1/x.json',
      'http://[::1]/x.json',
    ]) {
      expect(() => assertPublicBundleUrl(url), url).toThrow(/private\/loopback/);
    }
  });

  it('blocks short-form IPv4 literals (127.1, 10.1, 0.1)', () => {
    for (const url of ['http://127.1/x.json', 'http://10.1/x.json', 'http://0.1/x.json']) {
      expect(() => assertPublicBundleUrl(url), url).toThrow(/private\/loopback/);
    }
  });

  it('allows a public host', () => {
    expect(() =>
      assertPublicBundleUrl('https://registry.example.com/swe.bundle.json')
    ).not.toThrow();
  });
});

describe('fetchBundleJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string) => Promise<Response> | Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => handler(url))
    );
  }

  function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      headers: { 'content-length': String(JSON.stringify(body).length) },
      status: 200,
      ...init,
    });
  }

  it('fetches and parses JSON from a public URL', async () => {
    stubFetch(() => jsonResponse({ hello: 'world' }));
    const result = await fetchBundleJson('https://registry.example.com/swe.bundle.json');
    expect(result).toEqual({ hello: 'world' });
  });

  it('rejects when Content-Length exceeds the byte cap', async () => {
    stubFetch(
      () =>
        new Response('{}', {
          headers: { 'content-length': '999999999' },
          status: 200,
        })
    );
    await expect(
      fetchBundleJson('https://registry.example.com/swe.bundle.json', 10)
    ).rejects.toThrow(/exceeds the 10-byte limit/);
  });

  it('rejects when the buffered body exceeds the byte cap (no honest Content-Length)', async () => {
    stubFetch(() => new Response('x'.repeat(100), { status: 200 }));
    await expect(
      fetchBundleJson('https://registry.example.com/swe.bundle.json', 10)
    ).rejects.toThrow(/exceeds the 10-byte limit/);
  });

  it('rejects a non-ok response', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(fetchBundleJson('https://registry.example.com/swe.bundle.json')).rejects.toThrow(
      /HTTP 500/
    );
  });

  it('follows a same-host redirect and re-validates the target', async () => {
    let calls = 0;
    stubFetch((url) => {
      calls++;
      if (url === 'https://registry.example.com/first') {
        return new Response(null, {
          headers: { location: 'https://registry.example.com/second' },
          status: 302,
        });
      }
      return jsonResponse({ ok: true });
    });
    const result = await fetchBundleJson('https://registry.example.com/first');
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('rejects a redirect to a private/loopback address', async () => {
    stubFetch(
      () =>
        new Response(null, {
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          status: 302,
        })
    );
    await expect(fetchBundleJson('https://registry.example.com/first')).rejects.toThrow(
      /private\/loopback/
    );
  });

  it('rejects a redirect chain exceeding the hop cap', async () => {
    let hop = 0;
    stubFetch(() => {
      hop++;
      return new Response(null, {
        headers: { location: `https://registry.example.com/hop-${hop}` },
        status: 302,
      });
    });
    await expect(fetchBundleJson('https://registry.example.com/first')).rejects.toThrow(
      /exceeded 5 redirects/
    );
  });

  it('rejects a redirect response missing a Location header', async () => {
    stubFetch(() => new Response(null, { status: 302 }));
    await expect(fetchBundleJson('https://registry.example.com/first')).rejects.toThrow(
      /missing Location header/
    );
  });
});
