import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../harness/mcpRelay.js', () => ({ openMcpRelay: h.open }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { openPluginMcpRelays, safeAuditValue, scrubEndpoint } from './pluginMcpRelay.js';

const binding = (server: string, url: string) =>
  ({
    connectionId: `conn-${server}`,
    key: `acme_${server}`,
    plugin: 'acme',
    server,
    target: { url },
  }) as never;

const tracer = () => {
  const events: { name: string; [k: string]: unknown }[] = [];
  return {
    addActivityEvent: (e: { name: string }) => events.push(e),
    addToolCall: vi.fn(),
    events,
  };
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('openPluginMcpRelays', () => {
  it('opens each binding with the shared relay code and reports one event per plugin', async () => {
    h.open.mockImplementation(async (target: { url: string }) => ({
      close: vi.fn(),
      tools: target.url.includes('docs') ? [{ name: 'a' }, { name: 'b' }] : [{ name: 'c' }],
    }));
    const t = tracer();
    const out = await openPluginMcpRelays(
      [binding('docs', 'https://docs.example/mcp'), binding('wiki', 'https://wiki.example/mcp')],
      t
    );
    expect(out.map((o) => [o.key, o.relay.tools.length])).toEqual([
      ['acme_docs', 2],
      ['acme_wiki', 1],
    ]);
    expect(t.events).toEqual([
      {
        name: 'agent.plugin_mcp',
        outputJson: {
          plugin: 'acme',
          servers: [
            { connectionId: 'conn-docs', server: 'docs', tools: 2 },
            { connectionId: 'conn-wiki', server: 'wiki', tools: 1 },
          ],
        },
      },
    ]);
  });

  it('counts the tools it withheld for a name the harness could not serve', async () => {
    h.open.mockImplementation(
      async (
        _target: unknown,
        _tracer: unknown,
        options: { acceptTool: (n: string) => boolean }
      ) => {
        const tools = ['ok', 'not ok', 'x'.repeat(80)].filter(options.acceptTool);
        return { close: vi.fn(), tools: tools.map((name) => ({ name })) };
      }
    );
    const t = tracer();
    await openPluginMcpRelays([binding('docs', 'https://docs.example/mcp')], t);
    expect(t.events[0]?.outputJson).toEqual({
      plugin: 'acme',
      servers: [{ connectionId: 'conn-docs', server: 'docs', tools: 1, withheldTools: 2 }],
    });
  });

  it('keeps the connection’s address out of every event the relay records', async () => {
    h.open.mockImplementation(async (target: { url: string }, relayTracer: never) => {
      const rt = relayTracer as {
        addActivityEvent: (e: object) => void;
      };
      rt.addActivityEvent({
        error: `MCP connection to ${target.url} timed out; see https://other.example/x`,
        inputJson: { mcpServerRef: target.url },
        name: 'mcp.connect_failed',
      });
      rt.addActivityEvent({
        inputJson: { mcpServerRef: target.url },
        name: 'mcp.tools_loaded',
        outputJson: { count: 1, tools: ['a'], via: 'harness' },
      });
      return null;
    });
    const t = tracer();
    const out = await openPluginMcpRelays(
      [binding('docs', 'https://docs.example/mcp?k=secret')],
      t
    );
    expect(out).toEqual([]);
    expect(t.events.map((e) => e.name)).toEqual(['mcp.connect_failed', 'mcp.tools_loaded']);
    expect(t.events[0]).toMatchObject({
      error: 'MCP connection to [endpoint] timed out; see [endpoint]',
      inputJson: { plugin: 'acme', server: 'docs' },
    });
    expect(JSON.stringify(t.events)).not.toMatch(/https?:|secret|example/);
  });

  it('opens the relay as third-party: a label for the log, and a scrub for errors', async () => {
    let options: { thirdParty?: { label: string; scrub: (t: string) => string } } = {};
    h.open.mockImplementation(async (_t: unknown, _tr: unknown, o: typeof options) => {
      options = o;
      return { close: vi.fn(), tools: [] };
    });
    await openPluginMcpRelays([binding('docs', 'https://docs.example:8443/mcp?k=1')], tracer());
    expect(options.thirdParty?.label).toBe('plugin=acme server=docs');
    const scrubbed = options.thirdParty?.scrub(
      'fetch failed: getaddrinfo ENOTFOUND docs.example, GET https://docs.example:8443/mcp?k=1 and https://x.test/y'
    );
    expect(scrubbed).toBe(
      'fetch failed: getaddrinfo ENOTFOUND [endpoint], GET [endpoint] and [endpoint]'
    );
  });

  it('opens nothing and reports nothing without bindings', async () => {
    const t = tracer();
    expect(await openPluginMcpRelays([], t)).toEqual([]);
    expect(h.open).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });
});

describe('the audit label', () => {
  it('cannot be spoofed by a declared server name carrying spaces or fields', async () => {
    let label = '';
    h.open.mockImplementation(async (_t: unknown, _tr: unknown, o: never) => {
      label = (o as { thirdParty: { label: string } }).thirdParty.label;
      return { close: vi.fn(), tools: [] };
    });
    await openPluginMcpRelays(
      [binding('x tool=other\nvia=x', 'https://docs.example/mcp')],
      tracer()
    );
    expect(label).toBe('plugin=acme server=x_tool_other_via_x');
    expect(label.split(' ')).toHaveLength(2);
  });

  it('keeps only safe characters and caps the length', () => {
    expect(safeAuditValue('ok.name_1:x-y')).toBe('ok.name_1:x-y');
    expect(safeAuditValue('a b=c"d\n')).toBe('a_b_c_d_');
    expect(safeAuditValue('x'.repeat(200))).toHaveLength(64);
  });
});

describe('scrubEndpoint', () => {
  const url = 'https://docs.example:8443/mcp';
  it.each([
    'connect ECONNREFUSED 10.0.0.5:443',
    'connect ECONNREFUSED 10.0.0.5',
    'connect ECONNREFUSED [::1]:443',
    'connect ECONNREFUSED fe80::1',
    'connect ECONNREFUSED 2001:db8::7',
    'getaddrinfo failed for internal-host:5432',
  ])('replaces an address in %s', (text) => {
    const out = scrubEndpoint(text, url);
    expect(out).toContain('[endpoint]');
    expect(out).not.toMatch(/10\.0\.0\.5|::1|fe80|db8|internal-host/);
  });

  it('still replaces the URL and its host, and leaves plain text alone', () => {
    expect(scrubEndpoint(`GET ${url} then docs.example`, url)).toBe(
      'GET [endpoint] then [endpoint]'
    );
    expect(scrubEndpoint('tool failed: bad argument', url)).toBe('tool failed: bad argument');
  });
});
