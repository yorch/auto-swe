import type { PrismaClient } from '@auto-swe/shared';
import { isAnthropicSpec, parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  type ImplementerRuntimeKind,
  runtimeModelError,
  toImplementerRuntime,
} from '@auto-swe/shared/types/api';
import { BUILTIN_PROVIDERS } from './credentialService.js';
import { catalogWarnings } from './modelCatalogService.js';
import { scanSkillAdvisory } from './skillScan.js';

/**
 * Agent-library service (P1): create / version / list the first-class Agent
 * entity, with the same injection/exfiltration prompt scan + isVerified reset
 * as the skill library. Editing a base field cuts a NEW version row (prior
 * versions stay active so run-start pins keep resolving them); the active
 * Agent for a key+scope is the highest version. RBAC + audit-log writes stay
 * with the routes; this layer is scope-key parameterized.
 */

export type AgentRow = NonNullable<Awaited<ReturnType<PrismaClient['agent']['findFirst']>>>;

export type AgentScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'CHANNEL' | 'WORKFLOW_TEMPLATE';

/** Identifies one Agent lineage: a key at a scope. Versions live underneath. */
export interface AgentScopeKey {
  key: string;
  scope: AgentScope;
  teamId?: string | null;
  orgId?: string | null;
  channelId?: string | null;
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
  /**
   * The loop that drives this agent where it works in a workspace. null = no
   * opinion (the run-wide `workspace.implementerRuntime` for the implementer
   * family, Mastra for agent runs). Platform-ADMIN only: the routes enforce it.
   */
  runtime?: ImplementerRuntimeKind | null;
}

export { runtimeModelError };

/** The runtime and model a version would end up with after merging `base` over `current`. */
export function mergedRuntimeAndModel(
  current: {
    inheritsModelFrom?: string | null;
    modelSpec: string | null;
    runtime: string | null;
  } | null,
  base: Pick<AgentBaseInput, 'inheritsModelFrom' | 'modelSpec' | 'runtime'>
): { inheritsModelFrom: string | null; modelSpec: string | null; runtime: string | null } {
  return {
    inheritsModelFrom:
      base.inheritsModelFrom === undefined
        ? (current?.inheritsModelFrom ?? null)
        : base.inheritsModelFrom,
    modelSpec: base.modelSpec === undefined ? (current?.modelSpec ?? null) : base.modelSpec,
    runtime: base.runtime === undefined ? (current?.runtime ?? null) : base.runtime,
  };
}

type AgentReader = Pick<PrismaClient, 'agent'>;

/**
 * The model an agent that names none resolves to platform-wide: the active
 * GLOBAL rows along `inheritsModelFrom`, from `from`. `null` when the chain is
 * broken or loops — a run fails on that where it resolves the agent.
 */
export async function inheritedModelSpec(
  prisma: AgentReader,
  from: string | null
): Promise<string | null> {
  const seen = new Set<string>();
  let key = from;
  while (key && !seen.has(key)) {
    seen.add(key);
    const row = await prisma.agent.findFirst({
      orderBy: { version: 'desc' },
      select: { inheritsModelFrom: true, modelSpec: true },
      where: { isActive: true, key, scope: 'GLOBAL' },
    });
    if (!row) {
      return null;
    }
    if (row.modelSpec) {
      return row.modelSpec;
    }
    key = row.inheritsModelFrom;
  }
  return null;
}

/**
 * Why a version may not be saved with its runtime, or `null`: the harness
 * drives only an Anthropic model, so its own model must be one — and when it
 * names none, the model it inherits along the platform-wide chain. A scoped
 * override of the parent, which only a run's scope selects, is checked when a
 * run resolves it (`HARNESS_UNSUPPORTED_MODEL`).
 */
export async function runtimeSaveError(
  prisma: AgentReader,
  version: { inheritsModelFrom: string | null; modelSpec: string | null; runtime: string | null }
): Promise<string | null> {
  const own = runtimeModelError(version.runtime, version.modelSpec);
  if (own || version.runtime !== 'claude-code' || version.modelSpec || !version.inheritsModelFrom) {
    return own;
  }
  const inherited = await inheritedModelSpec(prisma, version.inheritsModelFrom);
  if (!inherited || isAnthropicSpec(inherited)) {
    return null;
  }
  return `The claude-code runtime needs an Anthropic model, but this agent inherits '${inherited}' from '${version.inheritsModelFrom}'. Give it an anthropic/<model> of its own, or set the runtime to mastra.`;
}

