import { HIDDEN_CHARACTERS } from '../skillSource/display.js';
import type { PluginMcpServer } from './types.js';

const MAX_SERVERS = 50;

const shown = (s: string, max: number) => {
  const clean = s.replace(HIDDEN_CHARACTERS, '?');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

/** Origin and path only: a declared URL can carry a token in its userinfo or query. */
function bareUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return null;
    }
    return shown(`${u.protocol}//${u.host}${u.pathname}`, 300);
  } catch {
    return null;
  }
}

/**
 * The MCP servers a plugin's `.mcp.json` declares, as declared dependencies.
 *
 * The harness never loads a plugin's `.mcp.json` (`skipMcpDiscovery` plus the strict MCP
 * configuration), so nothing here is wired up. An administrator points the agent's existing
 * `mcpConnectionId` at an `mcp` Connection that matches an `http` server; a `stdio` (or `sse`)
 * server is flagged unsupported. There is no mapping table. Both accepted file shapes are read:
 * `{ "mcpServers": { name: {...} } }` and `{ name: {...} }`. Returns `[]` for a file that is not
 * JSON. Never returns commands, arguments, headers or environment values.
 */
export function pluginMcpServers(bytes: Buffer): PluginMcpServer[] {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return [];
  }
  const root = json as Record<string, unknown>;
  const servers =
    root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : root;
  const out: PluginMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers).slice(0, MAX_SERVERS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const s = raw as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type.toLowerCase() : null;
    const transport: PluginMcpServer['transport'] =
      type === 'sse' ? 'sse' : type === 'http' || (type === null && 'url' in s) ? 'http' : 'stdio';
    const url = transport === 'http' ? bareUrl(s.url) : null;
    out.push({
      name: shown(name, 80),
      supported: transport === 'http' && url !== null,
      transport,
      url,
    });
  }
  return out;
}

/** Warnings for the approval list: one per unsupported server, one for the http dependencies. */
export function mcpWarnings(servers: readonly PluginMcpServer[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    if (!s.supported) {
      out.push(
        `plugin MCP server ${s.name} (${s.transport}) is not supported and will not be available`
      );
    }
  }
  if (servers.some((s) => s.supported)) {
    out.push(
      'plugin declares HTTP MCP servers; the harness does not load them, so an administrator must point the agent mcpConnectionId at a matching mcp Connection'
    );
  }
  return out;
}
