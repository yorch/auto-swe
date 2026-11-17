import type { McpToolDeps, ToolKit } from '../toolKit.js';
import { deliveryDomain } from './delivery.js';
import { libraryDomain } from './library.js';
import { orchestrationsDomain } from './orchestrations.js';
import { reportsDomain } from './reports.js';
import { runEvidenceDomain } from './runEvidence.js';
import { teamsDomain } from './teams.js';
import { workDomain } from './work.js';

/**
 * The tools beyond the original eight, grouped by what they are about. A domain lists each tool it
 * registers with the one REST route behind it, so three things can be checked against one record:
 * `tools/list` shows exactly these names, the real route table opts in exactly these routes with
 * `config.mcpScope` (`admin` for the admin tier, `read` for the rest), and the docs name each tool. Adding a tool without declaring it here fails
 * `tools.test.ts`, and so does declaring one whose route never opted in.
 */

/**
 * Who the underlying route is meant for. The route's own role gate is what enforces it; the
 * `admin` tier is additionally registered only for a caller holding `mcp:admin`.
 */
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

export const MCP_DOMAINS: readonly McpDomain[] = [
  deliveryDomain,
  libraryDomain,
  orchestrationsDomain,
  reportsDomain,
  runEvidenceDomain,
  teamsDomain,
  workDomain,
];

const allTools = MCP_DOMAINS.flatMap((d) => d.tools);

/** Every domain tool name, sorted. */
export const DOMAIN_TOOL_NAMES: readonly string[] = allTools.map((t) => t.name).sort();

const routesOf = (tools: readonly DomainTool[]): readonly string[] =>
  [...new Set(tools.flatMap((t) => [t.route, ...(t.aliasRoutes ?? [])]))].sort();

/**
 * The admin-tier tools. They exist only for a caller holding `mcp:admin`, and the routes behind
 * them opt in with `mcpScope: 'admin'`. This one declaration is what registration reads.
 */
export const ADMIN_TOOL_NAMES: readonly string[] = allTools
  .filter((t) => t.tier === 'admin')
  .map((t) => t.name)
  .sort();

/** Every domain tool a plain `mcp:read` caller sees: the user and lead tiers. */
export const NON_ADMIN_TOOL_NAMES: readonly string[] = allTools
  .filter((t) => t.tier !== 'admin')
  .map((t) => t.name)
  .sort();

/** Every `mcpScope: 'read'` route the user and lead tools rely on, with the aliases that share it. */
export const DOMAIN_READ_ROUTES: readonly string[] = routesOf(
  allTools.filter((t) => t.tier !== 'admin')
);

/** Every `mcpScope: 'admin'` route, with the aliases that share it. */
export const DOMAIN_ADMIN_ROUTES: readonly string[] = routesOf(
  allTools.filter((t) => t.tier === 'admin')
);