/**
 * The runtime a new scoped override starts with when its writer names none:
 * the platform-wide row's, so an override of an agent an ADMIN put on the
 * harness stays on it — a team admin, who cannot set a runtime, would
 * otherwise move it back to the default without meaning to. An override whose
 * own model the harness cannot drive starts with none instead.
 */
export async function defaultOverrideRuntime(
  prisma: AgentReader,
  key: Pick<AgentScopeKey, 'key' | 'scope'>,
  version: { inheritsModelFrom: string | null; modelSpec: string | null }
): Promise<ImplementerRuntimeKind | null> {
  if (key.scope === 'GLOBAL') {
    return null;
  }
  const global = await prisma.agent.findFirst({
    orderBy: { version: 'desc' },
    select: { runtime: true },
    where: { isActive: true, key: key.key, scope: 'GLOBAL' },
  });
  const runtime = toImplementerRuntime(global?.runtime);
  if (!runtime || (await runtimeSaveError(prisma, { ...version, runtime }))) {
    return null;
  }
  return runtime;
}

/**
 * Advisory notes for saving `key` with `modelSpec`: the active agents, at any
 * scope, that run on the harness and would inherit that model through it
 * (directly, or through agents that name no model of their own). A model the
 * harness cannot drive breaks them where a run resolves them; nothing is
 * refused here, because the agent being saved is valid on its own.
 */
export async function inheritingHarnessWarnings(
  prisma: AgentReader,
  key: string,
  modelSpec: string | null,
  /**
   * Whose agents the caller may see named: a team admin's save lists only the
   * platform-wide agents and their own team's. Omitted for a platform ADMIN.
   */
  visibleToTeam?: string
): Promise<string[]> {
  if (!modelSpec || isAnthropicSpec(modelSpec)) {
    return [];
  }
  const warnings: string[] = [];
  const seen = new Set<string>([key]);
  let frontier = [key];
  while (frontier.length > 0) {
    const heirs = await runUnscoped(
      'heirs at every scope inherit the model; a team admin sees only GLOBAL rows and their own team’s',
      ['Agent'],
      () =>
        prisma.agent.findMany({
          select: { key: true, runtime: true, scope: true },
          where: {
            inheritsModelFrom: { in: frontier },
            isActive: true,
            modelSpec: null,
            ...(visibleToTeam
              ? {
                  OR: [
                    { scope: 'GLOBAL' as const },
                    { scope: 'TEAM' as const, teamId: visibleToTeam },
                  ],
                }
              : {}),
          },
        })
    );
    frontier = [];
    for (const heir of heirs) {
      if (heir.runtime === 'claude-code') {
        warnings.push(
          `agent '${heir.key}' (${heir.scope}) runs on claude-code and would inherit '${modelSpec}' from '${key}', which the harness cannot drive.`
        );
      }
      if (!seen.has(heir.key)) {
        seen.add(heir.key);
        frontier.push(heir.key);
      }
    }
  }
  return warnings;
}

