import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const guardOpts = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('@auto-swe/shared/lib/guardedDispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/guardedDispatcher')>()),
  createGuardedFetch: (opts: unknown) => {
    guardOpts.calls.push(opts);
    return fetchMock;
  },
}));

import { SsrfBlockedError } from '@auto-swe/shared/lib/guardedDispatcher';
import { httpApiRequest, MAX_RESPONSE_BYTES, sanitizedCause } from './httpApi.js';

const TOKEN = 'sekret-token-123';
const base = { baseUrl: 'https://api.example.com/v1' };
const conn = (config: Record<string, unknown> = {}, apiToken: string | null = TOKEN) => ({
  apiToken,
  config: { ...base, ...config } as never,
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

function sentHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers;
}

describe('httpApiRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    guardOpts.calls.length = 0;
    fetchMock.mockImplementation(async () => json({ ok: true }));
  });

  describe('path confinement', () => {
    it('resolves below the base path and keeps the origin', async () => {
      await httpApiRequest(conn(), { method: 'GET', path: '/items/1', query: { a: 1, b: 'x y' } });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/items/1?a=1&b=x+y');
    });

    it('treats a URL-looking path as a plain path under the prefix', async () => {
      await httpApiRequest(conn(), { method: 'GET', path: '/https://evil.example' });
      expect(new URL(fetchMock.mock.calls[0][0]).origin).toBe('https://api.example.com');
    });

    it('works with no base path', async () => {
      await httpApiRequest(conn({ baseUrl: 'https://api.example.com' }), {
        method: 'GET',
        path: '/x',
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/x');
    });

    it.each([
      ['relative path', 'items'],
      ['empty path', ''],
      ['dot dot', '/../v2/secret'],
      ['inner dot dot', '/a/../../x'],
      ['dot segment', '/a/./b'],
      ['trailing dot dot', '/a/..'],
      ['absolute url', 'https://evil.example/x'],
      ['protocol relative', '//evil.example/x'],
      ['backslash', '/a\\..\\b'],
      ['leading backslash', '\\\\evil.example'],
      ['encoded dot dot', '/%2e%2e/secret'],
      ['mixed-case encoded dots', '/.%2E/secret'],
      ['encoded slash', '/a%2fb'],
      ['encoded backslash', '/a%5Cb'],
      ['encoded nul', '/a%00b'],
      ['encoded newline', '/a%0d%0aHost:x'],
      ['semicolon path parameter', '/..;/admin'],
      ['double-encoded dots', '/%252e%252e/admin'],
      ['query in path', '/a?x=1'],
      ['fragment in path', '/a#x'],
      ['space', '/a b'],
      ['newline', '/a\nb'],
      ['tab', '/a\tb'],
      ['too long', `/${'a'.repeat(3000)}`],
    ])('refuses %s before sending', async (_n, path) => {
      await expect(httpApiRequest(conn(), { method: 'GET', path })).rejects.toMatchObject({
        type: 'NOT_SENT',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses too many query parameters and non-scalar values', async () => {
      const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1]));
      await expect(
        httpApiRequest(conn(), { method: 'GET', path: '/a', query: many })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      await expect(
        httpApiRequest(conn(), { method: 'GET', path: '/a', query: { a: {} as never } })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('config and method', () => {
    it('refuses an invalid stored config', async () => {
      await expect(
        httpApiRequest(conn({ baseUrl: 'http://api.example.com' }), { method: 'GET', path: '/a' })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      await expect(
        httpApiRequest({ apiToken: TOKEN, config: {} as never }, { method: 'GET', path: '/a' })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an unsupported method and a body on GET or DELETE', async () => {
      await expect(
        httpApiRequest(conn(), { method: 'TRACE' as never, path: '/a' })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      for (const method of ['GET', 'DELETE'] as const) {
        await expect(
          httpApiRequest(conn(), { body: { a: 1 }, method, path: '/a' })
        ).rejects.toMatchObject({ type: 'NOT_SENT' });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('headers', () => {
    it.each([
      'Authorization',
      'cookie',
      'Proxy-Authorization',
      'proxy-x',
      'Host',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'X-Key',
      'X-Original-URL',
      'x-rewrite-url',
      'X-HTTP-Method-Override',
      'X-HTTP-Method',
      'X-Method-Override',
      'Forwarded',
      'X-Forwarded-Host',
      'X-Forwarded-For',
      'X-Real-IP',
    ])('refuses the per-request header %s', async (name) => {
      await expect(
        httpApiRequest(conn({ authHeaderName: 'x-key', authType: 'header' }), {
          headers: { [name]: 'v' },
          method: 'GET',
          path: '/a',
        })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses bad names, bad values and too many headers', async () => {
      for (const headers of [
        { 'bad name': 'v' },
        { 'X-A': 'a\r\nb: c' },
        { 'X-A': 'x'.repeat(3000) },
        Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-${i}`, 'v'])),
      ]) {
        await expect(
          httpApiRequest(conn(), { headers, method: 'GET', path: '/a' })
        ).rejects.toMatchObject({ type: 'NOT_SENT' });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('merges default headers under per-request headers', async () => {
      await httpApiRequest(conn({ defaultHeaders: { 'X-Env': 'prod', 'X-Team': 'a' } }), {
        headers: { 'x-env': 'staging' },
        method: 'GET',
        path: '/a',
      });
      expect(sentHeaders()).toMatchObject({ 'x-env': 'staging', 'x-team': 'a' });
    });
  });

  describe('auth', () => {
    it('defaults to bearer', async () => {
      await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(sentHeaders().authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('sends the token in a named header', async () => {
      await httpApiRequest(conn({ authHeaderName: 'X-Api-Key', authType: 'header' }), {
        method: 'GET',
        path: '/a',
      });
      expect(sentHeaders()['x-api-key']).toBe(TOKEN);
      expect(sentHeaders().authorization).toBeUndefined();
    });

    it('sends basic auth with the token as the password', async () => {
      await httpApiRequest(conn({ authType: 'basic', basicUsername: 'svc' }), {
        method: 'GET',
        path: '/a',
      });
      expect(sentHeaders().authorization).toBe(
        `Basic ${Buffer.from(`svc:${TOKEN}`).toString('base64')}`
      );
    });

    it('sends no credential for none, even when a token is stored', async () => {
      await httpApiRequest(conn({ authType: 'none' }), { method: 'GET', path: '/a' });
      expect(JSON.stringify(sentHeaders())).not.toContain(TOKEN);
      expect(sentHeaders().authorization).toBeUndefined();
    });

    it.each(['bearer', 'basic'])('refuses %s with no token', async (authType) => {
      await expect(
        httpApiRequest(conn({ authType }, null), { method: 'GET', path: '/a' })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('transport and body', () => {
    it('uses the strict guarded fetch and refuses redirects', async () => {
      await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(guardOpts.calls).toEqual([{ allowPrivate: false }]);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('honours the caller signal', async () => {
      const controller = new AbortController();
      await httpApiRequest(conn(), { method: 'GET', path: '/a' }, { signal: controller.signal });
      controller.abort();
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('JSON-encodes objects and sends strings as text', async () => {
      await httpApiRequest(conn(), { body: { a: 1 }, method: 'POST', path: '/a' });
      expect(fetchMock.mock.calls[0][1].body).toBe('{"a":1}');
      expect(sentHeaders()['content-type']).toBe('application/json');

      fetchMock.mockClear();
      await httpApiRequest(conn(), { body: 'hello', method: 'PUT', path: '/a' });
      expect(fetchMock.mock.calls[0][1].body).toBe('hello');
      expect(sentHeaders()['content-type']).toMatch(/^text\/plain/);

      fetchMock.mockClear();
      await httpApiRequest(conn(), {
        body: 'a=b',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
        path: '/a',
      });
      expect(sentHeaders()['content-type']).toBe('application/x-www-form-urlencoded');
    });
  });

  describe('response', () => {
    it('parses JSON and returns only safe headers', async () => {
      fetchMock.mockResolvedValue(
        json({ a: 1 }, 200, { 'set-cookie': 's=1', 'x-request-id': 'r1', 'x-secret': 'q' })
      );
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res).toEqual({
        body: { a: 1 },
        headers: { 'content-type': 'application/json', 'x-request-id': 'r1' },
        status: 200,
      });
    });

    it('returns text for a non-JSON type and null for an empty body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('plain', { headers: { 'content-type': 'text/plain' } })
      );
      expect((await httpApiRequest(conn(), { method: 'GET', path: '/a' })).body).toBe('plain');
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect((await httpApiRequest(conn(), { method: 'DELETE', path: '/a' })).body).toBeNull();
    });

    it('caps the body, marks it truncated and does not parse it', async () => {
      const big = `{"a":"${'x'.repeat(MAX_RESPONSE_BYTES + 100)}"}`;
      fetchMock.mockResolvedValue(
        new Response(big, { headers: { 'content-type': 'application/json' } })
      );
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res.truncated).toBe(true);
      expect(typeof res.body).toBe('string');
      expect(Buffer.byteLength(res.body as string)).toBe(MAX_RESPONSE_BYTES);
    });

    it('does not flag a body that fits exactly', async () => {
      fetchMock.mockResolvedValue(
        new Response('x'.repeat(MAX_RESPONSE_BYTES), { headers: { 'content-type': 'text/plain' } })
      );
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res.truncated).toBeUndefined();
    });

    it('returns no body for a binary type, only its type and length', async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), {
          headers: { 'content-length': '4', 'content-type': 'application/octet-stream' },
        })
      );
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res).toEqual({
        body: null,
        bodyOmitted: 'binary',
        headers: { 'content-length': '4', 'content-type': 'application/octet-stream' },
        status: 200,
      });
    });

    it('keeps a serialised result under the cap even for control-heavy text', async () => {
      fetchMock.mockResolvedValue(
        new Response('\u0001'.repeat(MAX_RESPONSE_BYTES), {
          headers: { 'content-type': 'text/plain' },
        })
      );
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    });

    it.each([
      ['application/ld+json', true],
      ['application/xml', true],
      ['application/x-ndjson', true],
      ['application/yaml', true],
      ['text/yaml', true],
      ['text/csv; charset=utf-8', true],
      ['application/x-www-form-urlencoded', true],
      ['application/pdf', false],
      ['image/png', false],
    ])('treats %s as text: %s', async (type, text) => {
      fetchMock.mockResolvedValue(new Response('abc', { headers: { 'content-type': type } }));
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res.bodyOmitted).toBe(text ? undefined : 'binary');
    });

    it('surfaces the Location header of a created resource', async () => {
      fetchMock.mockResolvedValue(
        new Response(null, {
          headers: { location: 'https://api.example.com/v1/items/9' },
          status: 201,
        })
      );
      const res = await httpApiRequest(conn(), { method: 'POST', path: '/items' });
      expect(res.headers.location).toBe('https://api.example.com/v1/items/9');
    });
  });

  describe('errors', () => {
    it.each([
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [409, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ])('maps %i (retryable: %s)', async (status, retryable) => {
      fetchMock.mockResolvedValue(json({ error: `echo ${TOKEN}` }, status));
      const err = await httpApiRequest(conn(), {
        method: 'POST',
        path: '/items',
        query: { api_key: 'qkey' },
      }).catch((e) => e);
      expect(err.nonRetryable).toBe(!retryable);
      expect(err.message).toBe(`HttpApi POST /v1/items failed (${status})`);
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain('qkey');
    });

    it('words a transport error without the URL or token and keeps it retryable', async () => {
      fetchMock.mockRejectedValue(
        new TypeError(`fetch failed https://api.example.com/v1/a?k=${TOKEN}`)
      );
      const err = await httpApiRequest(conn(), {
        method: 'GET',
        path: '/a',
        query: { k: TOKEN },
      }).catch((e) => e);
      expect(err.nonRetryable).toBe(false);
      expect(err.message).toBe('HttpApi GET /v1/a failed: the request did not complete');
      expect(err.message).not.toContain(TOKEN);
    });

    it('refuses an SSRF block as not sent, without naming the host', async () => {
      fetchMock.mockRejectedValue(new SsrfBlockedError("host 'internal.example' is blocked"));
      const err = await httpApiRequest(conn(), { method: 'GET', path: '/a' }).catch((e) => e);
      expect(err.type).toBe('NOT_SENT');
      expect(err.nonRetryable).toBe(true);
      expect(err.message).not.toContain('internal.example');
    });

    it('treats a resolution failure as not sent and retryable', async () => {
      fetchMock.mockRejectedValue(
        new SsrfBlockedError("host 'api.example.com' did not resolve", 'unresolvable')
      );
      const err = await httpApiRequest(conn(), { method: 'GET', path: '/a' }).catch((e) => e);
      expect(err.type).toBe('NOT_SENT');
      expect(err.nonRetryable).toBe(false);
    });

    it('treats a 429 as not sent and retryable', async () => {
      fetchMock.mockResolvedValue(json({}, 429));
      const err = await httpApiRequest(conn(), { method: 'POST', path: '/a' }).catch((e) => e);
      expect(err.type).toBe('NOT_SENT');
      expect(err.nonRetryable).toBe(false);
    });

    it.each([
      ['newline', 'sek\nrit'],
      ['nul', 'sek\u0000rit'],
      ['space', 'sek rit'],
      ['non-ascii', 'sekr\u00e9t'],
    ])('refuses a token with a %s before building a header, never echoing it', async (_n, bad) => {
      const err = await httpApiRequest(conn({}, bad), { method: 'GET', path: '/a' }).catch(
        (e) => e
      );
      expect(err.type).toBe('NOT_SENT');
      expect(err.message).not.toContain(bad);
      expect(String(err.cause ?? '')).not.toContain(bad);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not attach the transport error as the cause', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new TypeError(`Headers.append: "Bearer ${TOKEN}" is invalid`), {
          code: 'ERR_X',
        })
      );
      const err = await httpApiRequest(conn(), { method: 'GET', path: '/a' }).catch((e) => e);
      expect(JSON.stringify(err.cause)).not.toContain(TOKEN);
      expect(String(err.cause?.message)).not.toContain(TOKEN);
      expect(String(err.cause?.stack ?? '')).not.toContain(TOKEN);
      expect(err.cause?.message).toBe('[{"name":"TypeError","code":"ERR_X"}]');
    });

    it('keeps only the name and an identifier-shaped code of each cause, 3 levels deep', () => {
      const deep = Object.assign(new TypeError('fetch failed Bearer abc'), {
        cause: Object.assign(new Error('connect to 10.0.0.1'), {
          cause: Object.assign(new Error('x'), {
            cause: Object.assign(new Error('too deep'), { code: 'NOPE' }),
            code: 'ECONNREFUSED',
          }),
          code: 'not a code!',
        }),
      });
      expect(sanitizedCause(deep)).toEqual([
        { name: 'TypeError' },
        { name: 'Error' },
        { code: 'ECONNREFUSED', name: 'Error' },
      ]);
    });

    it('treats a response with no content type as binary', async () => {
      fetchMock.mockResolvedValue(new Response(new TextEncoder().encode('{"a":1}')));
      const res = await httpApiRequest(conn(), { method: 'GET', path: '/a' });
      expect(res.bodyOmitted).toBe('binary');
      expect(res.body).toBeNull();
    });

    it('never puts the token in a refusal message', async () => {
      const err = await httpApiRequest(conn({ authType: 'none' }), {
        headers: { Cookie: TOKEN },
        method: 'GET',
        path: '/a',
      }).catch((e) => e);
      expect(err.message).not.toContain(TOKEN);
    });
  });
});
