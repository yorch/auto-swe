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
  it('reports the tool count and names, carrying the session through', async () => {
    const f = server(
      json({ id: 2, jsonrpc: '2.0', result: { tools: [{ name: 'search' }, { name: 'fetch' }] } })
    );
    const res = await probeMcpServer('https://mcp.test/mcp', 5000, f as never);
    expect(res).toMatchObject({ ok: true, toolCount: 2, toolNames: ['search', 'fetch'] });
    const listCall = f.mock.calls.at(-1)?.[1] as RequestInit;
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
