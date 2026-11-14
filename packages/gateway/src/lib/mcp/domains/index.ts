import type { McpToolDeps, ToolKit } from '../toolKit.js';
import { deliveryDomain } from './delivery.js';
import { teamsDomain } from './teams.js';
import { workDomain } from './work.js';

/**
 * The tools beyond the original eight, grouped by what they are about. A domain lists each tool it
 * registers with the one REST route behind it, so three things can be checked against one record:
 * `tools/list` shows exactly these names, the real route table opts in exactly these routes with
 * `config.mcpScope`, and the docs name each tool. Adding a tool without declaring it here fails
 * `tools.test.ts`, and so does declaring one whose route never opted in.
 */

/** Who the underlying route is meant for. The route's own role gate is what enforces it. */
export type ToolTier = 'user' | 'lead' | 'admin';

export interface DomainTool {
  name: string;
  tier: ToolTier;
  /** `METHOD /api/v1/path/:param`, exactly as Fastify registers it. */
  route: string;
  /** Other mounts of the same plugin that therefore carry the same `mcpScope`. */
  aliasRoutes?: readonly string[];
}

export interface McpDomain {
  name: string;
  tools: readonly DomainTool[];
  register(kit: ToolKit, deps: McpToolDeps): void;
}

export const MCP_DOMAINS: readonly McpDomain[] = [deliveryDomain, teamsDomain, workDomain];

const allTools = MCP_DOMAINS.flatMap((d) => d.tools);

/** Every domain tool name, sorted. */
export const DOMAIN_TOOL_NAMES: readonly string[] = allTools.map((t) => t.name).sort();

/** Every `mcpScope: 'read'` route the domains rely on, with the aliases that share it. */
export const DOMAIN_READ_ROUTES: readonly string[] = [
  ...new Set(allTools.flatMap((t) => [t.route, ...(t.aliasRoutes ?? [])])),
].sort();
