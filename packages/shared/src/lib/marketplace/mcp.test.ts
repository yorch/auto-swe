import { describe, expect, it } from 'vitest';
import { mcpWarnings, pluginMcpServers } from './mcp.js';

const read = (v: unknown) => pluginMcpServers(Buffer.from(JSON.stringify(v)));

describe('pluginMcpServers', () => {
  it('lists http as supported and stdio as unsupported, in both file shapes', () => {
    const wrapped = read({
      mcpServers: {
        docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
        local: { args: ['--token', 'secret'], command: 'node', env: { K: 'v' } },
      },
    });
    expect(wrapped).toEqual([
      { name: 'docs', supported: true, transport: 'http', url: 'https://mcp.example.com/mcp' },
      { name: 'local', supported: false, transport: 'stdio', url: null },
    ]);
    expect(read({ docs: { url: 'https://mcp.example.com/mcp' } })).toEqual([
      { name: 'docs', supported: true, transport: 'http', url: 'https://mcp.example.com/mcp' },
    ]);
  });

  it('never returns credentials, query strings or commands', () => {
    const out = JSON.stringify(
      read({
        a: {
          headers: { Authorization: 'Bearer SECRET' },
          type: 'http',
          url: 'https://u:pw@h.example/p?token=SECRET#f',
        },
        b: { args: ['SECRET'], command: 'SECRET' },
      })
    );
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('pw');
    expect(out).toContain('https://h.example/p');
  });

  it('flags sse and an http server with a bad URL as unsupported', () => {
    expect(
      read({
        a: { type: 'sse', url: 'https://x.example/sse' },
        b: { type: 'http', url: 'ftp://x' },
      })
    ).toEqual([
      { name: 'a', supported: false, transport: 'sse', url: null },
      { name: 'b', supported: false, transport: 'http', url: null },
    ]);
  });

  it('returns nothing for text that is not a JSON object', () => {
    expect(pluginMcpServers(Buffer.from('nope'))).toEqual([]);
    expect(pluginMcpServers(Buffer.from('[]'))).toEqual([]);
  });
});

describe('mcpWarnings', () => {
  it('warns once per unsupported server and once for the http dependencies', () => {
    const w = mcpWarnings(
      read({ a: { type: 'http', url: 'https://x.example/m' }, b: { command: 'x' } })
    );
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('b (stdio) is not supported');
    expect(w[1]).toContain('platform administrator can map them');
  });
  it('is empty without servers', () => {
    expect(mcpWarnings([])).toEqual([]);
  });
});
