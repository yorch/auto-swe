import { keyed } from '@/components/harnessProfiles/profileDisplay';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import type { PluginMcpServer } from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';

/**
 * The MCP servers a plugin's `.mcp.json` declares. They are dependencies, not connections: the
 * harness does not load the plugin's own `.mcp.json`. An http server can be reached through an
 * existing `mcp` Connection; a stdio server cannot be supported.
 */
export function McpServersList({ servers }: { servers: PluginMcpServer[] }) {
  if (servers.length === 0) {
    return <p className="text-xs text-paper-500">The plugin declares no MCP servers.</p>;
  }
  const keys = keyed(servers.map((s) => s.name));
  return (
    <div className="space-y-2">
      <ul className="space-y-1 text-sm">
        {servers.map((s, i) => (
          <li className="flex flex-wrap items-center gap-2" key={keys[i]?.key ?? s.name}>
            <span className="font-mono text-xs text-paper-200">{visibleText(s.name)}</span>
            <Badge tone="neutral" variant="outline">
              {s.transport}
            </Badge>
            {s.url && (
              <span className="font-mono text-xs text-paper-400 break-all">
                {visibleText(s.url)}
              </span>
            )}
            <Badge dot tone={s.supported ? 'success' : 'danger'}>
              {s.supported ? 'Supported' : 'Unsupported'}
            </Badge>
          </li>
        ))}
      </ul>
      <Alert announce={false} variant="info">
        An admin must point the agent’s existing MCP connection at a matching <code>mcp</code>{' '}
        Connection for each supported server; approving the plugin does not connect it. Servers
        marked unsupported (stdio) are not available.
      </Alert>
    </div>
  );
}
