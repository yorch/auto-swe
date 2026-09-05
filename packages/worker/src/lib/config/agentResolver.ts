import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { parseProviderModelSpec } from '../providerUtils.js';
import { ConfigMissingError, resolveProviderCredential } from './resolver.js';
import type { ResolveCtx, ResolvedModelConfig, ResolvedSkill } from './types.js';

/**
 * The effective configuration of an Agent, resolved from the first-class `Agent`
 * entity — the single source of truth (P1.5). Shape matches the raw pieces
 * `resolveAgentSpec` composes: a resolved model (spec + credential + optional
 * base prompt override), ordered skills, and the enabled tool keys (`null` = no
 * override → all candidate tools).
 */
export interface ResolvedAgent {
  key: string;
  version: number;
  isVerified: boolean;
  origin: string | null;
  model: ResolvedModelConfig;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
  /** P2/WS3: the `mcp` Connection whose tools to bind when `toolKeys` includes 'mcp'. */
  mcpConnectionId: string | null;
}

/** Coerce the nullable JSON `toolKeys` column into `string[] | null`. */
function parseToolKeys(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

export type AgentRow = NonNullable<Awaited<ReturnType<typeof fetchActiveAgent>>>;

/**
 * Most-specific active Agent row for `key`: WORKFLOW_TEMPLATE → CHANNEL → TEAM →
 * ORGANIZATION → GLOBAL, highest `version` at the first scope that has a row.
 * Returns null when no Agent row exists for the key. The CHANNEL tier only fires
 * when `ctx.channelId` is set, and the ORGANIZATION tier only when `ctx.orgId` is
 * present, so existing TEAM/GLOBAL behavior is intact.
 *
 * When the run carries a version pin for `key` (`ctx.agentVersions`), the pin
 * applies to the GLOBAL row only: it was snapshotted from the GLOBAL lineage at
 * run start (`createWorkflowRun`), and a version number is meaningless across
 * lineages — TEAM v1 is not "older" than GLOBAL v2. Applying it at every tier
 * silently defeated every scoped override whose version happened to differ. So
 * a scoped override still wins and resolves its latest active version; a run
 * that falls through to GLOBAL is frozen at the pinned version.
 *
 * Exported so the skill/tool shims can read an Agent row without forcing model
 * + credential resolution.
 */
export async function fetchActiveAgent(key: string, ctx?: ResolveCtx) {
  const include = {
    skillRefs: { include: { skill: true }, orderBy: { sortOrder: 'asc' as const } },
  };
  const pinnedVersion = ctx?.agentVersions?.[key];
  const versionClause = pinnedVersion !== undefined ? { version: pinnedVersion } : {};
  const orderBy = { version: 'desc' as const };

  if (ctx?.workflowTemplateId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: {
        isActive: true,
        key,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.channelId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { channelId: ctx.channelId, isActive: true, key, scope: 'CHANNEL' },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.teamId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { isActive: true, key, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.orgId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { isActive: true, key, orgId: ctx.orgId, scope: 'ORGANIZATION' },
    });
    if (row) {
      return row;
    }
  }

  return prisma.agent.findFirst({
    include,
    orderBy,
    where: { isActive: true, key, scope: 'GLOBAL', ...versionClause },
  });
}

/** Map an Agent row's skillRefs to ResolvedSkills (ordered by sortOrder). */
export function skillsFromAgent(agent: AgentRow): ResolvedSkill[] {
  return agent.skillRefs
    .filter((ref) => ref.skill.isActive)
    .map((ref) => ({
      description: ref.skill.description ?? '',
      id: ref.skill.id,
      isVerified: ref.skill.isVerified,
      name: ref.skill.name,
      promptText: ref.skill.promptText,
      sortOrder: ref.sortOrder,
    }));
}

/**
 * Resolve the model + credential for an Agent. Follows `inheritsModelFrom` to
 * the ancestor Agent that actually carries a `modelSpec` (sub-reviewer/decomposer
 * personas inherit their model from a parent role). Throws `ConfigMissingError`
 * when no `modelSpec` is reachable.
 */
async function resolveModelForAgent(
  agent: AgentRow,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  let source: AgentRow = agent;
  const seen = new Set<string>();
  while (!source.modelSpec && source.inheritsModelFrom) {
    if (seen.has(source.key)) {
      break; // cycle guard
    }
    seen.add(source.key);
    const parent = await fetchActiveAgent(source.inheritsModelFrom, ctx);
    if (!parent) {
      throw new ConfigMissingError(
        `Agent '${source.key}' inherits its model from '${source.inheritsModelFrom}', but no active agent with that key exists.`
      );
    }
    source = parent;
  }
  if (!source.modelSpec) {
    throw new ConfigMissingError(
      `Agent '${agent.key}' has no model: set a modelSpec (or an inheritsModelFrom chain that resolves one) at /admin/agents/library.`
    );
  }
  const spec = source.modelSpec;
  const { provider } = parseProviderModelSpec(spec);
  const cred = await resolveProviderCredential(provider, ctx);
  return {
    apiBase: cred.apiBase,
    apiKey: cred.apiKey,
    scope: agent.scope,
    spec,
    systemPrompt: agent.systemPrompt ?? undefined,
  };
}

/**
 * Resolve an Agent by key into its effective configuration. The `Agent` entity
 * is the sole source of truth (P1.5) — model from `modelSpec`/`inheritsModelFrom`,
 * skills from `skillRefs`, tools from `toolKeys`. Throws `ConfigMissingError`
 * when the agent (or its model) is absent.
 */
export async function resolveAgent(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  // The whole version-pin map is part of the cache key, not just this key's
  // pin: an `inheritsModelFrom` chain resolves the PARENT under the same ctx,
  // so two canary arms pinning different parent versions would otherwise share
  // one entry for the child within the TTL.
  const pins = stablePins(ctx?.agentVersions);
  const cacheKey = `agent:${key}:${ctx?.workflowTemplateId ?? ''}:${ctx?.channelId ?? ''}:${ctx?.teamId ?? ''}:${ctx?.orgId ?? ''}:${pins}`;
  return withCache(cacheKey, configCacheTtlMs(), () => resolveAgentUncached(key, ctx));
}

/** Key-sorted JSON of the pin map, so insertion order cannot split the cache. */
function stablePins(pins: Record<string, number> | undefined): string {
  if (!pins) {
    return '';
  }
  return JSON.stringify(
    Object.keys(pins)
      .sort()
      .map((k) => [k, pins[k]])
  );
}

async function resolveAgentUncached(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  const agent = await fetchActiveAgent(key, ctx);
  if (!agent) {
    throw new ConfigMissingError(
      `No active Agent found for key '${key}' at any scope. Create it at /admin/agents/library.`
    );
  }

  const model = await resolveModelForAgent(agent, ctx);

  return {
    isVerified: agent.isVerified,
    key,
    mcpConnectionId: agent.mcpConnectionId ?? null,
    model,
    origin: agent.origin ?? null,
    skills: skillsFromAgent(agent),
    toolKeys: parseToolKeys(agent.toolKeys),
    version: agent.version,
  };
}
