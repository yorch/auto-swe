import { describe, expect, it } from 'vitest';
import { declaredPluginMcpServers, PLUGIN_MCP_UNREADABLE } from './pluginMcp.js';

const f = (path: string, content: unknown) => ({
  bytes: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
  mode: '100644',
  path,
});
const manifest = { plugins: ['plugins/a'] };
const http = (url: string) => ({ type: 'http', url });

describe('declaredPluginMcpServers', () => {
  it('reads .mcp.json in both shapes', () => {
    const a = declaredPluginMcpServers(
      [f('plugins/a/.mcp.json', { mcpServers: { docs: http('https://m.example/mcp') } })],
      manifest
    );
    expect(a.servers).toEqual([
      {
        duplicate: false,
        name: 'docs',
        plugin: 'a',
        supported: true,
        transport: 'http',
        url: 'https://m.example/mcp',
      },
    ]);
    const b = declaredPluginMcpServers(
      [f('plugins/a/.mcp.json', { docs: http('https://m.example/mcp') })],
      manifest
    );
    expect(b.servers.map((s) => s.name)).toEqual(['docs']);
  });

  it('reads inline mcpServers of plugin.json and uses its name', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.claude-plugin/plugin.json', {
          mcpServers: { inl: http('https://i.example/x'), loc: { command: 'node' } },
          name: 'named',
        }),
      ],
      manifest
    );
    expect(r.servers.map((s) => [s.plugin, s.name, s.transport, s.supported])).toEqual([
      ['named', 'inl', 'http', true],
      ['named', 'loc', 'stdio', false],
    ]);
  });

  it('reads a string path, and refuses one that leaves the plugin', () => {
    const files = [
      f('plugins/a/.claude-plugin/plugin.json', { mcpServers: './cfg/mcp.json' }),
      f('plugins/a/cfg/mcp.json', { mcpServers: { s: http('https://s.example/') } }),
      f('plugins/other.json', { mcpServers: { evil: http('https://e.example/') } }),
    ];
    expect(declaredPluginMcpServers(files, manifest).servers.map((s) => s.name)).toEqual(['s']);
    for (const bad of ['../other.json', '/etc/x', 'a/../../other.json', 'missing.json']) {
      const r = declaredPluginMcpServers(
        [f('plugins/a/.claude-plugin/plugin.json', { mcpServers: bad }), files[2] as never],
        manifest
      );
      expect(r.servers).toEqual([]);
      expect(r.unreadable[0]?.reason).toBe(PLUGIN_MCP_UNREADABLE.missing);
    }
  });

  it('merges both sources, listing a name once per plugin', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.mcp.json', { x: http('https://file.example/') }),
        f('plugins/a/.claude-plugin/plugin.json', {
          mcpServers: { x: http('https://inline.example/'), y: http('https://y.example/') },
        }),
      ],
      manifest
    );
    expect(r.servers.map((s) => [s.name, s.url, s.duplicate])).toEqual([
      ['x', 'https://file.example/', false],
      ['y', 'https://y.example/', false],
    ]);
  });

  it('flags a name two plugins declare', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.mcp.json', {
          dup: http('https://1.example/'),
          only: http('https://2.example/'),
        }),
        f('plugins/b/.mcp.json', { dup: http('https://3.example/') }),
      ],
      { plugins: ['plugins/a', 'plugins/b'] }
    );
    expect(r.servers.map((s) => [s.plugin, s.name, s.duplicate])).toEqual([
      ['a', 'dup', true],
      ['a', 'only', false],
      ['b', 'dup', true],
    ]);
  });

  it('reports hostile or broken files without throwing', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.mcp.json', '{not json'),
        f('plugins/a/.claude-plugin/plugin.json', '\u0000\u0001'),
        {
          bytes: Buffer.from([0xff, 0xfe]),
          mode: '100644',
          path: 'plugins/b/.mcp.json',
        },
        f('plugins/c/.mcp.json', '[1,2,{"a":1}]'),
        f('plugins/d/.mcp.json', {
          __proto__: 1,
          constructor: { type: 'http', url: 'https://c.example/' },
        }),
      ],
      { plugins: ['plugins/a', 'plugins/b', 'plugins/c', 'plugins/d', '../../x', ''] }
    );
    expect(r.unreadable.map((u) => [u.plugin, u.reason])).toContainEqual([
      'a',
      PLUGIN_MCP_UNREADABLE.invalid,
    ]);
    expect(r.unreadable.map((u) => u.plugin)).toContain('b');
    expect(r.servers.map((s) => s.name)).toEqual(['constructor']);
  });

  it('strips credentials, query and fragment from urls', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.claude-plugin/plugin.json', {
          mcpServers: { s: http('https://u:pw@h.example/p?token=SECRET#frag') },
        }),
      ],
      manifest
    );
    expect(r.servers[0]?.url).toBe('https://h.example/p');
    expect(JSON.stringify(r)).not.toMatch(/SECRET|pw@/);
  });

  it('marks sse and non-http urls unsupported', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.mcp.json', {
          bad: { type: 'http', url: 'ftp://x.example/' },
          s: { type: 'sse', url: 'https://s.example/' },
        }),
      ],
      manifest
    );
    expect(r.servers.map((s) => [s.name, s.supported])).toEqual([
      ['bad', false],
      ['s', false],
    ]);
  });

  it('does not read author or repository objects of plugin.json as servers', () => {
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.claude-plugin/plugin.json', {
          author: { name: 'x', url: 'https://x.example/' },
          mcpServers: '.claude-plugin/plugin.json',
          repository: { type: 'git', url: 'https://g.example/r' },
        }),
      ],
      manifest
    );
    expect(r.servers).toEqual([]);
  });

  it('flags names that collide after sanitising, and maps none of them', () => {
    const long = 'n'.repeat(90);
    const r = declaredPluginMcpServers(
      [
        f('plugins/a/.mcp.json', {
          mcpServers: {
            [`${long}1`]: http('https://a.example/'),
            [`${long}2`]: http('https://b.example/'),
            ok: http('https://e.example/'),
            'x\u200by': http('https://c.example/'),
            'x\u200cy': http('https://d.example/'),
          },
        }),
      ],
      manifest
    );
    expect(r.servers.filter((s) => !s.duplicate).map((s) => s.name)).toEqual(['ok']);
    expect(r.servers).toHaveLength(5);
  });
});
