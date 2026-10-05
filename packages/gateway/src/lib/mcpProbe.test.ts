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
});
