import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ audit: vi.fn() }));

// The relay reaches a server on loopback here, which the SSRF guard (rightly)
// refuses in production: only the URL check and the guarded fetches are stubbed.
vi.mock('../mcpTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpTools.js')>()),
  bearerFetch:
    (_url: URL, token: string | undefined) => (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (token) {
        headers.set('authorization', `Bearer ${token}`);
      }
      return fetch(input, { ...init, headers });
    },
  guardedMcpFetch: () => (input: string | URL, init?: RequestInit) => fetch(input, init),
  originScopedFetch: () => fetch,
  parseMcpServerRef: (ref: string) => new URL(ref),
}));
vi.mock('../../lib/activityLog.js', () => ({ auditLog: h.audit }));

import { openMcpRelay } from './mcpRelay.js';

/** A real MCP server over streamable HTTP, with one tool, recording the auth it saw. */
async function remoteServer() {
  const authorizations: (string | undefined)[] = [];
  const server = http.createServer(async (req, res) => {
    authorizations.push(req.headers.authorization);
    const mcp = new McpServer({ name: 'remote', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      { description: 'Echo the text back', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ text: `echo: ${text}`, type: 'text' }] })
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${port}/mcp`,
  };
}

/** What the harness's MCP client sees through one of the relay's in-process servers. */
async function harnessClient(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'harness', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

let remote: Awaited<ReturnType<typeof remoteServer>> | undefined;
afterEach(async () => {
  await remote?.close();
  remote = undefined;
  h.audit.mockClear();
});

describe('openMcpRelay', () => {
  it('offers the remote tools with their own schemas and runs each call in the worker', async () => {
    remote = await remoteServer();
    const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
    const target = Object.defineProperty({ url: remote.url }, 'bearerToken', {
      enumerable: false,
      value: 'mcp-secret',
    });

    const relay = await openMcpRelay(target, tracer as never);
    expect(relay?.tools.map((t) => t.name)).toEqual(['echo']);
    expect(relay?.tools[0]?.inputSchema).toMatchObject({
      properties: { text: { type: 'string' } },
      type: 'object',
    });
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp.tools_loaded' })
    );

    const client = await harnessClient(relay?.createServer() as McpServer);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool({ arguments: { text: 'hi' }, name: 'echo' });
    expect(result.content).toEqual([{ text: 'echo: hi', type: 'text' }]);
    // The credential went to the remote server from the worker, and each call is audited.
    expect(remote.authorizations.every((a) => a === 'Bearer mcp-secret')).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(expect.stringContaining('tool=echo'));

    // A tool the connection did not offer is refused without reaching it.
    const unknown = await client.callTool({ arguments: {}, name: 'rm_rf' });
    expect(unknown.isError).toBe(true);

    await client.close();
    await relay?.close();
  });

  it('serves a fresh in-process server to each session over one remote connection', async () => {
    remote = await remoteServer();
    const relay = await openMcpRelay({ url: remote.url });
    const first = await harnessClient(relay?.createServer() as McpServer);
    await first.close();
    const second = await harnessClient(relay?.createServer() as McpServer);
    expect((await second.callTool({ arguments: { text: 'again' }, name: 'echo' })).content).toEqual(
      [{ text: 'echo: again', type: 'text' }]
    );
    await second.close();
    await relay?.close();
  });

  it('opens nothing, and says why, when the server cannot be reached', async () => {
    const tracer = { addActivityEvent: vi.fn(), addToolCall: vi.fn() };
    const relay = await openMcpRelay(
      { listTimeoutMs: 2_000, url: 'http://127.0.0.1:9/mcp' },
      tracer as never
    );
    expect(relay).toBeNull();
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp.connect_failed' })
    );
  });
});
