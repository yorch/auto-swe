import { describe, expect, it, vi } from 'vitest';
import { probeMcpServer } from './mcpProbe.js';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
    ...init,
  });

function server(listBody: Response) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') {
      return json(
        { id: body.id, jsonrpc: '2.0', result: {} },
        { headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } }
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return listBody;
  });
}

describe('probeMcpServer', () => {
  it('stops reading an event stream the server holds open once the answer has arrived', async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(
          enc.encode(
            `event: message\ndata: ${JSON.stringify({ id: 2, jsonrpc: '2.0', result: { tools: [{ name: 'a' }] } })}\n\n`
          )
        );
        // never closed: the server keeps the stream open for notifications
      },
    });
    const sse = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, server(sse) as never);
    expect(res).toMatchObject({ ok: true, toolCount: 1 });
    expect(cancelled).toBe(true);
  });

  it('reports the timeout, not a connection error, when the abort lands mid-read', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: ping\ndata: {}\n\n'));
        // never closed and never answers: the read hangs until the probe's deadline
      },
    });
    const sse = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const res = await probeMcpServer('https://mcp.test/mcp', 50, server(sse) as never);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not answer within/);
  });

  it('finds the answer when an event is split across chunks, without rescanning the buffer', async () => {
    const enc = new TextEncoder();
    const msg = `data: ${JSON.stringify({ id: 2, jsonrpc: '2.0', result: { tools: [{ name: 'a' }, { name: 'b' }] } })}\r\n\r\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"id":9}\n\n'));
        controller.enqueue(enc.encode(msg.slice(0, 20)));
        controller.enqueue(enc.encode(msg.slice(20)));
      },
    });
    const sse = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, server(sse) as never);
    expect(res).toMatchObject({ ok: true, toolCount: 2 });
  });

  it('closes the session with a DELETE carrying its id', async () => {
    const f = server(json({ id: 2, jsonrpc: '2.0', result: { tools: [] } }));
    await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    const last = f.mock.calls.at(-1)?.[1] as RequestInit;
    expect(last.method).toBe('DELETE');
    expect((last.headers as Record<string, string>)['mcp-session-id']).toBe('s1');
  });

  it('never waits longer than a minute whatever timeout is stored', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await probeMcpServer(
      'https://mcp.test/mcp',
      600_000,
      server(json({ id: 2, jsonrpc: '2.0', result: { tools: [] } })) as never
    );
    expect(spy).toHaveBeenCalledWith(60_000);
    spy.mockRestore();
  });

  it('reports the tool count and names, carrying the session through', async () => {
    const f = server(
      json({ id: 2, jsonrpc: '2.0', result: { tools: [{ name: 'search' }, { name: 'fetch' }] } })
    );
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    expect(res).toMatchObject({ ok: true, toolCount: 2, toolNames: ['search', 'fetch'] });
    const listCall = f.mock.calls.find(([, init]) =>
      String((init as RequestInit).body).includes('tools/list')
    )?.[1] as RequestInit;
    expect((listCall.headers as Record<string, string>)['mcp-session-id']).toBe('s1');
    expect(listCall.redirect).toBe('manual');
  });

  it('reads a response delivered as an event stream', async () => {
    const sse = new Response(
      `event: message\ndata: ${JSON.stringify({ id: 2, jsonrpc: '2.0', result: { tools: [{ name: 'a' }] } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    );
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, server(sse) as never);
    expect(res).toMatchObject({ ok: true, toolCount: 1 });
  });

  it('refuses to follow a redirect', async () => {
    const f = vi.fn(
      async () => new Response(null, { headers: { location: 'http://10.0.0.1' }, status: 302 })
    );
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/redirected/);
  });

  it('turns a connection failure into a fixed message, not the raw error', async () => {
    const f = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:443');
    });
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    expect(res).toMatchObject({ error: 'Could not connect to the server.', ok: false });
  });

  it('reports an authentication requirement', async () => {
    const f = vi.fn(async () => new Response('no', { status: 401 }));
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    expect(res.error).toMatch(/requires authentication/);
  });

  it('rejects a body that is not an MCP answer', async () => {
    const res = await probeMcpServer(
      'https://mcp.test/mcp',
      5000,
      (async () => new Response('<html>', { status: 200 })) as never
    );
    expect(res.error).toMatch(/valid MCP response/);
  });

  describe('bearer token and legacy SSE', () => {
    const TOKEN = 'sk-probe-secret';
    const authOf = (init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.authorization;

    it('sends the token on every request, session close included', async () => {
      const f = server(json({ id: 2, jsonrpc: '2.0', result: { tools: [] } }));
      const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never, {
        bearerToken: TOKEN,
      });
      expect(res.ok).toBe(true);
      expect(f.mock.calls.length).toBeGreaterThanOrEqual(4);
      for (const [, init] of f.mock.calls) {
        expect(authOf(init as RequestInit)).toBe(`Bearer ${TOKEN}`);
      }
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    });

    it('sends no Authorization header when no token is stored', async () => {
      const f = server(json({ id: 2, jsonrpc: '2.0', result: { tools: [] } }));
      await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
      for (const [, init] of f.mock.calls) {
        expect(authOf(init as RequestInit)).toBeUndefined();
      }
    });

    it('says whether a token was missing or rejected', async () => {
      const f = vi.fn(async () => new Response('no', { status: 401 }));
      const without = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
      expect(without.error).toMatch(/Add a bearer token/);
      const rejected = await probeMcpServer('https://mcp.test/mcp', 5000, f as never, {
        bearerToken: TOKEN,
      });
      expect(rejected.error).toBe('The server rejected the stored bearer token.');
      expect(rejected.error).not.toContain(TOKEN);
      // An auth failure is final: no second transport is tried.
      expect(f).toHaveBeenCalledTimes(2);
    });

    /** A legacy SSE server: POST to the base URL is 404, GET opens the stream. */
    function legacyServer(opts: { endpoint?: string } = {}) {
      const enc = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const sent = (e: string, d: string) =>
        controller?.enqueue(enc.encode(`event: ${e}\ndata: ${d}\n\n`));
      const calls: { url: string; init: RequestInit }[] = [];
      const f = vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ init: init ?? {}, url: String(url) });
        if (init?.method === 'GET') {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              sent('endpoint', opts.endpoint ?? '/messages?sid=1');
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (init?.method === 'POST' && String(url) === 'https://mcp.test/mcp') {
          return new Response('nope', { status: 404 });
        }
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          if (body.id !== undefined) {
            const result =
              body.method === 'initialize' ? {} : { tools: [{ name: 'x' }, { name: 'y' }] };
            sent('message', JSON.stringify({ id: body.id, jsonrpc: '2.0', result }));
          }
          return new Response(null, { status: 202 });
        }
        return new Response(null, { status: 200 });
      });
      return { calls, f };
    }

    it('falls back to the legacy SSE transport when streamable HTTP is not there', async () => {
      const { calls, f } = legacyServer();
      const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never, {
        bearerToken: TOKEN,
      });
      expect(res).toMatchObject({ ok: true, toolCount: 2, toolNames: ['x', 'y'] });
      const get = calls.find((c) => c.init.method === 'GET');
      expect(get?.url).toBe('https://mcp.test/mcp');
      expect(authOf(get?.init)).toBe(`Bearer ${TOKEN}`);
      const posts = calls.filter((c) => c.url === 'https://mcp.test/messages?sid=1');
      expect(posts.length).toBe(3); // initialize, initialized, tools/list
      for (const c of calls) {
        expect(authOf(c.init)).toBe(`Bearer ${TOKEN}`);
        expect(c.init.redirect).toBe('manual');
      }
    });

    it('goes straight to SSE for a URL ending /sse', async () => {
      const { calls, f } = legacyServer();
      const res = await probeMcpServer('https://mcp.test/sse', 5000, f as never);
      expect(res.ok).toBe(true);
      expect(calls[0]?.init.method).toBe('GET');
    });

    it('never sends the token to an SSE endpoint on another origin', async () => {
      const { calls, f } = legacyServer({ endpoint: 'https://evil.example.net/messages' });
      const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never, {
        bearerToken: TOKEN,
      });
      expect(res.ok).toBe(false);
      expect(calls.some((c) => c.url.includes('evil.example.net'))).toBe(false);
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    });

    it('refuses a redirect on the SSE stream and does not follow it with the token', async () => {
      const f = vi.fn(async (_url: unknown, init?: RequestInit) =>
        init?.method === 'GET'
          ? new Response(null, {
              headers: { location: 'https://evil.example.net/sse' },
              status: 302,
            })
          : new Response('nope', { status: 404 })
      );
      const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never, {
        bearerToken: TOKEN,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/redirected/);
      expect(f.mock.calls.every(([u]) => !String(u).includes('evil'))).toBe(true);
    });

    it('removes each per-event abort listener once the read settles', async () => {
      const { f } = legacyServer();
      const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
      const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
      try {
        const res = await probeMcpServer('https://mcp.test/sse', 5000, f as never);
        expect(res.ok).toBe(true);
        const added = add.mock.calls.filter(([type]) => type === 'abort').map(([, l]) => l);
        const removed = remove.mock.calls.map(([, l]) => l);
        expect(added.length).toBeGreaterThan(0);
        for (const listener of added) {
          expect(removed).toContain(listener);
        }
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    });

    it('reports the streamable error when an SSE stream never announces an endpoint', async () => {
      const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'GET') {
          // A stream that stays open and silent.
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response('nope', { status: 404 });
      });
      const started = Date.now();
      const res = await probeMcpServer('https://mcp.test/mcp', 20_000, f as never);
      expect(res.error).toBe('The server answered with HTTP 404.');
      // The silent stream was given up on after the short endpoint wait, not the whole deadline.
      expect(Date.now() - started).toBeLessThan(8000);
    }, 15_000);

    it('reports the streamable error when the legacy transport fails too', async () => {
      const f = vi.fn(async () => new Response('nope', { status: 404 }));
      const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
      expect(res.error).toBe('The server answered with HTTP 404.');
    });
  });
});
