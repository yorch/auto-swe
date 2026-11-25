import { createHash } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { declaredPluginMcpServers } from '@auto-swe/shared/lib/harnessProfile';
import {
  BROWSER_MCP_SERVER,
  MCP_RELAY_SERVER,
  WORKER_MCP_SERVER,
} from '../../agents/claudeCode/policy.js';
import { KNOWLEDGE_MCP_SERVER } from '../../agents/knowledgeSearchBindings.js';
import type { McpTracer } from '../../agents/mcpTools.js';
import { isMcpToolEnabled } from '../../agents/mcpTools.js';
import { logWarn } from '../activityLog.js';
import { type AgentConnectionTenant, agentMayUseConnection } from '../connectionAccess.js';
import {
  pinHarnessProfile,
  type ResolvedHarnessProfile,
  readHarnessPin,
} from './harnessProfile.js';
import { type McpConnectionTarget, mcpUrlForConnection } from './mcpConnection.js';
import { mcpPinPair } from './pluginEnablement.js';

/**
 * Why a plugin's mapped MCP server is not relayed on a run. Fixed strings: an event never carries
 * a database or parser message, a URL or a credential.
 */
export const PLUGIN_MCP_SKIP = {
  ambiguous: 'server name is ambiguous',
  inactive: 'connection inactive',
  mcpNotEnabled: 'mcp tool not enabled for the agent',
  missing: 'connection missing',
  notAllowed: 'connection not allowed for the run',
  notDeclared: 'server not declared',
  pinUnreadable: 'pin could not be read',
  unsupported: 'server not supported',
} as const;

export type PluginMcpSkipReason = (typeof PLUGIN_MCP_SKIP)[keyof typeof PLUGIN_MCP_SKIP];

/** `mcp__<key>__<tool>` must stay within the model API's tool-name limit. */
export const MAX_RELAYED_TOOL_NAME = 64;
/** The most of the name a server key may take, leaving room for the tools' own names. */
const MAX_SERVER_KEY = 24;

/** Server keys the run's other MCP servers already use. */
const RESERVED_SERVER_KEYS: ReadonlySet<string> = new Set([
  MCP_RELAY_SERVER,
  BROWSER_MCP_SERVER,
  KNOWLEDGE_MCP_SERVER,
  WORKER_MCP_SERVER,
]);

const slug = (text: string) => text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * The harness server name a plugin's server is relayed under: `<plugin>_<server>` reduced to
 * letters, digits and underscores, with a hash of the exact pair standing in for the tail of a
 * name that does not fit. The tools are then `mcp__<key>__<tool>`, which never equals a tool of
 * the Agent's own connection (`mcp__connection__*`) or of another server.
 */
export function pluginServerKey(plugin: string, server: string): string {
  const base = `${slug(plugin) || 'plugin'}_${slug(server) || 'server'}`;
  if (base.length <= MAX_SERVER_KEY) {
    return base;
  }
  const hash = createHash('sha256').update(`${plugin}\0${server}`).digest('hex').slice(0, 6);
  return `${base.slice(0, MAX_SERVER_KEY - 7)}-${hash}`;
}

/** The name the harness calls a plugin server's tool by. */
export function pluginRelayedToolName(key: string, tool: string): string {
  return `mcp__${key}__${tool}`;
}

/**
 * Whether a remote tool can be offered under `key`: its own name is plain and the full harness
 * name fits the API limit. A tool that fails is not relayed (it could never be allowed by name).
 */
export function pluginToolNameFits(key: string, tool: string): boolean {
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(tool) &&
    pluginRelayedToolName(key, tool).length <= MAX_RELAYED_TOOL_NAME
  );
}

/** One plugin MCP server the run may relay, its connection target resolved. */
export interface PluginMcpBinding {
  plugin: string;
  /** The server's name in the plugin's declaration. */
  server: string;
  /** The harness server name ({@link pluginServerKey}). */
  key: string;
  connectionId: string;
  target: McpConnectionTarget;
}

