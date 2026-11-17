import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../activities/workspace.js';
import type { McpApprovalGuard, McpGuardCall, McpGuardOutcome } from '../../lib/mcpApproval.js';

vi.mock('../mcpTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpTools.js')>()),
  guardedMcpFetch: () => (input: string | URL, init?: RequestInit) => fetch(input, init),
  originScopedFetch: () => fetch,
  parseMcpServerRef: (ref: string) => new URL(ref),
}));
vi.mock('../../lib/activityLog.js', () => ({ auditLog: vi.fn() }));
// A guarded run's results are screened; the scan itself is covered by mcpScreen.test.ts.
vi.mock('../../lib/memoryGuard.js', () => ({
  memoryInjectionMatches: vi.fn(async () => ({
    incomplete: false,
    loadFailed: false,
    matches: [],
  })),
}));
vi.mock('../../lib/effectLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/effectLedger.js')>()),
  recordEffect: vi.fn(),
}));

import { openMcpRelay } from '../harness/mcpRelay.js';
import { piMcpTools } from './mcp.js';

const calls: string[] = [];

async function remoteServer() {
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'remote', version: '1.0.0' });
    mcp.registerTool(
      'lookup',
      { annotations: { readOnlyHint: true }, description: 'Read something' },
      async () => {
        calls.push('lookup');
        return { content: [{ text: 'found', type: 'text' }] };
      }
    );
    mcp.registerTool('wipe', { description: 'A write tool' }, async () => {
      calls.push('wipe');
      return { content: [{ text: 'wiped', type: 'text' }] };
    });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${port}/mcp`,
  };
}

let remote: Awaited<ReturnType<typeof remoteServer>> | undefined;
afterEach(async () => {
  await remote?.close();
  remote = undefined;
  calls.length = 0;
});

const execute = (tools: ReturnType<typeof piMcpTools>, name: string) => {
  const tool = tools.find((t) => t.name.endsWith(name));
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  return tool.execute('call-1', {}, undefined as never, undefined as never);
};

const guardThat = (decide: (call: McpGuardCall) => boolean) => {
  const guard: McpApprovalGuard = {
    async run<T>(call: McpGuardCall, run: () => Promise<T>): Promise<McpGuardOutcome<T>> {
      return decide(call)
        ? { ran: true, value: await run() }
        : { message: 'denied by launcher', ran: false };
    },
  };
  vi.spyOn(guard, 'run');
  return guard;
};

describe('piMcpTools: orchestration write approval', () => {
  it('refuses a denied write as a tool error and runs a read, through the relay guard', async () => {
    remote = await remoteServer();
    const approval = guardThat(
      (call) => (call.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true
    );
    const relay = await openMcpRelay({ approval, url: remote.url });
    const tools = piMcpTools({
      maxToolOutputChars: 20_000,
      relay: relay as NonNullable<typeof relay>,
      workspace: {} as Workspace,
    });

    // The read ran, and a guarded run's result arrives screened and fenced.
    const read = await execute(tools, 'lookup');
    expect(JSON.stringify(read)).toContain('found');
    expect(JSON.stringify(read)).toContain('UNTRUSTED MCP OUTPUT');
    await expect(execute(tools, 'wipe')).rejects.toThrow('denied by launcher');
    expect(calls).toEqual(['lookup']);
    await relay?.close();
  });

  it('leaves a run with no guard untouched', async () => {
    remote = await remoteServer();
    const relay = await openMcpRelay({ url: remote.url });
    const tools = piMcpTools({
      maxToolOutputChars: 20_000,
      relay: relay as NonNullable<typeof relay>,
      workspace: {} as Workspace,
    });
    await expect(execute(tools, 'wipe')).resolves.toMatchObject({
      content: [{ text: 'wiped', type: 'text' }],
    });
    expect(calls).toEqual(['wipe']);
    await relay?.close();
  });
});
