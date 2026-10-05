import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MCPClient } from '@mastra/mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerFetch } from './mcpTools.js';

/**
 * The real MCP client against a loopback server, over each transport: does the bearer token
 * arrive on EVERY request, including the SSE stream's GET, and does a server that rejects a
 * missing token stay rejected without one?
 */

const TOKEN = 'sk-transport-test-token';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

function rpcResult(id: unknown, method: string) {
  if (method === 'initialize') {
    return {
      capabilities: { tools: {} },
      protocolVersion: '2025-03-26',
      serverInfo: { name: 't', version: '1' },
    };
  }
  return { id, tools: [{ description: 'd', inputSchema: { type: 'object' }, name: 'ping' }] };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

/** A legacy HTTP+SSE-only server: GET /sse opens the stream, POST /messages answers on it. */
function listenSse(seen: { auth: (string | undefined)[] }): Promise<URL> {
  let stream: import('node:http').ServerResponse | undefined;
  server = createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      stream = res;
      res.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      const msg = await body(req);
      res.writeHead(202).end();
      if (msg.id !== undefined) {
        const result = rpcResult(msg.id, String(msg.method));
        stream?.write(
          `event: message\ndata: ${JSON.stringify({ id: msg.id, jsonrpc: '2.0', result })}\n\n`
        );
      }
      return;
    }
    res.writeHead(404).end();
  });
  const srv = server;
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/sse`))
    )
  );
}

describe('bearer token over the real MCP client', () => {
  it('reaches the legacy SSE stream and its POSTs, and the tools load', async () => {
    const seen = { auth: [] as (string | undefined)[] };
    const url = await listenSse(seen);
    const client = new MCPClient({
      id: `transport-test-${Math.random()}`,
      servers: {
        mcp: { allowedHosts: [url.host], fetch: bearerFetch(url, TOKEN) as never, url },
      },
    });
    try {
      const { toolsets, errors } = await client.listToolsetsWithErrors();
      expect(errors?.mcp).toBeUndefined();
      expect(Object.keys(toolsets.mcp ?? {})).toContain('ping');
      expect(seen.auth.length).toBeGreaterThanOrEqual(3);
      expect(seen.auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  it('is turned away by a server that needs the token when none is sent', async () => {
    const seen = { auth: [] as (string | undefined)[] };
    const url = await listenSse(seen);
    const client = new MCPClient({
      id: `transport-test-${Math.random()}`,
      servers: { mcp: { url } },
    });
    try {
      const { errors } = await client.listToolsetsWithErrors();
      expect(errors?.mcp).toBeDefined();
    } finally {
      await client.disconnect();
    }
  });
});