/** What a run supplies so its plugins' mapped connections are held to the rules its own is. */
export interface PluginMcpRun {
  /**
   * The resolved Agent's `toolKeys`, REQUIRED so no caller can leave the gate out. Plugin servers
   * are bound only where the Agent's own connection would be ({@link isMcpToolEnabled}: `null` or
   * empty means every tool, MCP included; a list must name `'mcp'`). The key being omitted at
   * run time (a caller that bypassed the types) reads as closed, never as open.
   */
  toolKeys: readonly string[] | null;
  /** What a mapped connection is checked against: the same tenant the agent's own connection is. */
  tenant?: AgentConnectionTenant;
  /**
   * Applied to each resolved target, as the run applies it to the agent's own (an orchestration's
   * approval guard). Returning null drops the server.
   */
  guard?: (
    target: McpConnectionTarget
  ) => McpConnectionTarget | null | Promise<McpConnectionTarget | null>;
}

export interface ResolvePluginMcpArgs extends PluginMcpRun {
  profiles: readonly ResolvedHarnessProfile[];
  tracer?: Pick<McpTracer, 'addActivityEvent'>;
}

interface Eligible {
  plugin: string;
  server: string;
  connectionId: string;
}

/**
 * The plugin MCP servers this activity relays, for the profiles a Claude Code run was given.
 *
 * A mapping (`PluginMcpMapping`, one per profile and server name) counts only while the pinned
 * snapshot still declares its server, the server is a supported one (HTTP) and its name is not
 * declared by two plugins of the profile. The set of mapped connection ids is pinned in the run's
 * pin beside the plugin's version, at first use, and the set an activity relays is the pinned set INTERSECTED with the live mappings: a run
 * never gains a connection mid-run, while a removed mapping or connection stops being relayed at
 * once. Each remaining connection must be an active `mcp` Connection that
 * {@link agentMayUseConnection} allows the run's tenant, the rule the agent's own
 * `mcpConnectionId` is held to.
 *
 * Anything unusable is skipped with an `agent.plugin_mcp_skipped` event and never fails the run.
 */
export async function resolvePluginMcpBindings(
  args: ResolvePluginMcpArgs
): Promise<PluginMcpBinding[]> {
  const out: PluginMcpBinding[] = [];
  // Omitted (undefined) is closed; only an explicit null (or the empty list) means "all tools".
  const gateOpen =
    args.toolKeys !== undefined &&
    isMcpToolEnabled(args.toolKeys ? [...args.toolKeys] : args.toolKeys);
  if (!gateOpen) {
    // Quiet: one fixed-string event, and only where a mapping exists that this withholds.
    try {
      const mapped = await prisma.pluginMcpMapping.count({
        where: { profile: { name: { in: args.profiles.map((p) => p.name) } } },
      });
      if (mapped > 0) {
        args.tracer?.addActivityEvent({
          name: 'agent.plugin_mcp_skipped',
          outputJson: {
            plugin: args.profiles[0]?.name,
            reason: PLUGIN_MCP_SKIP.mcpNotEnabled,
            server: '*',
          },
        });
      }
    } catch {
      // The gate holds whether or not the count can be read.
    }
    return out;
  }
  const usedKeys = new Set<string>();
  const skip = (plugin: string, server: string, reason: PluginMcpSkipReason) =>
    args.tracer?.addActivityEvent({
      name: 'agent.plugin_mcp_skipped',
      outputJson: { plugin, reason, server },
    });

  for (const profile of args.profiles) {
    let eligible: Eligible[];
    try {
      eligible = await eligibleMappings(profile, skip);
    } catch {
      // Best effort, like every MCP binding: the plugin still runs without its servers.
      logWarn('plugin MCP mappings could not be read; continuing without them', {
        profile: profile.name,
      });
      continue;
    }

    const pinned = await pinnedPairs(
      profile,
      eligible.map((e) => mcpPinPair(e.server, e.connectionId))
    );
    if (!pinned) {
      if (eligible.length > 0) {
        skip(profile.name, '*', PLUGIN_MCP_SKIP.pinUnreadable);
      }
      continue;
    }
    for (const entry of eligible.filter((e) => pinned.has(mcpPinPair(e.server, e.connectionId)))) {
      // Before the connection is read: a name that cannot be told apart never reads a credential.
      const key = pluginServerKey(entry.plugin, entry.server);
      if (RESERVED_SERVER_KEYS.has(key) || usedKeys.has(key)) {
        skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.ambiguous);
        continue;
      }
      const resolved = await usableTarget(entry, args.tenant, skip);
      if (!resolved) {
        continue;
      }
      const target = args.guard ? await args.guard(resolved) : resolved;
      if (!target) {
        continue;
      }
      usedKeys.add(key);
      out.push({
        connectionId: entry.connectionId,
        key,
        plugin: entry.plugin,
        server: entry.server,
        target,
      });
    }
  }
  return out;
}

