import { beforeEach, describe, expect, it, vi } from 'vitest';

const cancel = vi.hoisted(() => ({ ctl: new AbortController() }));
vi.mock('@temporalio/activity', () => ({
  Context: { current: () => ({ cancellationSignal: cancel.ctl.signal }) },
  heartbeat: vi.fn(),
}));
vi.mock('../lib/config/mcpConnection.js', () => ({ mcpUrlForConnection: vi.fn() }));
vi.mock('../agents/mcpTools.js', () => ({
  loadMcpTools: vi.fn(),
  sanitizeToolName: (n: string) => n.replace(/[^A-Za-z0-9_-]/g, '_'),
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: class {
    addToolCall() {}
    addActivityEvent() {}
  },
}));

import { loadMcpTools } from '../agents/mcpTools.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';
import { mcpCallTool } from './mcpCallTool.js';

const mockedUrl = vi.mocked(mcpUrlForConnection);
const mockedLoad = vi.mocked(loadMcpTools);

beforeEach(() => {
  vi.clearAllMocks();
  cancel.ctl = new AbortController();
});

describe('mcpCallTool', () => {
  it('invokes the named tool with the inputs, returns its result, and closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    const result = await mcpCallTool({
      connectionRef: 'c1',
      inputs: { q: 'x' },
      tool: 'search_docs',
    });

    expect(result).toEqual({ result: { ok: 1 } });
    expect(execute).toHaveBeenCalledWith({ q: 'x' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('threads the connection timeout overrides into loadMcpTools', async () => {
    mockedUrl.mockResolvedValue({
      callTimeoutMs: 5000,
      listTimeoutMs: 2500,
      url: 'https://mcp.example.com/mcp',
    });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    await mcpCallTool({ connectionRef: 'c1', inputs: { q: 'x' }, tool: 'search_docs' });

    expect(mockedLoad).toHaveBeenCalledWith('https://mcp.example.com/mcp', expect.anything(), {
      callTimeoutMs: 5000,
      listTimeoutMs: 2500,
    });
  });

  it('throws when the connection is not an active mcp connection', async () => {
    mockedUrl.mockResolvedValue(null);
    await expect(mcpCallTool({ connectionRef: 'c1', tool: 't' })).rejects.toThrow(
      /not an active mcp connection/
    );
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('throws when the tool is missing from the server but still closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: {} } as never);

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'missing' })).rejects.toThrow(
      /not found/
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('mcpCallTool (cancellation)', () => {
  it('does not call the tool when the activity was cancelled while connecting', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockImplementation((async () => {
      cancel.ctl.abort(new Error('activity cancelled'));
      return { close, tools: { mcp_search_docs: { execute } } };
    }) as never);

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'search_docs' })).rejects.toThrow(
      'activity cancelled'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on an in-flight tool call when cancelled, and still closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn(() => new Promise(() => undefined));
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    const pending = mcpCallTool({ connectionRef: 'c1', tool: 'search_docs' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    cancel.ctl.abort(new Error('activity cancelled'));

    await expect(pending).rejects.toThrow('activity cancelled');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
