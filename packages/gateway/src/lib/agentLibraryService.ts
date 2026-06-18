import type { PrismaClient } from '@auto-swe/shared';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';

/**
 * Agent-library service (P1): create / version / list the first-class Agent
 * entity, with the same injection/exfiltration prompt scan + isVerified reset
 * as the skill library. Editing a base field cuts a NEW version row (prior
 * versions stay active so run-start pins keep resolving them); the active
 * Agent for a key+scope is the highest version. RBAC + audit-log writes stay
 * with the routes; this layer is scope-key parameterized.
 */

export type AgentRow = NonNullable<Awaited<ReturnType<PrismaClient['agent']['findFirst']>>>;

export type AgentScope = 'GLOBAL' | 'TEAM' | 'WORKFLOW_TEMPLATE';

/** Identifies one Agent lineage: a key at a scope. Versions live underneath. */
export interface AgentScopeKey {
  key: string;
  scope: AgentScope;
  teamId?: string | null;
  workflowTemplateId?: string | null;
}

export interface SkillRefInput {
  skillId: string;
  sortOrder: number;
}

export interface AgentBaseInput {
  name?: string;
  description?: string | null;
  modelSpec?: string | null;
  systemPrompt?: string | null;
  inheritsModelFrom?: string | null;
  /** null = no tool override (use AgentToolConfig); [] = explicitly no tools. */
  toolKeys?: string[] | null;
  credentialId?: string | null;
  /** P2/WS3: the `mcp` Connection whose tools bind when toolKeys includes 'mcp'. */
  mcpConnectionId?: string | null;
  /** Ordered list of skills to attach. undefined = keep current; null/[] = clear. */
  skillRefs?: SkillRefInput[] | null;
}

function scopeWhere(key: AgentScopeKey) {
  return {
    key: key.key,
    scope: key.scope,
    teamId: key.scope === 'TEAM' ? (key.teamId ?? null) : null,
    workflowTemplateId: key.scope === 'WORKFLOW_TEMPLATE' ? (key.workflowTemplateId ?? null) : null,
  };
}

/** Highest existing version for a key+scope (0 when the lineage is new). */
async function maxVersion(prisma: PrismaClient, key: AgentScopeKey): Promise<number> {
  const top = await prisma.agent.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
    where: scopeWhere(key),
  });
  return top?.version ?? 0;
}

/** Validate that referenced scope rows (team / template) exist. */
export async function validateAgentScopeRefs(
  prisma: PrismaClient,
  args: { teamId?: string | null; workflowTemplateId?: string | null }
): Promise<string | null> {
  if (args.teamId) {
    const team = await prisma.team.findUnique({ select: { id: true }, where: { id: args.teamId } });
    if (!team) {
      return 'Team not found';
    }
  }
  if (args.workflowTemplateId) {
    const tpl = await prisma.workflowTemplate.findUnique({
      select: { id: true },
      where: { id: args.workflowTemplateId },
    });
    if (!tpl) {
      return 'Workflow template not found';
    }
  }
  return null;
}

/**
 * Validate an Agent's `mcpConnectionId` reference (P2/WS3): it must point at an
 * active `mcp`-type Connection. TEAM-scoped agents may only reference their own
 * team's connection (tenancy); GLOBAL / WORKFLOW_TEMPLATE agents are admin-owned
 * and may reference any. Returns an error message or null.
 */
export async function validateMcpConnectionRef(
  prisma: PrismaClient,
  mcpConnectionId: string | null | undefined,
  scopeKey: { scope: AgentScope; teamId?: string | null }
): Promise<string | null> {
  if (!mcpConnectionId) {
    return null;
  }
  const conn = await prisma.connection.findUnique({
    select: { id: true, isActive: true, teamId: true, type: true },
    where: { id: mcpConnectionId },
  });
  if (!conn?.isActive) {
    return 'MCP connection not found or inactive';
  }
  if (conn.type !== 'mcp') {
    return 'Referenced connection is not an mcp connection';
  }
  if (scopeKey.scope === 'TEAM' && scopeKey.teamId && conn.teamId !== scopeKey.teamId) {
    return 'MCP connection belongs to a different team';
  }
  return null;
}
export async function listAgents(
  prisma: PrismaClient,
  filter: { scope?: AgentScope; teamId?: string; workflowTemplateId?: string; latestOnly?: boolean }
): Promise<AgentRow[]> {
  const rows = await prisma.agent.findMany({
    include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
    where: {
      ...(filter.scope && { scope: filter.scope }),
      ...(filter.teamId && { teamId: filter.teamId }),
      ...(filter.workflowTemplateId && { workflowTemplateId: filter.workflowTemplateId }),
    },
  });
  if (filter.latestOnly === false) {
    return rows;
  }
  // Keep the first (highest-version) row per key+scope lineage.
  const seen = new Set<string>();
  const latest: AgentRow[] = [];
  for (const r of rows) {
    const lineage = `${r.key}:${r.scope}:${r.teamId ?? ''}:${r.workflowTemplateId ?? ''}`;
    if (!seen.has(lineage)) {
      seen.add(lineage);
      latest.push(r);
    }
  }
  return latest;
}

/**
 * Create the first version of a new Agent lineage. Scans the system prompt
 * (custom content) and starts unverified. Throws if the lineage already exists
 * (the caller should 409) — overriding an existing lineage is {@link updateAgent}.
 */
