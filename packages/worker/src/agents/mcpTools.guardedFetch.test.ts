import { describe, expect, it } from 'vitest';
import { guardedMcpFetch } from './mcpTools.js';

type Call = { url: string; headers: Record<string, string> };

function stub(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      headers: Object.fromEntries(new Headers(init?.headers)),
      url: String(input),
    });
    return responses[calls.length - 1] ?? new Response('ok');
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const session = { 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': 'abc' };

describe('guardedMcpFetch', () => {
  const server = new URL('https://mcp.example.com/mcp');

  it('keeps the MCP session headers on requests to the connection origin', async () => {
    const { fetchImpl, calls } = stub([new Response('ok')]);
    await guardedMcpFetch(server, false, fetchImpl)(server.href, { headers: session });
    expect(calls[0].headers['mcp-session-id']).toBe('abc');
    expect(calls[0].headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('strips them on a redirect hop to another origin', async () => {
    const { fetchImpl, calls } = stub([
      new Response(null, { headers: { location: 'https://other.example.com/x' }, status: 302 }),
      new Response('ok'),
    ]);
    await guardedMcpFetch(server, false, fetchImpl)(server.href, { headers: session });
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['mcp-session-id']).toBeUndefined();
    expect(calls[1].headers['mcp-protocol-version']).toBeUndefined();
  });

  it('applies the private opt-in to the connection origin only', async () => {
    const priv = new URL('http://10.0.0.5:8080/mcp');
    const { fetchImpl, calls } = stub([
      new Response(null, { headers: { location: 'http://10.0.0.6/x' }, status: 302 }),
    ]);
    const f = guardedMcpFetch(priv, true, fetchImpl);
    await expect(f(priv.href, {})).rejects.toThrow(/redirect target refused/);
    expect(calls).toHaveLength(1);
  });
});
