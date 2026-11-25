import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  connectionFind: vi.fn(),
  mappingCount: vi.fn(),
  mappingFind: vi.fn(),
  pin: vi.fn(),
  readPin: vi.fn(),
  target: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: h.connectionFind },
    pluginMcpMapping: { count: h.mappingCount, findMany: h.mappingFind },
    workflowTemplate: { findUnique: vi.fn() },
  },
}));
vi.mock('./harnessProfile.js', () => ({
  pinHarnessProfile: h.pin,
  readHarnessPin: h.readPin,
}));
vi.mock('./mcpConnection.js', () => ({ mcpUrlForConnection: h.target }));

import {
  PLUGIN_MCP_SKIP,
  pluginRelayedToolName,
  pluginServerKey,
  pluginToolNameFits,
  resolvePluginMcpBindings,
} from './pluginMcp.js';

const file = (path: string, content: unknown) => ({
  bytes: Buffer.from(JSON.stringify(content)),
  mode: '100644' as const,
  path,
});
const http = (url: string) => ({ type: 'http', url });

/** A profile whose plugins are `plugins/<dir>`, each declaring `servers` inline. */
function profile(
  plugins: Record<string, { name: string; servers: Record<string, unknown> }>,
  version = 3
) {
  return {
    commitSha: 'abc',
    contentHash: 'f'.repeat(64),
    files: Object.entries(plugins).map(([dir, p]) =>
      file(`plugins/${dir}/.claude-plugin/plugin.json`, { mcpServers: p.servers, name: p.name })
    ),
    hooksEnabled: true,
    hooksLive: true,
    hooksPinned: true,
    manifest: {
      description: 'd',
      instructions: 'INSTRUCTIONS.md',
      name: 'kit',
      plugins: Object.keys(plugins).map((dir) => `plugins/${dir}`),
    },
    name: 'kit',
    version,
  } as never;
}

const single = (servers: Record<string, unknown>) => profile({ a: { name: 'acme', servers } });

const tracer = () => {
  const events: { name: string; outputJson: unknown }[] = [];
  return {
    addActivityEvent: (e: { name: string; outputJson: unknown }) => events.push(e),
    events,
  };
};

const connection = (over: Record<string, unknown> = {}) => ({
  isActive: true,
  shares: [],
  teamId: 'team-1',
  type: 'mcp',
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.readPin.mockResolvedValue(undefined);
  h.connectionFind.mockResolvedValue(connection());
  h.target.mockImplementation(async (id: string) => ({ url: `https://${id}.example/mcp` }));
});