export async function createAgent(
  prisma: PrismaClient,
  key: AgentScopeKey,
  base: AgentBaseInput & { name: string },
  actorId: string
): Promise<{ agent: AgentRow; scanWarnings: string[] }> {
  if ((await maxVersion(prisma, key)) > 0) {
    throw new AgentLineageExistsError(key.key, key.scope);
  }
  const scan = base.systemPrompt ? await scanSkillContent(base.systemPrompt) : { warnings: [] };
  const agentBase = await prisma.agent.create({
    data: {
      createdById: actorId,
      credentialId: base.credentialId ?? null,
      description: base.description ?? null,
      inheritsModelFrom: base.inheritsModelFrom ?? null,
      isActive: true,
      isBuiltIn: false,
      isVerified: false,
      key: key.key,
      mcpConnectionId: base.mcpConnectionId ?? null,
      modelSpec: base.modelSpec ?? null,
      name: base.name,
      origin: null,
      scope: key.scope,
      systemPrompt: base.systemPrompt ?? null,
      teamId: scopeWhere(key).teamId,
      toolKeys: base.toolKeys ?? undefined,
      version: 1,
      workflowTemplateId: scopeWhere(key).workflowTemplateId,
    },
  });
  for (const ref of base.skillRefs ?? []) {
    await prisma.agentSkillRef.create({
      data: { agentId: agentBase.id, skillId: ref.skillId, sortOrder: ref.sortOrder },
    });
  }
  const agent = await prisma.agent.findUniqueOrThrow({
    include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
    where: { id: agentBase.id },
  });
  return { agent, scanWarnings: scan.warnings };
}

/**
 * Cut a new version of an existing Agent, merging `base` over the current row.
 * Prior versions are retained (run-start pins keep resolving them). Re-scans the
 * system prompt and resets isVerified when the prompt is provided.
 */
export async function updateAgent(
  prisma: PrismaClient,
  current: AgentRow,
  base: AgentBaseInput,
  actorId: string
): Promise<{ agent: AgentRow; scanWarnings: string[] }> {
  const key: AgentScopeKey = {
    key: current.key,
    scope: current.scope as AgentScope,
    teamId: current.teamId,
    workflowTemplateId: current.workflowTemplateId,
  };
  const nextVersion = (await maxVersion(prisma, key)) + 1;
  const promptChanged = base.systemPrompt !== undefined;
  const scan =
    promptChanged && base.systemPrompt
      ? await scanSkillContent(base.systemPrompt)
      : { warnings: [] };

  const pick = <T>(next: T | undefined, prev: T): T => (next === undefined ? prev : next);

  // Determine skill refs for the new version: caller-supplied list, or copy from current.
  let refsToCreate: SkillRefInput[];
  if (base.skillRefs !== undefined) {
    refsToCreate = base.skillRefs ?? [];
  } else {
    const currentRefs = await prisma.agentSkillRef.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { skillId: true, sortOrder: true },
      where: { agentId: current.id },
    });
    refsToCreate = currentRefs;
  }

  const agentBase = await prisma.agent.create({
    data: {
      createdById: actorId,
      credentialId: pick(base.credentialId, current.credentialId),
      description: pick(base.description, current.description),
      inheritsModelFrom: pick(base.inheritsModelFrom, current.inheritsModelFrom),
      isActive: true,
      isBuiltIn: current.isBuiltIn,
      // A prompt edit drops verification (mirrors the skill library); an
      // unchanged prompt keeps the prior verification state.
      isVerified: promptChanged ? false : current.isVerified,
      key: current.key,
      mcpConnectionId: pick(base.mcpConnectionId, current.mcpConnectionId),
      modelSpec: pick(base.modelSpec, current.modelSpec),
      name: pick(base.name, current.name),
      origin: current.origin,
      scope: current.scope,
      systemPrompt: pick(base.systemPrompt, current.systemPrompt),
      teamId: current.teamId,
      toolKeys:
        base.toolKeys === undefined
          ? (current.toolKeys ?? undefined)
          : (base.toolKeys ?? undefined),
      version: nextVersion,
      workflowTemplateId: current.workflowTemplateId,
    },
  });
  for (const ref of refsToCreate) {
    await prisma.agentSkillRef.create({
      data: { agentId: agentBase.id, skillId: ref.skillId, sortOrder: ref.sortOrder },
    });
  }
  const agent = await prisma.agent.findUniqueOrThrow({
    include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
    where: { id: agentBase.id },
  });
  return { agent, scanWarnings: scan.warnings };
}

/**
 * Soft-delete an Agent lineage: deactivate every version at the key+scope so
 * resolveAgent stops finding it and falls through to the legacy config cascade.
 */
export async function deactivateAgentLineage(
  prisma: PrismaClient,
  key: AgentScopeKey
): Promise<number> {
  const res = await prisma.agent.updateMany({
    data: { isActive: false },
    where: scopeWhere(key),
  });
  return res.count;
}

/** Thrown by {@link createAgent} when the key+scope lineage already exists. */
export class AgentLineageExistsError extends Error {
  constructor(key: string, scope: string) {
    super(`An agent with key '${key}' already exists at scope ${scope}`);
    this.name = 'AgentLineageExistsError';
  }
}
