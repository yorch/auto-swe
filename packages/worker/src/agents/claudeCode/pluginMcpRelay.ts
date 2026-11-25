import { type PluginMcpBinding, pluginToolNameFits } from '../../lib/config/pluginMcp.js';
import { type McpRelay, openMcpRelay } from '../harness/mcpRelay.js';
import type { McpTracer } from '../mcpTools.js';

/** A plugin's mapped connection, opened for the run. */
export interface OpenedPluginRelay {
  plugin: string;
  server: string;
  /** The harness server name its tools are served under. */
  key: string;
  connectionId: string;
  relay: McpRelay;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'\\]+/gi;

// Fixed patterns (no RegExp is built from the URL): an IPv4 literal or a bracketed IPv6 literal
// with an optional port, any other `host:port`, and a bare IPv6 literal (two or more colons).
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6_BRACKETED = /\[[0-9a-fA-F:.]*:[0-9a-fA-F:.]*\](?::\d{1,5})?/g;
const IPV6_BARE = /(?<![0-9A-Za-z:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![0-9A-Za-z:])/g;
const HOST_PORT = /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*:\d{1,5}\b/g;

/** Text with the connection's endpoint (its URL, then any URL, its host, or an address) replaced. */
export function scrubEndpoint(text: string, url: string): string {
  let out = text.split(url).join('[endpoint]');
  try {
    const { host, hostname } = new URL(url);
    for (const name of [host, hostname]) {
      if (name) {
        out = out.split(name).join('[endpoint]');
      }
    }
  } catch {
    // An unparseable ref is already refused by the relay.
  }
  return out
    .replace(URL_IN_TEXT, '[endpoint]')
    .replace(IPV6_BRACKETED, '[endpoint]')
    .replace(IPV4, '[endpoint]')
    .replace(IPV6_BARE, '[endpoint]')
    .replace(HOST_PORT, '[endpoint]');
}

/** A value safe to put in the audit line's `key=value` text: `[A-Za-z0-9_.:-]`, capped. */
export function safeAuditValue(value: string, max = 64): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, max);
}

/**
 * The relay's own events name the connection's URL (`mcpServerRef`), which is right for the
 * Agent's own connection and not for a plugin's: a plugin's events are read by people who do not
 * administer the connection. This keeps the events and replaces what identifies the endpoint with
 * the plugin and server names.
 */
function withoutEndpoint(
  tracer: Pick<McpTracer, 'addActivityEvent' | 'addToolCall'> | undefined,
  binding: PluginMcpBinding
): McpTracer | undefined {
  if (!tracer) {
    return undefined;
  }
  const url = binding.target.url;
  const clean = (text: string) => scrubEndpoint(text, url);
  return {
    addActivityEvent: (event) =>
      tracer.addActivityEvent({
        ...event,
        ...(event.error !== undefined ? { error: clean(event.error) } : {}),
        inputJson: { plugin: binding.plugin, server: binding.server },
        ...(event.outputJson !== undefined
          ? { outputJson: JSON.parse(clean(JSON.stringify(event.outputJson))) as unknown }
          : {}),
      }),
    addToolCall: (call) => tracer.addToolCall(call),
  };
}

/**
 * Opens the relay of each binding, with the Agent's-own-connection code
 * ({@link openMcpRelay}: allowlist, screening, audit log, timeouts, approval guard). A connection
 * that cannot be reached is left out, as for the Agent's own. Records `agent.plugin_mcp` once per
 * plugin that has a server bound: the servers and how many tools each offers, never an endpoint.
 */
export async function openPluginMcpRelays(
  bindings: readonly PluginMcpBinding[],
  tracer: Pick<McpTracer, 'addActivityEvent' | 'addToolCall'> | undefined
): Promise<OpenedPluginRelay[]> {
  const opened = await Promise.all(
    bindings.map(async (binding) => {
      let withheld = 0;
      const relay = await openMcpRelay(binding.target, withoutEndpoint(tracer, binding), {
        acceptTool: (name) => {
          const fits = pluginToolNameFits(binding.key, name);
          if (!fits) {
            withheld += 1;
          }
          return fits;
        },
        thirdParty: {
          label: `plugin=${safeAuditValue(binding.plugin)} server=${safeAuditValue(binding.server)}`,
          scrub: (text) => scrubEndpoint(text, binding.target.url),
        },
      });
      return relay ? { binding, relay, withheld } : null;
    })
  );
  const bound = opened.filter((o): o is NonNullable<typeof o> => o !== null);

  const byPlugin = new Map<string, typeof bound>();
  for (const entry of bound) {
    byPlugin.set(entry.binding.plugin, [...(byPlugin.get(entry.binding.plugin) ?? []), entry]);
  }
  for (const [plugin, entries] of byPlugin) {
    tracer?.addActivityEvent({
      name: 'agent.plugin_mcp',
      outputJson: {
        plugin,
        servers: entries.map(({ binding, relay, withheld }) => ({
          connectionId: binding.connectionId,
          server: binding.server,
          tools: relay.tools.length,
          ...(withheld > 0 ? { withheldTools: withheld } : {}),
        })),
      },
    });
  }
  return bound.map(({ binding, relay }) => ({
    connectionId: binding.connectionId,
    key: binding.key,
    plugin: binding.plugin,
    relay,
    server: binding.server,
  }));
}