describe('resolvePluginMcpBindings', () => {
  it('relays nothing, and says nothing, when no server is mapped', async () => {
    h.mappingFind.mockResolvedValue([]);
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [single({ docs: http('https://docs.example/mcp') })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out).toEqual([]);
    expect(t.events).toEqual([]);
    expect(h.connectionFind).not.toHaveBeenCalled();
  });

  it('binds a mapped, declared, supported server, named by plugin and server', async () => {
    h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'docs' }]);
    const out = await resolvePluginMcpBindings({
      profiles: [single({ docs: http('https://docs.example/mcp') })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: tracer(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      connectionId: 'c1',
      key: 'acme_docs',
      plugin: 'acme',
      server: 'docs',
      target: { url: 'https://c1.example/mcp' },
    });
  });

  it('ignores a mapping whose server the pinned snapshot does not declare', async () => {
    h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'gone' }]);
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [single({ docs: http('https://docs.example/mcp') })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out).toEqual([]);
    expect(t.events).toEqual([
      {
        name: 'agent.plugin_mcp_skipped',
        outputJson: { plugin: 'kit', reason: PLUGIN_MCP_SKIP.notDeclared, server: 'gone' },
      },
    ]);
    expect(h.connectionFind).not.toHaveBeenCalled();
  });

  it('skips a declared server that is not an HTTP one', async () => {
    h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'local' }]);
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [single({ local: { command: 'node' } })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out).toEqual([]);
    expect(t.events[0]?.outputJson).toEqual({
      plugin: 'acme',
      reason: 'server not supported',
      server: 'local',
    });
  });

  it('skips a server name two plugins of the profile both declare', async () => {
    h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'docs' }]);
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [
        profile({
          a: { name: 'one', servers: { docs: http('https://a.example/') } },
          b: { name: 'two', servers: { docs: http('https://b.example/') } },
        }),
      ],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out).toEqual([]);
    expect(t.events[0]?.outputJson).toMatchObject({
      reason: 'server name is ambiguous',
      server: 'docs',
    });
  });

  it('skips a connection that is missing, not an mcp connection, or inactive', async () => {
    h.mappingFind.mockResolvedValue([
      { connectionId: 'c1', serverName: 'a' },
      { connectionId: 'c2', serverName: 'b' },
      { connectionId: 'c3', serverName: 'c' },
    ]);
    h.connectionFind
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(connection({ type: 'github' }))
      .mockResolvedValueOnce(connection({ isActive: false }));
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [
        single({
          a: http('https://a.example/'),
          b: http('https://b.example/'),
          c: http('https://c.example/'),
        }),
      ],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out).toEqual([]);
    expect(t.events.map((e) => (e.outputJson as { reason: string }).reason)).toEqual([
      'connection missing',
      'connection missing',
      'connection inactive',
    ]);
    expect(h.target).not.toHaveBeenCalled();
  });

  it('holds a mapped connection to the agent binding’s rule: another team’s is skipped unread', async () => {
    h.mappingFind.mockResolvedValue([
      { connectionId: 'own', serverName: 'a' },
      { connectionId: 'foreign', serverName: 'b' },
    ]);
    h.connectionFind.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'foreign' ? connection({ teamId: 'team-2' }) : connection()
    );
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [single({ a: http('https://a.example/'), b: http('https://b.example/') })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out.map((b) => b.connectionId)).toEqual(['own']);
    expect(t.events).toEqual([
      {
        name: 'agent.plugin_mcp_skipped',
        outputJson: { plugin: 'acme', reason: PLUGIN_MCP_SKIP.notAllowed, server: 'b' },
      },
    ]);
    // The credential of the refused connection is never read.
    expect(h.target).toHaveBeenCalledTimes(1);
    expect(h.target).toHaveBeenCalledWith('own');
  });

  it('refuses every connection of a run with no team and no template', async () => {
    h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'a' }]);
    const out = await resolvePluginMcpBindings({
      profiles: [single({ a: http('https://a.example/') })],
      toolKeys: null,
      tracer: tracer(),
    });
    expect(out).toEqual([]);
  });

  it('skips the later of two servers that would share a harness name', async () => {
    // `a-b` + `c` and `a` + `b_c` both reduce to a_b_c.
    h.mappingFind.mockResolvedValue([
      { connectionId: 'c1', serverName: 'c' },
      { connectionId: 'c2', serverName: 'b_c' },
    ]);
    const t = tracer();
    const out = await resolvePluginMcpBindings({
      profiles: [
        profile({
          x: { name: 'a-b', servers: { c: http('https://x.example/') } },
          y: { name: 'a', servers: { b_c: http('https://y.example/') } },
        }),
      ],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(out.map((b) => b.server)).toEqual(['c']);
    expect(t.events[0]?.outputJson).toEqual({
      plugin: 'a',
      reason: 'server name is ambiguous',
      server: 'b_c',
    });
    expect(h.target).toHaveBeenCalledTimes(1);
  });

  it('applies the run’s guard to each target and drops one it refuses', async () => {
    h.mappingFind.mockResolvedValue([
      { connectionId: 'c1', serverName: 'a' },
      { connectionId: 'c2', serverName: 'b' },
    ]);
    const guard = vi.fn(async (target: { url: string }) =>
      target.url.includes('c2') ? null : Object.assign(target, { guarded: true })
    );
    const out = await resolvePluginMcpBindings({
      guard: guard as never,
      profiles: [single({ a: http('https://a.example/'), b: http('https://b.example/') })],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: tracer(),
    });
    expect(out.map((b) => b.connectionId)).toEqual(['c1']);
    expect(out[0]?.target).toMatchObject({ guarded: true });
  });

  it('puts no address or secret in any event', async () => {
    h.mappingFind.mockResolvedValue([
      { connectionId: 'c1', serverName: 'a' },
      { connectionId: 'c2', serverName: 'gone' },
      { connectionId: 'c3', serverName: 'b' },
    ]);
    h.connectionFind.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'c3' ? connection({ teamId: 'other' }) : connection()
    );
    const t = tracer();
    await resolvePluginMcpBindings({
      profiles: [
        single({ a: http('https://secret.example/mcp?k=1'), b: http('https://b.example/') }),
      ],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: t,
    });
    expect(t.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.events)).not.toMatch(/https?:|secret|example/);
  });

  describe('pinning', () => {
    const rows = [
      { connectionId: 'c1', serverName: 'a' },
      { connectionId: 'c2', serverName: 'b' },
    ];
    const prof = () => single({ a: http('https://a.example/'), b: http('https://b.example/') });
    const pinned = (mcp: string[] | undefined, version = 3) => ({
      pin: { mcp, verified: new Set(), version },
      runId: 'exec-1',
      workflowId: 'wf-1',
    });
    const run = async () =>
      (
        await resolvePluginMcpBindings({
          profiles: [prof()],
          tenant: { teamId: 'team-1' },
          toolKeys: null,
          tracer: tracer(),
        })
      ).map((b) => b.connectionId);

    beforeEach(() => {
      h.mappingFind.mockResolvedValue(rows);
    });

    it('relays the pinned pairs intersected with the live mappings: none is gained mid-run', async () => {
      h.readPin.mockResolvedValue(pinned(['a=c1']));
      expect(await run()).toEqual(['c1']);
      expect(h.pin).not.toHaveBeenCalled();
    });

    it('stops relaying a pair whose mapping was removed, or re-pointed, at once', async () => {
      h.readPin.mockResolvedValue(pinned(['a=c1', 'b=c2']));
      h.mappingFind.mockResolvedValue([{ connectionId: 'c1', serverName: 'a' }]);
      expect(await run()).toEqual(['c1']);
      // `b` now maps to c9, which this run never pinned.
      h.mappingFind.mockResolvedValue([
        { connectionId: 'c1', serverName: 'a' },
        { connectionId: 'c9', serverName: 'b' },
      ]);
      expect(await run()).toEqual(['c1']);
    });

    it('gains no server key when a second server is mapped to an already pinned connection', async () => {
      h.readPin.mockResolvedValue(pinned(['a=c1']));
      h.mappingFind.mockResolvedValue([
        { connectionId: 'c1', serverName: 'a' },
        { connectionId: 'c1', serverName: 'b' },
      ]);
      const out = await resolvePluginMcpBindings({
        profiles: [prof()],
        tenant: { teamId: 'team-1' },
        toolKeys: null,
      });
      expect(out.map((b) => b.key)).toEqual(['acme_a']);
    });

    it('treats a pin without the set as "pin the live pairs now", and uses what was recorded', async () => {
      h.readPin.mockResolvedValue(pinned(undefined));
      h.pin.mockResolvedValue({ hooks: true, mcp: ['a=c1'], version: 3 });
      expect(await run()).toEqual(['c1']);
      expect(h.pin).toHaveBeenCalledWith('wf-1', 'kit', 3, {
        mcpPins: ['a=c1', 'b=c2'],
        runId: 'exec-1',
      });
    });

    it('reads an id-only (damaged) pin as empty: nothing is relayed, and nothing is rewritten', async () => {
      // parsePinEntry turns any entry without the `<name>=<id>` shape into an empty list.
      h.readPin.mockResolvedValue(pinned([]));
      expect(await run()).toEqual([]);
      expect(h.pin).not.toHaveBeenCalled();
    });

    it('relays nothing, and says so, when the pin cannot be read', async () => {
      h.readPin.mockRejectedValue(new Error('db down'));
      const t = tracer();
      const out = await resolvePluginMcpBindings({
        profiles: [prof()],
        tenant: { teamId: 'team-1' },
        toolKeys: null,
        tracer: t,
      });
      expect(out).toEqual([]);
      expect(t.events).toEqual([
        {
          name: 'agent.plugin_mcp_skipped',
          outputJson: { plugin: 'kit', reason: 'pin could not be read', server: '*' },
        },
      ]);
      expect(h.connectionFind).not.toHaveBeenCalled();
    });

    it('uses the live set when the run cannot pin (no entry, another version, a failed write)', async () => {
      h.readPin.mockResolvedValue(undefined);
      expect(await run()).toEqual(['c1', 'c2']);
      h.readPin.mockResolvedValue(pinned(['a=c1'], 2));
      expect(await run()).toEqual(['c1', 'c2']);
      h.readPin.mockResolvedValue(pinned(undefined));
      h.pin.mockRejectedValue(new Error('cas'));
      expect(await run()).toEqual(['c1', 'c2']);
    });

    it('relays nothing for a damaged (empty) pin', async () => {
      h.readPin.mockResolvedValue(pinned([]));
      expect(await run()).toEqual([]);
    });
  });

  describe('the mcp tool gate', () => {
    const rows = [{ connectionId: 'c1', serverName: 'docs' }];
    const attempt = async (toolKeys: string[] | null | undefined) => {
      h.mappingFind.mockResolvedValue(rows);
      h.mappingCount.mockResolvedValue(1);
      const t = tracer();
      const out = await resolvePluginMcpBindings({
        profiles: [single({ docs: http('https://docs.example/mcp') })],
        tenant: { teamId: 'team-1' },
        toolKeys: toolKeys as string[] | null,
        tracer: t,
      });
      return { events: t.events, out };
    };

    it.each([
      ['a list without mcp', ['readFile', 'bash']],
      ['a list naming only browser', ['browser']],
    ])('binds nothing for %s, reads no connection, and says so once', async (_n, keys) => {
      const { events, out } = await attempt(keys);
      expect(out).toEqual([]);
      expect(h.mappingFind).not.toHaveBeenCalled();
      expect(h.connectionFind).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          name: 'agent.plugin_mcp_skipped',
          outputJson: { plugin: 'kit', reason: PLUGIN_MCP_SKIP.mcpNotEnabled, server: '*' },
        },
      ]);
      expect(PLUGIN_MCP_SKIP.mcpNotEnabled).toBe('mcp tool not enabled for the agent');
    });

    it('treats an omitted toolKeys (undefined) as closed, never as all tools', async () => {
      const { events, out } = await attempt(undefined);
      expect(out).toEqual([]);
      expect(h.connectionFind).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          name: 'agent.plugin_mcp_skipped',
          outputJson: { plugin: 'kit', reason: PLUGIN_MCP_SKIP.mcpNotEnabled, server: '*' },
        },
      ]);
    });

    it('says nothing when the gate withholds and no server is mapped', async () => {
      h.mappingCount.mockResolvedValue(0);
      const t = tracer();
      await resolvePluginMcpBindings({
        profiles: [single({ docs: http('https://docs.example/mcp') })],
        toolKeys: ['bash'],
        tracer: t,
      });
      expect(t.events).toEqual([]);
    });

    it.each([
      ['a list naming mcp', ['readFile', 'mcp']],
      ['null (all tools, as the Agent’s own connection reads it)', null],
      ['an empty list', []],
    ])('binds for %s', async (_n, keys) => {
      const { out } = await attempt(keys as string[] | null | undefined);
      expect(out).toHaveLength(1);
    });
  });
});