/** The profile's live mappings whose server the pinned snapshot declares as a usable one. */
async function eligibleMappings(
  profile: ResolvedHarnessProfile,
  skip: (plugin: string, server: string, reason: PluginMcpSkipReason) => void
): Promise<Eligible[]> {
  const rows = await prisma.pluginMcpMapping.findMany({
    orderBy: { serverName: 'asc' },
    select: { connectionId: true, serverName: true },
    where: { profile: { name: profile.name } },
  });
  if (rows.length === 0) {
    return [];
  }
  const declared = declaredPluginMcpServers(profile.files, profile.manifest).servers;
  const out: Eligible[] = [];
  for (const row of rows) {
    const matches = declared.filter((s) => s.name === row.serverName);
    const first = matches[0];
    if (!first) {
      skip(profile.name, row.serverName, PLUGIN_MCP_SKIP.notDeclared);
    } else if (matches.some((s) => s.duplicate)) {
      skip(first.plugin, row.serverName, PLUGIN_MCP_SKIP.ambiguous);
    } else if (!first.supported) {
      skip(first.plugin, row.serverName, PLUGIN_MCP_SKIP.unsupported);
    } else {
      out.push({ connectionId: row.connectionId, plugin: first.plugin, server: row.serverName });
    }
  }
  return out;
}

/**
 * The server=connection pairs this run pinned for the plugin; the live ones when the run cannot pin
 * (no run row, another execution's pin, a caller-supplied version) or a first pin cannot be
 * written. A pin that cannot be READ (a transient error) yields null: the activity relays nothing
 * rather than a live set that may include a connection mapped after the run began.
 */
async function pinnedPairs(
  profile: ResolvedHarnessProfile,
  live: readonly string[]
): Promise<Set<string> | null> {
  let current: Awaited<ReturnType<typeof readHarnessPin>>;
  try {
    current = await readHarnessPin(profile.name);
  } catch {
    return null;
  }
  if (!current || current.pin.version !== profile.version) {
    return new Set(live);
  }
  if (current.pin.mcp !== undefined) {
    return new Set(current.pin.mcp);
  }
  try {
    const pinned = await pinHarnessProfile(current.workflowId, profile.name, profile.version, {
      mcpPins: live,
      runId: current.runId,
    });
    return new Set(pinned.mcp ?? live);
  } catch {
    // Unpinnable now: this activity relays the live pairs (no pin existed to be widened), and the
    // next one tries again.
    return new Set(live);
  }
}

/** The connection's target when it is an active `mcp` Connection the run's tenant may use. */
async function usableTarget(
  entry: Eligible,
  tenant: AgentConnectionTenant | undefined,
  skip: (plugin: string, server: string, reason: PluginMcpSkipReason) => void
): Promise<McpConnectionTarget | null> {
  let connection: { isActive: boolean; type: string } | null;
  try {
    connection = await prisma.connection.findUnique({
      select: { isActive: true, type: true },
      where: { id: entry.connectionId },
    });
  } catch {
    skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.missing);
    return null;
  }
  if (connection?.type !== 'mcp') {
    skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.missing);
    return null;
  }
  if (!connection.isActive) {
    skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.inactive);
    return null;
  }
  // The agent's own binding rule; its credential is not read for a connection this refuses.
  if ((await agentMayUseConnection(entry.connectionId, tenant)) !== 'allowed') {
    skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.notAllowed);
    return null;
  }
  const target = await mcpUrlForConnection(entry.connectionId);
  if (!target) {
    skip(entry.plugin, entry.server, PLUGIN_MCP_SKIP.missing);
    return null;
  }
  return target;
}
