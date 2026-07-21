import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMcpToolEnabled,
  loadMcpTools,
  MCP_TOOL_KEY,
  type McpTracer,
  parseMcpServerRef,
} from './mcpTools.js';

// ── Mock @mastra/mcp ──
// Each test configures the behavior of listToolsetsWithErrors via these knobs.
const listToolsetsWithErrors = vi.fn();
const disconnect = vi.fn(async () => {});
const constructorArgs: unknown[] = [];

vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    constructor(args: unknown) {
      constructorArgs.push(args);
    }
    listToolsetsWithErrors = listToolsetsWithErrors;
    disconnect = disconnect;
  },
}));

function makeTracer() {
  return {
    addActivityEvent: vi.fn<McpTracer['addActivityEvent']>(),
    addToolCall: vi.fn<McpTracer['addToolCall']>(),
  } satisfies McpTracer;
}

function makeServerTool(execute: (input: unknown) => Promise<unknown>) {
  return {
    description: 'a remote tool',
    execute: vi.fn(execute),
    id: 'remoteTool',
  };
}

/** Wrapped MCP tools take (input, context); tests only care about input. */
function exec(tool: { execute?: unknown }, input: unknown): Promise<unknown> {
  const fn = tool.execute as (input: unknown, ctx?: unknown) => Promise<unknown>;
  return fn(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  constructorArgs.length = 0;
});

// ── Gating (AgentToolConfig 'mcp' pseudo-key) ──

describe('isMcpToolEnabled', () => {
  it('is enabled when no tool config exists (null = all tools, mirrors built-ins)', () => {
    expect(isMcpToolEnabled(null)).toBe(true);
    expect(isMcpToolEnabled(undefined)).toBe(true);
    expect(isMcpToolEnabled([])).toBe(true);
  });

  it('is disabled when a config exists without the mcp key — true for all existing configs', () => {
    expect(isMcpToolEnabled(['readFile', 'writeFile', 'listDirectory', 'bash'])).toBe(false);
    expect(isMcpToolEnabled(['bash'])).toBe(false);
  });

  it('is enabled only when the config explicitly includes the mcp key', () => {
    expect(isMcpToolEnabled(['bash', MCP_TOOL_KEY])).toBe(true);
    expect(isMcpToolEnabled([MCP_TOOL_KEY])).toBe(true);
  });
});

// ── Ref validation (http(s) only — no stdio) ──

describe('parseMcpServerRef', () => {
  it('accepts http and https URLs to public hosts', () => {
    expect(parseMcpServerRef('http://mcp-server.example.com:8080/mcp')?.protocol).toBe('http:');
    expect(parseMcpServerRef('https://mcp.example.com/sse')?.protocol).toBe('https:');
  });

  it('rejects non-URL and non-http refs (no stdio command execution)', () => {
    expect(parseMcpServerRef('npx some-mcp-server')).toBeNull();
    expect(parseMcpServerRef('stdio:some-command')).toBeNull();
    expect(parseMcpServerRef('file:///etc/passwd')).toBeNull();
    expect(parseMcpServerRef('ws://example.com')).toBeNull();
  });

  // Defense-in-depth (G3): the gateway's `/mcp-connections` create route
  // already rejects unsafe URLs at write time via the shared SSRF guard, but
  // the worker re-checks so a private/loopback/link-local/metadata target
  // can never reach an outbound MCP connection even if it slipped past the
  // gateway (e.g. an older row written before the guard existed).
  it('rejects loopback, private-network, and metadata hosts', () => {
    expect(parseMcpServerRef('http://localhost:8080/mcp')).toBeNull();
    expect(parseMcpServerRef('http://127.0.0.1/mcp')).toBeNull();
    expect(parseMcpServerRef('http://10.0.0.5/mcp')).toBeNull();
    expect(parseMcpServerRef('http://192.168.1.1/mcp')).toBeNull();
    expect(parseMcpServerRef('http://169.254.169.254/mcp')).toBeNull();
  });
});

describe('loadMcpTools — invalid ref', () => {
  it('returns no tools, records mcp.invalid_ref, and never constructs a client', async () => {
    const tracer = makeTracer();
    const { tools } = await loadMcpTools('npx evil-server --rm -rf /', tracer);

    expect(tools).toEqual({});
    expect(constructorArgs).toHaveLength(0);
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('http(s)'),
        name: 'mcp.invalid_ref',
      })
    );
  });
});

// ── Happy path ──