describe('harness names', () => {
  it('builds a stable key from plugin and server, within the length the tools need', () => {
    expect(pluginServerKey('acme', 'docs')).toBe('acme_docs');
    expect(pluginServerKey('My Plugin!', 'srv.one')).toBe('My_Plugin_srv_one');
    const long = pluginServerKey('a-very-long-plugin-name', 'an-even-longer-server-name');
    expect(long.length).toBeLessThanOrEqual(24);
    expect(long).toBe(pluginServerKey('a-very-long-plugin-name', 'an-even-longer-server-name'));
    expect(long).not.toBe(pluginServerKey('a-very-long-plugin-name', 'an-even-longer-server-nam2'));
    expect(pluginRelayedToolName('acme_docs', 'lookup')).toBe('mcp__acme_docs__lookup');
  });

  it('never equals a key the run’s other MCP servers use', () => {
    // A plugin and server that slug to something containing a separator cannot be `connection`.
    expect(pluginServerKey('connection', 'x')).toBe('connection_x');
    expect(pluginServerKey('', '')).toBe('plugin_server');
  });

  it('offers only tools whose full harness name is plain and fits the API limit', () => {
    expect(pluginToolNameFits('acme_docs', 'lookup')).toBe(true);
    expect(pluginToolNameFits('acme_docs', 'has.dot')).toBe(false);
    expect(pluginToolNameFits('acme_docs', 'with space')).toBe(false);
    expect(pluginToolNameFits('acme_docs', '')).toBe(false);
    expect(pluginToolNameFits('acme_docs', 'x'.repeat(60))).toBe(false);
    expect(pluginToolNameFits('k', 'x'.repeat(56))).toBe(true);
    expect(pluginToolNameFits('k', 'x'.repeat(57))).toBe(false);
  });
});