function scopeWhere(key: AgentScopeKey) {
  return {
    channelId: key.scope === 'CHANNEL' ? (key.channelId ?? null) : null,
    key: key.key,
    orgId: key.scope === 'ORGANIZATION' ? (key.orgId ?? null) : null,
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
  args: {
    teamId?: string | null;
    orgId?: string | null;
    channelId?: string | null;
    workflowTemplateId?: string | null;
  }
): Promise<string | null> {
  if (args.channelId) {
    const channel = await prisma.slackChannel.findUnique({
      select: { id: true },
      where: { id: args.channelId },
    });
    if (!channel) {
      return 'Slack channel not found';
    }
  }
  if (args.teamId) {
    const team = await prisma.team.findUnique({ select: { id: true }, where: { id: args.teamId } });
    if (!team) {
      return 'Team not found';
    }
  }
  if (args.orgId) {
    const org = await prisma.organization.findUnique({
      select: { id: true },
      where: { id: args.orgId },
    });
    if (!org) {
      return 'Organization not found';
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
/**
 * Validate an Agent's `credentialId` pin: the credential must exist, belong to
 * the provider the agent's model spec routes to (when the agent carries its own
 * spec — an inheriting persona's provider is only known at run time), and be
 * one the agent's scope may spend. TEAM agents may pin GLOBAL credentials, their
 * own team's, or their team's organization's; ORGANIZATION agents GLOBAL or
 * their own org's. GLOBAL / CHANNEL / WORKFLOW_TEMPLATE agents are admin-owned
 * and may pin any — the worker still uses a pin only where the run's own team
 * or org can reach it. Returns an error message or null.
 */
export async function validateCredentialRef(
  prisma: PrismaClient,
  credentialId: string | null | undefined,
  modelSpec: string | null | undefined,
  scopeKey: { scope: AgentScope; teamId?: string | null; orgId?: string | null }
): Promise<string | null> {
  if (!credentialId) {
    return null;
  }
  const cred = await prisma.providerCredential.findUnique({
    select: { orgId: true, provider: true, scope: true, teamId: true },
    where: { id: credentialId },
  });
  if (!cred) {
    return 'Credential not found';
  }
  const provider = modelSpec ? providerOfSpec(modelSpec) : null;
  if (provider && cred.provider.toLowerCase() !== provider) {
    return `Credential is for provider '${cred.provider}', but the model spec routes to '${provider}'`;
  }
  if (cred.scope === 'GLOBAL') {
    return null;
  }
  if (scopeKey.scope === 'TEAM') {
    if (cred.scope === 'TEAM') {
      return cred.teamId === scopeKey.teamId ? null : 'Credential belongs to a different team';
    }
    const team = scopeKey.teamId
      ? await prisma.team.findUnique({ select: { orgId: true }, where: { id: scopeKey.teamId } })
      : null;
    return team?.orgId && team.orgId === cred.orgId
      ? null
      : 'Credential belongs to an organization this team is not in';
  }
  if (scopeKey.scope === 'ORGANIZATION') {
    return cred.scope === 'ORGANIZATION' && cred.orgId === scopeKey.orgId
      ? null
      : 'Credential belongs to a different organization or team';
  }
  return null;
}

/** The provider a spec routes to, as the worker parses it; null for a malformed spec. */
function providerOfSpec(spec: string): string | null {
  try {
    return parseProviderModelSpec(spec).provider;
  } catch {
    return null;
  }
}

export async function listAgents(
  prisma: PrismaClient,
  filter: {
    scope?: AgentScope;
    teamId?: string;
    orgId?: string;
    channelId?: string;
    workflowTemplateId?: string;
    latestOnly?: boolean;
  }
): Promise<AgentRow[]> {
  const rows = await prisma.agent.findMany({
    include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
    where: {
      ...(filter.scope && { scope: filter.scope }),
      ...(filter.teamId && { teamId: filter.teamId }),
      ...(filter.orgId && { orgId: filter.orgId }),
      ...(filter.channelId && { channelId: filter.channelId }),
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
    const lineage = `${r.key}:${r.scope}:${r.teamId ?? ''}:${r.orgId ?? ''}:${r.channelId ?? ''}:${r.workflowTemplateId ?? ''}`;
    if (!seen.has(lineage)) {
      seen.add(lineage);
      latest.push(r);
    }
  }
  return latest;
}

/**
 * Catalog warnings for the model an agent version runs. An agent that inherits
 * its model from a parent names none, so it has nothing to warn about.
 */
async function agentCatalogWarnings(
  prisma: PrismaClient,
  agent: { modelSpec: string | null }
): Promise<string[]> {
  return agent.modelSpec ? catalogWarnings(prisma, agent.modelSpec, 'CHAT') : [];
}

/**
 * Advisory warnings for an agent version whose own model no run could call: no
 * credential for its provider is reachable from the agent's scope, or the only
 * ones there lack the apiBase a non-built-in provider needs. Without them the
 * save succeeds and every run fails at its first model call, after retries.
 * Never blocks the save — the credential may be added next. A pinned agent is
 * covered by the pin check; an inheriting one names no provider of its own.
 *
 * Reachable is what the worker's cascade could reach: GLOBAL, plus the team's
 * own and its organization's for a TEAM agent, plus the org's own for an
 * ORGANIZATION agent. CHANNEL and WORKFLOW_TEMPLATE agents run for whichever
 * team owns the run, so any credential for the provider counts.
 */
export async function agentCredentialWarnings(
  prisma: PrismaClient,
  agent: {
    credentialId: string | null;
    modelSpec: string | null;
    orgId: string | null;
    scope: string;
    teamId: string | null;
  }
): Promise<string[]> {
  if (!agent.modelSpec || agent.credentialId) {
    return [];
  }
  let provider: string;
  try {
    provider = parseProviderModelSpec(agent.modelSpec).provider;
  } catch {
    return [];
  }
  const reachable: Array<Record<string, unknown>> = [{ scope: 'GLOBAL' }];
  if (agent.scope === 'TEAM' && agent.teamId) {
    reachable.push({ scope: 'TEAM', teamId: agent.teamId });
    const team = await prisma.team.findUnique({
      select: { orgId: true },
      where: { id: agent.teamId },
    });
    if (team?.orgId) {
      reachable.push({ orgId: team.orgId, scope: 'ORGANIZATION' });
    }
  } else if (agent.scope === 'ORGANIZATION' && agent.orgId) {
    reachable.push({ orgId: agent.orgId, scope: 'ORGANIZATION' });
  }
  const anyScope = agent.scope === 'CHANNEL' || agent.scope === 'WORKFLOW_TEMPLATE';
  const creds = await runUnscoped(
    'checks which credentials an agent version could be run with, across the scopes it may reach',
    ['ProviderCredential'],
    () =>
      prisma.providerCredential.findMany({
        select: { apiBase: true },
        where: { provider, ...(anyScope ? {} : { OR: reachable }) },
      })
  );
  if (creds.length === 0) {
    return [
      agent.scope === 'GLOBAL'
        ? `No GLOBAL credential exists for provider '${provider}', so '${agent.modelSpec}' runs only for teams or organizations with their own. Add one at /studio/models.`
        : `No credential for provider '${provider}' is reachable from this agent's scope, so runs of '${agent.modelSpec}' will fail until one is added at /studio/models.`,
    ];
  }
  if (!BUILTIN_PROVIDERS.includes(provider) && creds.every((c) => !c.apiBase)) {
    return [
      `Provider '${provider}' is not built in, so its credential needs an apiBase (the OpenAI-compatible endpoint), and none reachable here has one.`,
    ];
  }
  return [];
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
): Promise<{
  agent: AgentRow;
  catalogWarnings: string[];
  credentialWarnings: string[];
  scanWarnings: string[];
}> {
  if ((await maxVersion(prisma, key)) > 0) {
    throw new AgentLineageExistsError(key.key, key.scope);
  }
  const scanWarnings = base.systemPrompt ? await scanSkillAdvisory(null, base.systemPrompt) : [];
  // Create the row and its skill refs atomically so a failure mid-way cannot
  // leave a partial agent behind.
  const agent = await prisma.$transaction(async (tx) => {
    const agentBase = await tx.agent.create({
      data: {
        channelId: scopeWhere(key).channelId,
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
        orgId: scopeWhere(key).orgId,
        origin: null,
        runtime: base.runtime ?? null,
        scope: key.scope,
        systemPrompt: base.systemPrompt ?? null,
        teamId: scopeWhere(key).teamId,
        toolKeys: base.toolKeys ?? undefined,
        version: 1,
        workflowTemplateId: scopeWhere(key).workflowTemplateId,
      },
    });
    if ((base.skillRefs ?? []).length > 0) {
      await tx.agentSkillRef.createMany({
        data: (base.skillRefs ?? []).map((ref) => ({
          agentId: agentBase.id,
          skillId: ref.skillId,
          sortOrder: ref.sortOrder,
        })),
      });
    }
    return tx.agent.findUniqueOrThrow({
      include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
      where: { id: agentBase.id },
    });
  });
  return {
    agent,
    catalogWarnings: await agentCatalogWarnings(prisma, agent),
    credentialWarnings: await agentCredentialWarnings(prisma, agent),
    scanWarnings,
  };
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
): Promise<{
  agent: AgentRow;
  catalogWarnings: string[];
  credentialWarnings: string[];
  scanWarnings: string[];
}> {
  const key: AgentScopeKey = {
    channelId: current.channelId,
    key: current.key,
    orgId: current.orgId,
    scope: current.scope as AgentScope,
    teamId: current.teamId,
    workflowTemplateId: current.workflowTemplateId,
  };
  const nextVersion = (await maxVersion(prisma, key)) + 1;
  const promptChanged = base.systemPrompt !== undefined;
  const scanWarnings =
    promptChanged && base.systemPrompt ? await scanSkillAdvisory(null, base.systemPrompt) : [];

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

  const agent = await prisma.$transaction(async (tx) => {
    const agentBase = await tx.agent.create({
      data: {
        channelId: current.channelId,
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
        orgId: current.orgId,
        origin: current.origin,
        runtime: pick(base.runtime, current.runtime),
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
    if (refsToCreate.length > 0) {
      await tx.agentSkillRef.createMany({
        data: refsToCreate.map((ref) => ({
          agentId: agentBase.id,
          skillId: ref.skillId,
          sortOrder: ref.sortOrder,
        })),
      });
    }
    return tx.agent.findUniqueOrThrow({
      include: { skillRefs: { include: { skill: { select: { id: true, name: true } } } } },
      where: { id: agentBase.id },
    });
  });
  return {
    agent,
    catalogWarnings: await agentCatalogWarnings(prisma, agent),
    credentialWarnings: await agentCredentialWarnings(prisma, agent),
    scanWarnings,
  };
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