describe('loadMcpTools — tool surfacing', () => {
  it('surfaces server tools keyed with the mcp_ prefix and records mcp.tools_loaded', async () => {
    const tracer = makeTracer();
    listToolsetsWithErrors.mockResolvedValue({
      errors: {},
      toolsets: {
        mcp: {
          'search.docs': makeServerTool(async () => ({ ok: true })),
          searchDocs: makeServerTool(async () => ({ ok: true })),
        },
      },
    });

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer);

    // keys are sanitized to provider-safe tool names
    expect(Object.keys(tools).sort()).toEqual(['mcp_searchDocs', 'mcp_search_docs']);
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcp.tools_loaded',
        outputJson: expect.objectContaining({ count: 2 }),
      })
    );
  });

  it('records each tool call on the tracer with the mcp: prefix and audit-logs it', async () => {
    const tracer = makeTracer();
    // Keep a handle on the inner execute — wrapMcpTool replaces tool.execute in place.
    const innerExecute = vi.fn(async (input: unknown) => ({ echoed: input }));
    listToolsetsWithErrors.mockResolvedValue({
      errors: {},
      toolsets: { mcp: { searchDocs: { description: 'd', execute: innerExecute, id: 'r' } } },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer);
    const result = await exec(tools.mcp_searchDocs, { query: 'hello' });

    expect(result).toEqual({ echoed: { query: 'hello' } });
    expect(innerExecute).toHaveBeenCalledTimes(1);
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        inputJson: { query: 'hello' },
        outputJson: { echoed: { query: 'hello' } },
        toolName: 'mcp:searchDocs',
      })
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[mcp:audit]'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tool=searchDocs'));
    logSpy.mockRestore();
  });

  it('records tool-call failures on the tracer and rethrows', async () => {
    const tracer = makeTracer();
    listToolsetsWithErrors.mockResolvedValue({
      errors: {},
      toolsets: { mcp: { broken: makeServerTool(async () => Promise.reject(new Error('boom'))) } },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer);
    await expect(exec(tools.mcp_broken, {})).rejects.toThrow('boom');

    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'boom', toolName: 'mcp:broken' })
    );
    vi.mocked(console.log).mockRestore();
  });

  it('caps each tool call with the configured timeout', async () => {
    const tracer = makeTracer();
    const never = new Promise(() => {}); // never resolves
    listToolsetsWithErrors.mockResolvedValue({
      errors: {},
      toolsets: { mcp: { slow: makeServerTool(() => never as Promise<unknown>) } },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer, {
      callTimeoutMs: 20,
    });
    await expect(exec(tools.mcp_slow, {})).rejects.toThrow(/timed out after 20ms/);
    expect(tracer.addToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('timed out'), toolName: 'mcp:slow' })
    );
    vi.mocked(console.log).mockRestore();
  });

  it('closes the underlying client via the returned close()', async () => {
    listToolsetsWithErrors.mockResolvedValue({
      errors: {},
      toolsets: { mcp: { t: makeServerTool(async () => ({})) } },
    });

    const { close } = await loadMcpTools('http://mcp-server.example.com:9999/mcp');
    await close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

// ── Connect-failure isolation ──

describe('loadMcpTools — connect failure isolation', () => {
  it('returns no tools and records mcp.connect_failed when listing rejects', async () => {
    const tracer = makeTracer();
    listToolsetsWithErrors.mockRejectedValue(new Error('ECONNREFUSED'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer);

    expect(tools).toEqual({});
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('ECONNREFUSED'),
        name: 'mcp.connect_failed',
      })
    );
    // best-effort cleanup of the failed client
    expect(disconnect).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('treats a per-server error entry as a connect failure', async () => {
    const tracer = makeTracer();
    listToolsetsWithErrors.mockResolvedValue({
      errors: { mcp: 'HTTP 401 Unauthorized' },
      toolsets: {},
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer);

    expect(tools).toEqual({});
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('401'),
        name: 'mcp.connect_failed',
      })
    );
    vi.mocked(console.error).mockRestore();
  });

  it('caps tool listing with the configured timeout', async () => {
    const tracer = makeTracer();
    listToolsetsWithErrors.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { tools } = await loadMcpTools('http://mcp-server.example.com:9999/mcp', tracer, {
      listTimeoutMs: 20,
    });

    expect(tools).toEqual({});
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('timed out after 20ms'),
        name: 'mcp.connect_failed',
      })
    );
    vi.mocked(console.error).mockRestore();
  });

  it('never throws even when disconnect also fails', async () => {
    listToolsetsWithErrors.mockRejectedValue(new Error('down'));
    disconnect.mockRejectedValueOnce(new Error('also down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadMcpTools('http://mcp-server.example.com:9999/mcp')).resolves.toEqual(
      expect.objectContaining({ tools: {} })
    );
    vi.mocked(console.error).mockRestore();
    vi.mocked(console.warn).mockRestore();
  });
});
