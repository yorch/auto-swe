import { prisma } from '@auto-swe/shared/db';
import { parseProviderModelSpec } from '../providerUtils.js';
import { loadAgentSkills, loadAgentToolConfig, type ResolvedSkill } from './agentSkills.js';
import { configCacheTtlMs, withCache } from './cache.js';
import { resolveModelConfig, resolveProviderCredential } from './resolver.js';
import type { AgentRole, AnySkillRole, ResolveCtx, ResolvedModelConfig } from './types.js';

/**
 * The effective configuration of an Agent, resolved through the P1 Agent
 * overlay. Shape matches the raw pieces `resolveAgentSpec` composes: a resolved
 * model (spec + credential + base system prompt), ordered skills, and the
 * enabled tool keys (`null` = no override → all candidate tools).
 *
 * `version`/`isVerified`/`origin` describe the resolved Agent row (defaults when
 * no Agent row exists yet — the pure-legacy path).
 */
export interface ResolvedAgent {
  key: string;
  version: number;
  isVerified: boolean;
  origin: string | null;
  model: ResolvedModelConfig;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
}

/** Coerce the nullable JSON `toolKeys` column into `string[] | null`. */
function parseToolKeys(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

type AgentRow = NonNullable<Awaited<ReturnType<typeof fetchActiveAgent>>>;

/**
 * Most-specific active Agent row for `key`: WORKFLOW_TEMPLATE → TEAM → GLOBAL,
 * highest `version` at the first scope that has a row. Returns null when no
 * Agent row exists for the key (pure-legacy resolution).
 */
async function fetchActiveAgent(key: string, ctx?: ResolveCtx) {
  const include = {
    skillRefs: { include: { skill: true }, orderBy: { sortOrder: 'asc' as const } },
  };

  if (ctx?.workflowTemplateId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy: { version: 'desc' },
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

  if (ctx?.teamId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy: { version: 'desc' },
      where: { isActive: true, key, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      return row;
    }
  }

  return prisma.agent.findFirst({
    include,
    orderBy: { version: 'desc' },
    where: { isActive: true, key, scope: 'GLOBAL' },
  });
}

/** Build a ResolvedModelConfig from an Agent row that overrides `modelSpec`. */
async function modelFromAgentOverride(
  agent: AgentRow,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  const spec = agent.modelSpec as string;
  const { provider } = parseProviderModelSpec(spec);
  // Pinned credential on the Agent row, else the provider's TEAM/GLOBAL cascade.
  if (agent.credentialId) {
    const cred = await prisma.providerCredential.findUnique({ where: { id: agent.credentialId } });
    if (cred) {
      // Reuse the resolver's decrypt path via resolveProviderCredential when the
      // pinned row matches the provider; otherwise fall back to provider cascade.
      const resolved = await resolveProviderCredential(provider, ctx);
      return {
        apiBase: resolved.apiBase,
        apiKey: resolved.apiKey,
        scope: agent.scope,
        spec,
        systemPrompt: agent.systemPrompt ?? undefined,
      };
    }
  }
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
 * Resolve an Agent by key into its effective configuration.
 *
 * P1 overlay model: the most-specific active Agent row wins; each of its null
 * override fields falls through to the legacy per-scope cascade
 * (`resolveModelConfig` / `loadAgentSkills` / `loadAgentToolConfig`). A seeded
 * SWE Agent with all overrides null therefore resolves byte-identically to P0.
 *
 * (Per-field cross-scope merge of multiple Agent rows — e.g. a TEAM Agent that
 * overrides only the model while inheriting the GLOBAL Agent's prompt — is a
 * WS4 refinement; WS1 resolves a single most-specific Agent row.)
 */
export async function resolveAgent(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  const cacheKey = `agent:${key}:${ctx?.workflowTemplateId ?? ''}:${ctx?.teamId ?? ''}`;
  return withCache(cacheKey, configCacheTtlMs(), () => resolveAgentUncached(key, ctx));
}

async function resolveAgentUncached(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  const agent = await fetchActiveAgent(key, ctx);

  // Model + base prompt: Agent override, inherited parent model, or legacy
  // ModelRoleConfig cascade for this key.
  let model: ResolvedModelConfig;
  if (agent?.modelSpec) {
    model = await modelFromAgentOverride(agent, ctx);
  } else {
    // Sub-reviewer/decomposer personas inherit a parent role's model via
    // `inheritsModelFrom` (e.g. securityReviewer → reviewer); otherwise resolve
    // this key's own ModelRoleConfig. `key` is free-form (P0); the legacy
    // resolvers are typed to the SWE union.
    const modelKey = (agent?.inheritsModelFrom ?? key) as AgentRole;
    const legacy = await resolveModelConfig(modelKey, ctx);
    model = agent?.systemPrompt ? { ...legacy, systemPrompt: agent.systemPrompt } : legacy;
  }

  // Skills: Agent skillRefs (if any) or legacy AgentSkillAssignment cascade.
  let skills: ResolvedSkill[];
  if (agent && agent.skillRefs.length > 0) {
    skills = agent.skillRefs.map((ref) => ({
      description: ref.skill.description ?? '',
      id: ref.skill.id,
      isVerified: ref.skill.isVerified,
      name: ref.skill.name,
      promptText: ref.skill.promptText,
      sortOrder: ref.sortOrder,
    }));
  } else {
    skills = await loadAgentSkills(key as AnySkillRole, ctx);
  }

  // Tools: Agent toolKeys override or legacy AgentToolConfig cascade.
  const agentToolKeys = parseToolKeys(agent?.toolKeys);
  const toolKeys = agentToolKeys ?? (await loadAgentToolConfig(key as AnySkillRole, ctx));

  return {
    isVerified: agent?.isVerified ?? true,
    key,
    model,
    origin: agent?.origin ?? null,
    skills,
    toolKeys,
    version: agent?.version ?? 1,
  };
}
